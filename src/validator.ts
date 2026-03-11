import { type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  Task,
  ProjectType,
  IntegrationGateResult,
  Provider,
  GateStatus,
  GatePhaseEntry,
} from "./types.js";
import { buildGateAgentBrief, type GateAgentBriefOpts } from "./brief.js";
import { renderGateStatus, isTTY, HIDE_CURSOR, CLEAR_SCREEN, SHOW_CURSOR } from "./dashboard.js";

// ─── Cleanup Set ─────────────────────────────────────────────────────────────

/** Module-level set of processes to kill on SIGINT. */
export const gateCleanupProcesses: Set<ChildProcess> = new Set();

// ─── Project Type Detection ──────────────────────────────────────────────────

export function detectProjectType(repoRoot: string): ProjectType {
  // Most specific first
  const nextConfigs = ["next.config.js", "next.config.mjs", "next.config.ts"];
  for (const cfg of nextConfigs) {
    if (fs.existsSync(path.join(repoRoot, cfg))) return "nextjs";
  }

  const viteConfigs = ["vite.config.js", "vite.config.mjs", "vite.config.ts"];
  for (const cfg of viteConfigs) {
    if (fs.existsSync(path.join(repoRoot, cfg))) return "vite";
  }

  // Check package.json for framework deps and fields
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return "generic";

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // API server detection
    const serverFrameworks = ["express", "fastify", "hono", "koa"];
    for (const fw of serverFrameworks) {
      if (allDeps[fw]) return "express";
    }

    // CLI tool
    if (pkg.bin) return "cli";

    // Library (has main/exports but no framework)
    if (pkg.main || pkg.exports) return "library";
  } catch {
    // Malformed package.json
  }

  return "generic";
}

// ─── Port Hashing ────────────────────────────────────────────────────────────

