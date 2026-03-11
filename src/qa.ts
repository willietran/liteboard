import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Task, Provider, QAReport } from "./types.js";
import { gateCleanupProcesses } from "./validator.js";
import { readCommand } from "./brief.js";

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
          if (pc.disabledMcpServers?.some(s => s.includes("playwright"))) return false;
        }
      }
    } catch {
      // Skip malformed config
    }
  }

  // Built-in plugin, not disabled — available
  return true;
}

// ─── QA Brief Building ──────────────────────────────────────────────────────

export function buildQABrief(
  tasks: Task[],
  projectDir: string,
  appUrl: string,
): string {
  const parts: string[] = [];

  // QA agent instructions
  parts.push(readCommand("qa-agent.md"));
  parts.push("");

  // App URL
  parts.push("---");
  parts.push(`**App URL:** ${appUrl}`);
  parts.push("");

  // Feature list from tasks
  parts.push("**Features to test:**");
  for (const task of tasks) {
    parts.push(`- **Task ${task.id}: ${task.title}**`);
    if (task.requirements.length > 0) {
      for (const req of task.requirements) {
        parts.push(`  - ${req}`);
      }
    }
  }
  parts.push("");

  return parts.join("\n");
}

// ─── QA Report Parsing ──────────────────────────────────────────────────────

export function parseQAReport(output: string): QAReport {
  const features: Array<{ name: string; passed: boolean; error?: string }> = [];

  const lines = output.split("\n");
  for (const line of lines) {
    const passMatch = line.match(/\[QA:PASS\]\s+(.+)/);
    if (passMatch) {
      features.push({ name: passMatch[1].trim(), passed: true });
      continue;
    }

    const failMatch = line.match(/\[QA:FAIL\]\s+(.+?):\s+(.+)/);
    if (failMatch) {
      features.push({
        name: failMatch[1].trim(),
        passed: false,
        error: failMatch[2].trim(),
      });
      continue;
    }

    // QA:FAIL without error description
    const failNoDescMatch = line.match(/\[QA:FAIL\]\s+(.+)/);
    if (failNoDescMatch) {
      features.push({
        name: failNoDescMatch[1].trim(),
        passed: false,
      });
    }
  }

  return {
    features,
    totalPassed: features.filter((f) => f.passed).length,
    totalFailed: features.filter((f) => !f.passed).length,
  };
}

// ─── QA Phase Runner ─────────────────────────────────────────────────────────

export interface QAPhaseOpts {
  verbose: boolean;
  projectDir: string;
}

export async function runQAPhase(
  repoRoot: string,
  tasks: Task[],
  provider: Provider,
  model: string,
  appUrl: string,
  opts: QAPhaseOpts,
): Promise<QAReport> {
  const brief = buildQABrief(tasks, opts.projectDir, appUrl);

  // Ensure logs directory exists
  const logsDir = path.join(opts.projectDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "qa-agent.jsonl");
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  const child = provider.spawn({
    prompt: brief,
    model,
    cwd: repoRoot,
    verbose: opts.verbose,
  });
  gateCleanupProcesses.add(child);

  let output = "";

  const exitCode = await new Promise<number | null>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      logStream.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      logStream.write(`[stderr] ${chunk.toString()}\n`);
    });
    child.on("close", (code) => {
      logStream.end();
      gateCleanupProcesses.delete(child);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    console.log(`  \x1b[33mQA agent exited with code ${exitCode}\x1b[0m`);
  }

  return parseQAReport(output);
}