/** DJB2 hash → deterministic port in [10000, 60000). */
export function hashPort(branchName: string): number {
  let hash = 5381;
  for (let i = 0; i < branchName.length; i++) {
    hash = ((hash << 5) + hash + branchName.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 50000) + 10000;
}

// ─── Start Command ───────────────────────────────────────────────────────────

export function getStartCommand(
  projectType: ProjectType,
  port: number,
): { cmd: string; args: string[] } {
  switch (projectType) {
    case "nextjs":
      return { cmd: "npx", args: ["next", "start", "--hostname", "127.0.0.1", "-p", String(port)] };
    case "vite":
      return { cmd: "npx", args: ["vite", "preview", "--host", "127.0.0.1", "--port", String(port)] };
    case "express":
      return { cmd: "npm", args: ["start"] };
    default:
      return { cmd: "npm", args: ["start"] };
  }
}

// ─── Playwright MCP Detection ────────────────────────────────────────────────

/**
 * Checks if Playwright MCP is available for a target project.
 * Playwright is a built-in Claude Code plugin (available by default).
 * It can be:
 * - Disabled per-project via `disabledMcpServers` in `~/.claude.json`
 * - Explicitly configured as an mcpServer at user or project level
 */
export function isPlaywrightMCPAvailable(repoRoot?: string): boolean {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

  // Check for explicit mcpServers.playwright in user-level config
  for (const p of [claudeJsonPath, settingsPath]) {
    if (!fs.existsSync(p)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (config.mcpServers?.playwright) return true;
    } catch {
      // Skip malformed config
    }
  }

  // Playwright is a built-in plugin — available unless explicitly disabled
  // Check project-level config in ~/.claude.json (most specific path wins)
  if (repoRoot && fs.existsSync(claudeJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
      if (config.projects) {
        const normalizedRoot = path.resolve(repoRoot);
        // Find the most specific matching project path (longest match)
        let bestMatch = "";
        for (const projectPath of Object.keys(config.projects)) {
          if (normalizedRoot.startsWith(projectPath) && projectPath.length > bestMatch.length) {
            bestMatch = projectPath;
          }
        }
        if (bestMatch) {
          const pc = config.projects[bestMatch] as { disabledMcpServers?: string[]; mcpServers?: Record<string, unknown> };
          if (pc.mcpServers?.playwright) return true;
          if (pc.disabledMcpServers?.some((s: string) => s.includes("playwright"))) return false;
        }
      }
    } catch {
      // Skip malformed config
    }
  }

  // Built-in plugin, not disabled — available
  return true;
}

// ─── Gate Result Parsing ─────────────────────────────────────────────────────

/**
 * Parses gate agent output for [GATE:PASS] or [GATE:FAIL] markers.
 * Scans from the end of output to find the last marker (agent may output
 * intermediate markers during retries — last one wins).
 * Works on raw JSONL bytes: markers appear inside JSON text fields,
 * so simple includes() matching works.
 */
export function parseGateResult(output: string): IntegrationGateResult {
  const lines = output.split("\n");

  // Scan from end to find the last gate marker
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    if (line.includes("[GATE:PASS]")) {
      return { finalSuccess: true };
    }

    const failIdx = line.indexOf("[GATE:FAIL]");
    if (failIdx !== -1) {
      // Truncate at first " to strip JSON suffix (marker is embedded in JSONL text fields)
      const afterMarker = line.slice(failIdx + "[GATE:FAIL]".length).replace(/"[\s\S]*$/, "").trim();
      return {
        finalSuccess: false,
        failReason: afterMarker || undefined,
      };
    }
  }

  return { finalSuccess: false, failReason: "no result marker" };
}

// ─── Gate Stream Processor ───────────────────────────────────────────────────

/**
 * Processes a single JSONL line from the gate agent and updates status.
 * Detects phase markers, tool usage, message turns, and fix attempts.
 */
export function processGateLine(line: string, status: GateStatus, lastMessageId: { value: string }): void {
  // Phase start: [GATE:PHASE] <name>
  const phaseMatch = line.match(/\[GATE:PHASE\]\s*([^"\\]+)/);
  if (phaseMatch) {
    const name = phaseMatch[1].trim();
    for (const p of status.phases) {
      if (p.name === name) {
        p.status = "running";
      } else if (p.status === "running") {
        // Previous running phase implicitly passed
        p.status = "passed";
      }
    }
  }

  // Phase passed: [GATE:OK] <name>
  const okMatch = line.match(/\[GATE:OK\]\s*([^"\\]+)/);
  if (okMatch) {
    const name = okMatch[1].trim();
    const phase = status.phases.find(p => p.name === name);
    if (phase) phase.status = "passed";
  }

  // Phase failed: [GATE:WARN] <name>
  const warnMatch = line.match(/\[GATE:WARN\]\s*([^"\\]+)/);
  if (warnMatch) {
    const name = warnMatch[1].trim();
    const phase = status.phases.find(p => p.name === name);
    if (phase) phase.status = "failed";
  }

  // Phase fixed: [GATE:FIXED] <name>
  const fixedMatch = line.match(/\[GATE:FIXED\]\s*([^"\\]+)/);
  if (fixedMatch) {
    const name = fixedMatch[1].trim();
    const phase = status.phases.find(p => p.name === name);
    if (phase) phase.status = "fixed";
  }

  // Fix attempt: [GATE:FIXING] <N>
  const fixingMatch = line.match(/\[GATE:FIXING\]\s*(\d+)/);
  if (fixingMatch) {
    status.fixAttempts = parseInt(fixingMatch[1], 10);
  }

  // Tool usage
  const toolMatch = line.match(/"tool_name":\s*"([^"]+)"/);
  if (toolMatch) {
    status.currentTool = toolMatch[1];
  }

  // Turn counting: detect new assistant messages by unique ID
  const msgIdMatch = line.match(/"id":\s*"(msg_[^"]+)"/);
  if (msgIdMatch && msgIdMatch[1] !== lastMessageId.value) {
    lastMessageId.value = msgIdMatch[1];
    status.turnCount++;
  }
}

// ─── Integration Gate Orchestrator ───────────────────────────────────────────

/** Wall-clock safety timeout: 30 minutes. Defense-in-depth. */
const GATE_TIMEOUT_MS = 30 * 60 * 1000;

export interface IntegrationGateOpts {
  branch: string;
  provider: Provider;
  model: string;
  skipSmoke: boolean;
  skipQA: boolean;
  noFixer: boolean;
  fixerPatience: number;
  verbose: boolean;
  projectDir: string;
  designPath?: string;
  manifestPath?: string;
}

export async function runIntegrationGate(
  repoRoot: string,
  tasks: Task[],
  opts: IntegrationGateOpts,
): Promise<IntegrationGateResult> {
  // Build gate agent brief
  const projectType = detectProjectType(repoRoot);
  const port = hashPort(opts.branch);
  const startCommand = getStartCommand(projectType, port);
  const playwrightAvailable = isPlaywrightMCPAvailable(repoRoot);

  const briefOpts: GateAgentBriefOpts = {
    projectType,
    port,
    startCommand,
    skipSmoke: opts.skipSmoke,
    skipQA: opts.skipQA,
    noFixer: opts.noFixer,
    fixerPatience: opts.fixerPatience,
    playwrightAvailable,
    designPath: opts.designPath,
    manifestPath: opts.manifestPath,
  };

  const brief = buildGateAgentBrief(tasks, briefOpts);

  // Ensure logs directory exists
  const logsDir = path.join(opts.projectDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "gate-agent.jsonl");
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  // Initialize gate status for dashboard
  const phases: GatePhaseEntry[] = [
    { name: "Build Validation", status: "pending" },
    { name: "Smoke Test", status: opts.skipSmoke ? "skipped" : "pending" },
    { name: "QA", status: (opts.skipQA || !playwrightAvailable) ? "skipped" : "pending" },
  ];

  const status: GateStatus = {
    startedAt: Date.now(),
    phases,
    currentTool: "",
    turnCount: 0,
    bytesReceived: 0,
    fixAttempts: 0,
    maxFixAttempts: opts.noFixer ? 0 : opts.fixerPatience,
    taskCount: tasks.length,
    logPath: logFile,
  };

  // Take over screen for gate dashboard (HIDE_CURSOR for defense-in-depth)
  if (isTTY()) process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN);
  renderGateStatus(status);
  const renderInterval = setInterval(() => renderGateStatus(status), 1000);

  try {
    const child = opts.provider.spawn({
      prompt: brief,
      model: opts.model,
      cwd: repoRoot,
      verbose: opts.verbose,
    });
    gateCleanupProcesses.add(child);

    // Wall-clock safety timeout
    const safetyTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, GATE_TIMEOUT_MS);

    // Stream output, keep tail for result parsing
    const OUTPUT_TAIL_BYTES = 32_768;
    let output = "";
    let lineBuffer = "";
    const lastMessageId = { value: "" };

    const exitCode = await new Promise<number | null>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        status.bytesReceived += chunk.length;
        output += text;
        if (output.length > OUTPUT_TAIL_BYTES * 2) {
          output = output.slice(-OUTPUT_TAIL_BYTES);
        }
        logStream.write(chunk);

        // Process each complete line for status updates
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          processGateLine(line, status, lastMessageId);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        logStream.write(`[stderr] ${chunk.toString()}\n`);
      });
      child.on("close", (code) => {
        // Flush remaining line buffer
        if (lineBuffer) {
          processGateLine(lineBuffer, status, lastMessageId);
        }
        logStream.end();
        gateCleanupProcesses.delete(child);
        clearTimeout(safetyTimer);
        resolve(code);
      });
    });

    // Parse result from agent output
    const result = parseGateResult(output);

    // If agent crashed without a marker, include exit code in reason
    if (!result.finalSuccess && result.failReason === "no result marker" && exitCode !== 0) {
      result.failReason = `agent exited with code ${exitCode}`;
    }

    return result;
  } finally {
    clearInterval(renderInterval);
    if (isTTY()) process.stdout.write(CLEAR_SCREEN + SHOW_CURSOR);
  }
}
