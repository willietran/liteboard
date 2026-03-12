#!/usr/bin/env npx tsx
/**
 * Autoboard Mini-MVP — Single-file orchestrator script.
 *
 * Usage:
 *   npx tsx scripts/run.ts <manifest.md> --design=<design.md> [options]
 *
 * Options:
 *   --design=<path>       Path to design doc (required)
 *   --concurrency=<N>     Max parallel agents, 1-5 (default: 1)
 *   --model=<model>       Claude model (default: claude-opus-4-6)
 *   --branch=<name>       Feature branch name (default: autoboard/build)
 *   --tasks=<1,2,3>       Comma-separated task IDs to run
 *   --dry-run             Parse and show graph only
 *   --verbose             Log all git commands to stderr
 *
 * Zero npm dependencies. Uses only node:child_process, node:fs, node:path.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── 1. Types ───────────────────────────────────────────────────────────────

interface MiniTask {
  id: number;
  title: string;
  creates: string[];
  modifies: string[];
  dependsOn: number[];
  requirements: string[];
  tddPhase: string;
  commitMessage: string;
  complexity: number;
  status: "blocked" | "queued" | "running" | "done" | "failed";
  turnCount: number;
  lastLine: string;
  bytesReceived: number;
  startedAt?: number;
  completedAt?: string;
  process?: ChildProcess;
  worktreePath?: string;
  logPath?: string;
}

interface CLIArgs {
  manifestPath: string;
  designPath: string;
  concurrency: number;
  models: { implementation: { provider: string; model: string } };
  branch: string;
  taskFilter: number[] | null;
  dryRun: boolean;
  verbose: boolean;
}

// ─── 2. CLI Argument Parsing ────────────────────────────────────────────────

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: npx tsx scripts/run.ts <manifest.md> --design=<design.md> [options]

Options:
  --design=<path>       Path to design doc (required)
  --concurrency=<N>     Max parallel agents, 1-5 (default: 1)
  --model=<model>       Claude model (default: claude-opus-4-6)
  --branch=<name>       Feature branch name (default: autoboard/build)
  --tasks=<1,2,3>       Comma-separated task IDs to run
  --dry-run             Parse and show graph only
  --verbose             Log all git commands to stderr`);
    process.exit(0);
  }

  let manifestPath = "";
  let designPath = "";
  let concurrency = 1;
  let implModel = "claude-opus-4-6";
  let branch = "autoboard/build";
  let taskFilter: number[] | null = null;
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg.startsWith("--design=")) {
      designPath = arg.slice("--design=".length);
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, Math.min(5, parseInt(arg.slice("--concurrency=".length), 10)));
    } else if (arg.startsWith("--model=")) {
      implModel = arg.slice("--model=".length);
    } else if (arg.startsWith("--branch=")) {
      branch = arg.slice("--branch=".length);
    } else if (arg.startsWith("--tasks=")) {
      taskFilter = arg.slice("--tasks=".length).split(",").map(s => parseInt(s.trim(), 10));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
    }
  }

  if (!manifestPath) die("Missing required argument: <manifest.md>");
  if (!designPath) die("Missing required argument: --design=<path>");

  return {
    manifestPath: path.resolve(manifestPath),
    designPath: path.resolve(designPath),
    concurrency,
    models: { implementation: { provider: "claude", model: implModel } },
    branch,
    taskFilter,
    dryRun,
    verbose,
  };
}

// ─── 3. Startup Checks ─────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

function checkPrereqs(args: CLIArgs): void {
  // Check git repo
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "pipe" });
  } catch {
    die("Not a git repository. Run this from a git repo root.");
  }

  // Check claude CLI
  try {
    execFileSync("which", ["claude"], { stdio: "pipe" });
  } catch {
    die("`claude` CLI not found on PATH. Install Claude Code first.");
  }

  // Check files exist
  if (!fs.existsSync(args.manifestPath)) {
    die(`Manifest not found: ${args.manifestPath}`);
  }
  if (!fs.existsSync(args.designPath)) {
    die(`Design doc not found: ${args.designPath}`);
  }

  // Warn about other claude processes that may cause throttling
  warnConcurrentClaude();
}

function warnConcurrentClaude(): void {
  try {
    const psOutput = execFileSync("pgrep", ["-afl", "claude"], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    // Count claude processes that look like active sessions (not this script's children)
    const lines = psOutput.trim().split("\n").filter(line =>
      line.includes("claude") &&
      !line.includes("pgrep") &&
      !line.includes("scripts/run.ts")
    );
    if (lines.length > 0) {
      log(`\x1b[33mWarning: Found ${lines.length} other claude process(es) running.\x1b[0m`);
      log(`\x1b[33mConcurrent Claude sessions may cause spawned agents to hang due to API throttling.\x1b[0m`);
      log(`\x1b[33mConsider closing other Claude sessions before running Autoboard.\x1b[0m`);
      log("");
    }
  } catch {
    // pgrep returns non-zero if no matches — that's fine
  }
}

// ─── 4. Manifest Parser ────────────────────────────────────────────────────

function parseManifest(manifestPath: string): MiniTask[] {
  const content = fs.readFileSync(manifestPath, "utf-8");
  const tasks: MiniTask[] = [];

  // Split into task sections
  const taskRegex = /### Task (\d+):\s*(.+)/g;
  const matches: { id: number; title: string; startIndex: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = taskRegex.exec(content)) !== null) {
    matches.push({
      id: parseInt(match[1], 10),
      title: match[2].trim(),
      startIndex: match.index,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const { id, title, startIndex } = matches[i];
    const endIndex = i + 1 < matches.length ? matches[i + 1].startIndex : content.length;
    const section = content.slice(startIndex, endIndex);

    const creates = parseFileList(section, "Creates");
    const modifies = parseFileList(section, "Modifies");
    const dependsOn = parseDeps(section);
    const requirements = parseRequirements(section);
    const tddPhase = parseField(section, "TDD Phase") || "Exempt";
    const commitMessage = parseField(section, "Commit") || `task ${id}: ${title}`;
    const complexityStr = parseField(section, "Complexity Score") || "3";
    const complexity = parseInt(complexityStr, 10) || 3;

    tasks.push({
      id,
      title,
      creates,
      modifies,
      dependsOn,
      requirements,
      tddPhase,
      commitMessage,
      complexity,
      status: "blocked",
      turnCount: 0,
      lastLine: "",
      bytesReceived: 0,
    });
  }

  // Set initial statuses
  for (const task of tasks) {
    if (task.dependsOn.length === 0) {
      task.status = "queued";
    }
  }

  return tasks;
}

function parseFileList(section: string, field: string): string[] {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
  const match = section.match(regex);
  if (!match) return [];
  const raw = match[1].trim();
  if (raw === "(none)" || raw.toLowerCase() === "none") return [];
  return raw.split(",").map(s => s.trim().replace(/`/g, "")).filter(Boolean);
}

function parseDeps(section: string): number[] {
  const match = section.match(/\*\*Depends on:\*\*\s*(.+)/i);
  if (!match) return [];
  const raw = match[1].trim();
  if (raw.toLowerCase() === "none") return [];
  const deps: number[] = [];
  const depMatches = raw.matchAll(/Task\s+(\d+)/gi);
  for (const m of depMatches) {
    deps.push(parseInt(m[1], 10));
  }
  return deps;
}

function parseRequirements(section: string): string[] {
  const reqStart = section.match(/\*\*Requirements:\*\*/i);
  if (!reqStart) return [];

  const afterReqs = section.slice(reqStart.index! + reqStart[0].length);
  const lines = afterReqs.split("\n");
  const requirements: string[] = [];
  let currentReq = "";

  for (const line of lines) {
    // Stop at next field marker
    if (/^- \*\*\w+/.test(line.trim())) break;

    const trimmed = line.trimEnd();
    // Top-level bullet
    if (/^\s{0,2}- /.test(trimmed)) {
      if (currentReq) requirements.push(currentReq.trim());
      currentReq = trimmed.replace(/^\s*- /, "");
    }
    // Sub-bullet or continuation
    else if (/^\s{3,}- /.test(trimmed) || /^\s{4,}\S/.test(trimmed)) {
      currentReq += "\n  " + trimmed.trim();
    }
  }
  if (currentReq) requirements.push(currentReq.trim());

  return requirements;
}

function parseField(section: string, field: string): string | null {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
  const match = section.match(regex);
  if (!match) return null;
  return match[1].trim().replace(/^`|`$/g, "");
}

// ─── 5. Dependency Resolver + File Conflict Detection ───────────────────────

interface Layer {
  layerIndex: number;
  taskIds: number[];
}

function topologicalSort(tasks: MiniTask[]): Layer[] {
  const taskMap = new Map<number, MiniTask>();
  for (const t of tasks) taskMap.set(t.id, t);

  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();

  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adj.set(t.id, []);
  }

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (taskMap.has(dep)) {
        adj.get(dep)!.push(t.id);
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
  }

  const layers: Layer[] = [];
  let queue = tasks.filter(t => inDegree.get(t.id) === 0).map(t => t.id);
  let processed = 0;

  while (queue.length > 0) {
    layers.push({ layerIndex: layers.length, taskIds: [...queue] });
    const next: number[] = [];
    for (const id of queue) {
      processed++;
      for (const child of adj.get(id) || []) {
        inDegree.set(child, inDegree.get(child)! - 1);
        if (inDegree.get(child) === 0) next.push(child);
      }
    }
    queue = next;
  }

  if (processed < tasks.length) {
    die("Circular dependency detected in task manifest.");
  }

  return layers;
}

function hasFileConflict(a: MiniTask, b: MiniTask): boolean {
  const filesA = new Set([...a.creates, ...a.modifies]);
  const filesB = [...b.creates, ...b.modifies];
  return filesB.some(f => filesA.has(f));
}

// ─── 6. Git Worktree Manager ────────────────────────────────────────────────

const projectRoot = process.cwd();
let mergeLock: Promise<void> = Promise.resolve();

function git(gitArgs: string[], opts?: { cwd?: string; verbose?: boolean }): string {
  if (opts?.verbose) {
    console.error(`\x1b[90m$ git ${gitArgs.join(" ")}${opts?.cwd ? ` (cwd: ${opts.cwd})` : ""}\x1b[0m`);
  }
  try {
    return execFileSync("git", gitArgs, {
      cwd: opts?.cwd || projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() || "";
    throw new Error(`git ${gitArgs[0]} failed: ${stderr.trim() || e.message}`);
  }
}

function setupFeatureBranch(branchName: string, verbose: boolean): void {
  try {
    git(["rev-parse", "--verify", branchName], { verbose });
    // Branch exists — check it out
    git(["checkout", branchName], { verbose });
    log(`Using existing branch: ${branchName}`);
  } catch {
    // Create new branch from HEAD
    git(["checkout", "-b", branchName], { verbose });
    log(`Created branch: ${branchName}`);
  }
}

function getWorktreePath(taskId: number): string {
  return `/tmp/autoboard-mini-t${taskId}`;
}

function createWorktree(taskId: number, featureBranch: string, verbose: boolean): string {
  const wp = getWorktreePath(taskId);
  const taskBranch = `${featureBranch}-t${taskId}`;

  // Clean up stale worktree if it exists
  if (fs.existsSync(wp)) {
    try { git(["worktree", "remove", "--force", wp], { verbose }); } catch { /* ignore */ }
    // If dir still exists (orphaned, not tracked by git), remove it directly
    if (fs.existsSync(wp)) {
      fs.rmSync(wp, { recursive: true, force: true });
    }
  }
  try { git(["branch", "-D", taskBranch], { verbose }); } catch { /* ignore */ }

  git(["worktree", "add", "-b", taskBranch, wp, featureBranch], { verbose });
  return wp;
}

function squashMerge(taskId: number, featureBranch: string, commitMessage: string, verbose: boolean): Promise<void> {
  // Serialize merges via promise chain
  const prev = mergeLock;
  let resolve: () => void;
  mergeLock = new Promise<void>(r => { resolve = r; });

  return prev.then(() => {
    const wp = getWorktreePath(taskId);
    const taskBranch = `${featureBranch}-t${taskId}`;

    try {
      // Squash merge directly — no rebase needed since we're squashing anyway.
      // 3-way merge handles diverged branches better than rebase (which replays commit-by-commit).
      git(["checkout", featureBranch], { verbose });

      // Remove untracked ephemeral files that block merge (e.g. .memory-entry.md from previous tasks)
      try { fs.unlinkSync(path.join(projectRoot, ".memory-entry.md")); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(projectRoot, `.brief-t${taskId}.md`)); } catch { /* ignore */ }

      git(["merge", "--squash", taskBranch], { verbose });

      // Remove ephemeral files from the staged merge result
      try { git(["reset", "HEAD", "--", ".memory-entry.md", `.brief-t${taskId}.md`], { verbose }); } catch { /* ignore */ }
      try { git(["checkout", "--", ".memory-entry.md"], { verbose }); } catch { /* ignore */ }

      git(["commit", "-m", commitMessage], { verbose });
    } catch (e: any) {
      log(`\x1b[33mMerge issue for task ${taskId}, attempting recovery...\x1b[0m`);
      // Abort any in-progress merge
      try { git(["merge", "--abort"], { verbose }); } catch { /* ignore */ }
      try { git(["checkout", featureBranch], { verbose }); } catch { /* ignore */ }
      throw e;
    } finally {
      resolve!();
    }
  });
}

function cleanupWorktree(taskId: number, featureBranch: string, verbose: boolean): void {
  const wp = getWorktreePath(taskId);
  const taskBranch = `${featureBranch}-t${taskId}`;
  try { git(["worktree", "remove", "--force", wp], { verbose }); } catch { /* ignore */ }
  try { git(["branch", "-D", taskBranch], { verbose }); } catch { /* ignore */ }
}

function detectCompletedTasksFromGitLog(featureBranch: string, allTasks: MiniTask[], verbose: boolean): Set<number> {
  const completed = new Set<number>();
  try {
    const logOutput = git(["log", "--oneline", featureBranch], { verbose });
    const lines = logOutput.split("\n");

    for (const line of lines) {
      // Match "[task N]" prefix (legacy format)
      const tagMatch = line.match(/\[task\s+(\d+)\]/i);
      if (tagMatch) {
        completed.add(parseInt(tagMatch[1], 10));
        continue;
      }

      // Fallback: match commit message exactly against known task commitMessages
      for (const task of allTasks) {
        if (line.includes(task.commitMessage)) {
          completed.add(task.id);
          break;
        }
      }
    }
  } catch {
    // Branch might not exist yet — that's fine, no completed tasks
  }
  return completed;
}

function getBuildDir(): string {
  return path.join(process.cwd(), "docs", "build");
}

function writeProgress(tasks: MiniTask[]): void {
  const buildDir = getBuildDir();
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  // Initialize memory.md if it doesn't exist
  const memoryPath = path.join(buildDir, MEMORY_FILENAME);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, "# Build Memory\n\nShared context across tasks. Agents may read this for cross-task awareness.\n", "utf-8");
  }

  const lines = [
    "# Autoboard Build Progress",
    "",
    "| Task | Title | Status | Completed At |",
    "|------|-------|--------|--------------|",
  ];
  for (const t of tasks) {
    const time = t.status === "done" ? (t.completedAt ?? "") : "";
    lines.push(`| T${t.id} | ${t.title} | ${t.status} | ${time} |`);
  }

  // Atomic write: write to temp then rename
  const filePath = path.join(buildDir, "progress.md");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

const MEMORY_FILENAME = "memory.md";

// Lightweight memory append for mini-MVP. See src/orchestrator/memory.ts for canonical implementation.
// NOTE: Safe without explicit lock because callers are serialized via mergeLock in squashMerge().
// If merge serialization changes, this function MUST add its own write lock.
function appendMemoryEntry(taskId: number, title: string, body: string): void {
  const buildDir = getBuildDir();
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  const memPath = path.join(buildDir, MEMORY_FILENAME);
  const existing = fs.existsSync(memPath)
    ? fs.readFileSync(memPath, "utf-8")
    : "# Build Memory\n\nShared context across tasks. Agents may read this for cross-task awareness.\n";
  const safeTitle = title.replace(/[\r\n]/g, " ").trim();
  const header = `## T${taskId} · ${safeTitle} · ${new Date().toISOString()}`;
  const updated = existing.trimEnd() + "\n\n" + header + "\n" + body + "\n";

  // Atomic write: temp then rename
  const tmpPath = memPath + ".tmp";
  fs.writeFileSync(tmpPath, updated, "utf-8");
  fs.renameSync(tmpPath, memPath);
}

function readProgress(): Map<number, string> {
  const filePath = path.join(getBuildDir(), "progress.md");
  const completed = new Map<number, string>();

  if (!fs.existsSync(filePath)) return completed;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    // Match table rows: | T<id> | <title> | done | <timestamp> |
    const match = line.match(/^\|\s*T(\d+)\s*\|.*?\|\s*done\s*\|\s*(\S*)\s*\|/);
    if (match) {
      completed.set(parseInt(match[1], 10), match[2] || "");
    }
  }

  return completed;
}

function cleanupAllWorktrees(tasks: MiniTask[], featureBranch: string, verbose: boolean): void {
  for (const task of tasks) {
    if (task.worktreePath) {
      cleanupWorktree(task.id, featureBranch, verbose);
    }
  }
}

// ─── 7. Agent Spawner ───────────────────────────────────────────────────────

function spawnAgent(
  task: MiniTask,
  brief: string,
  model: string,
  wp: string,
  verbose: boolean,
): ChildProcess {
  // Write brief to a temp file — avoids arg length issues and quoting problems
  const briefPath = path.join(wp, `.brief-t${task.id}.md`);
  fs.writeFileSync(briefPath, brief, "utf-8");

  if (verbose) {
    log(`${C_GRAY}[T${task.id}] Brief written to ${briefPath} (${brief.length} chars)${RESET}`);
    log(`${C_GRAY}[T${task.id}] Spawning claude in ${wp}${RESET}`);
  }

  // Remove CLAUDECODE env var entirely so nested claude sessions are allowed
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;

  const child = spawn("claude", [
    "-p", brief,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
  ], {
    cwd: wp,
    stdio: ["ignore", "pipe", "pipe"],  // stdin ignored — claude -p reads from arg, not stdin
    env: childEnv,
  });

  // Create log file for raw output
  const logDir = path.join(projectRoot, ".autoboard-logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `t${task.id}.jsonl`);
  task.logPath = logFile;
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  let buffer = "";
  let textAccum = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const chunkStr = chunk.toString();
    task.bytesReceived += chunk.length;

    // Write raw output to log file
    logStream.write(chunkStr);

    buffer += chunkStr;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);

        // Turn starts when a new message begins
        if (evt.type === "message_start") {
          task.turnCount++;
          textAccum = "";
        }

        // Accumulate text deltas for last-line display
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
          textAccum += evt.delta.text;
          const stripped = textAccum.replace(/[#*`_~]/g, "").trim();
          const lastNonEmpty = stripped.split("\n").filter(Boolean).pop() || "";
          if (lastNonEmpty) {
            task.lastLine = lastNonEmpty.slice(0, 120);
          }
        }

        // Track tool usage
        if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
          const toolName = evt.content_block.name || "tool";
          task.lastLine = `[using ${toolName}]`;
        }

        // Fallback: if we see ANY event with a type, at least show we're alive
        if (evt.type && task.turnCount === 0 && !task.lastLine) {
          task.lastLine = `[initializing: ${evt.type}]`;
        }

      } catch {
        // Not valid JSON — use raw line as fallback activity indicator
        const trimmed = line.trim().slice(0, 80);
        if (trimmed && !task.lastLine) {
          task.lastLine = trimmed;
        }
      }
    }
  });

  // Capture stderr for diagnostics
  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) {
      logStream.write(`[stderr] ${msg}\n`);
      if (verbose) log(`${C_GRAY}[T${task.id} stderr] ${msg}${RESET}`);
    }
  });

  child.on("close", () => {
    logStream.end();
  });

  return child;
}

// ─── 8. Brief Template ──────────────────────────────────────────────────────

function buildBrief(task: MiniTask, allTasks: MiniTask[], args: CLIArgs): string {
  const parts: string[] = [];

  parts.push(`I'm implementing Autoboard — Task ${task.id}: ${task.title}.`);
  parts.push("");
  parts.push("**Docs:**");
  parts.push(`- Design doc: ${args.designPath}`);
  parts.push(`- Task manifest: ${args.manifestPath}`);
  parts.push("");
  parts.push(`Read the design doc for context on this task.`);
  parts.push(`Read the task manifest for Task ${task.id} requirements.`);
  parts.push("");

  // Inject cross-task memory snapshot if entries exist
  const memoryPath = path.join(getBuildDir(), MEMORY_FILENAME);
  if (fs.existsSync(memoryPath)) {
    const memoryContent = fs.readFileSync(memoryPath, "utf-8").trim();
    // Semantic check: only inject if there are actual task entries
    if (/^## T\d+/m.test(memoryContent)) {
      parts.push("**Build Memory (context from completed tasks):**");
      parts.push("```");
      parts.push(memoryContent);
      parts.push("```");
      parts.push("");
    }
  }

  // Explore hints
  parts.push("**BEFORE STARTING:** Explore the codebase to understand:");
  if (task.modifies.length > 0) {
    for (const f of task.modifies) {
      parts.push(`- Understand the current implementation of \`${f}\` before changing it`);
    }
  }
  if (task.creates.length > 0) {
    const dirs = new Set<string>();
    for (const f of task.creates) {
      const dir = path.dirname(f);
      if (dir !== ".") dirs.add(dir);
    }
    for (const dir of dirs) {
      parts.push(`- Explore the \`${dir}/\` directory for existing patterns`);
    }
  }
  if (task.dependsOn.length > 0) {
    for (const depId of task.dependsOn) {
      const dep = allTasks.find(t => t.id === depId);
      if (dep) {
        const depFiles = [...dep.creates, ...dep.modifies];
        if (depFiles.length > 0) {
          parts.push(`- Review files from Task ${depId} (${dep.title}): ${depFiles.map(f => `\`${f}\``).join(", ")}`);
        }
      }
    }
  }
  parts.push("- Look at existing code patterns before writing anything new");
  parts.push("");

  // Task details
  parts.push("**YOUR TASK:**");
  parts.push("");
  if (task.creates.length > 0) {
    parts.push(`Creates: ${task.creates.map(f => `\`${f}\``).join(", ")}`);
  }
  if (task.modifies.length > 0) {
    parts.push(`Modifies: ${task.modifies.map(f => `\`${f}\``).join(", ")}`);
  }
  parts.push("");

  parts.push("Requirements:");
  for (const req of task.requirements) {
    parts.push(`- ${req}`);
  }
  parts.push("");

  // ── Workflow: the strict sequence every agent must follow ──
  parts.push("---");
  parts.push("");
  parts.push("**MANDATORY WORKFLOW — Follow these 5 phases in exact order. Do NOT skip any phase.**");
  parts.push("");

  // Phase 1: Explore + Plan
  parts.push("## Phase 1: Explore & Plan");
  parts.push("");
  parts.push("### Step 1: Explore via subagents");
  parts.push("Spawn Explore subagents using the Agent tool (subagent_type: Explore) to investigate the codebase IN PARALLEL before planning.");
  parts.push("Each subagent uses Haiku — fast and cheap. Spawn all subagents in a single response so they run concurrently.");
  parts.push("");

  const exploreAgents: string[] = [];

  // Agent A: Files being modified + dependency outputs
  const filesToReview = [...task.modifies];
  for (const depId of task.dependsOn) {
    const dep = allTasks.find(t => t.id === depId);
    if (dep) filesToReview.push(...dep.creates, ...dep.modifies);
  }
  if (filesToReview.length > 0) {
    const uniqueFiles = [...new Set(filesToReview)];
    exploreAgents.push(
      `Read and summarize these files — note their exports, patterns, error handling, and any conventions I must follow: ${uniqueFiles.map(f => "`" + f + "`").join(", ")}`
    );
  }

  // Agent B: Directory patterns for new files
  if (task.creates.length > 0) {
    const dirs = [...new Set(task.creates.map(f => path.dirname(f)).filter(d => d !== "."))];
    if (dirs.length > 0) {
      exploreAgents.push(
        `Explore these directories and summarize the existing patterns (naming, structure, exports, test conventions): ${dirs.map(d => "`" + d + "/`").join(", ")}`
      );
    }
  }

  // Agent C: Project-wide conventions (always)
  exploreAgents.push(
    "Find and summarize project-wide conventions: shared types in `src/types/`, barrel exports, error handling patterns, and test utilities. Check `CLAUDE.md` for coding standards."
  );

  if (exploreAgents.length === 1) {
    parts.push("Spawn 1 Explore subagent:");
  } else {
    parts.push(`Spawn ${exploreAgents.length} Explore subagents in parallel:`);
  }
  for (let i = 0; i < exploreAgents.length; i++) {
    parts.push(`${i + 1}. ${exploreAgents[i]}`);
  }
  parts.push("");
  parts.push("Wait for all results, then synthesize the findings.");
  parts.push("");

  parts.push("### Step 2: Write the plan");
  parts.push("Using insights from the Explore subagents, create a detailed implementation plan:");
  parts.push("- What files to create/modify and why");
  parts.push("- Key design decisions and trade-offs");
  parts.push("- How you'll satisfy each requirement listed above");
  parts.push("- Testing strategy (what to test, edge cases)");
  if (task.tddPhase.includes("RED") || task.tddPhase.includes("GREEN")) {
    parts.push("- TDD order: which failing tests to write first");
  }
  parts.push(`Save your plan to: \`plan-t${task.id}.md\``);
  parts.push("");

  // Phase 2: Plan Review (subagent via Agent tool)
  parts.push("## Phase 2: Plan Review (via subagent)");
  parts.push("After your plan is written, you MUST dispatch an independent review subagent.");
  parts.push("Use the Agent tool to spawn a review subagent with this prompt:");
  parts.push("");
  parts.push("```");
  parts.push(`Review the implementation plan in plan-t${task.id}.md for Task ${task.id}: ${task.title}.`);
  parts.push("");
  parts.push("Read the plan file, then read the design doc and task manifest for full context:");
  parts.push(`- Design doc: ${args.designPath}`);
  parts.push(`- Task manifest: ${args.manifestPath}`);
  parts.push("");
  parts.push("Evaluate the plan against these criteria:");
  parts.push("1. **Completeness** — Does it address every requirement for this task?");
  parts.push("2. **Correctness** — Are the design decisions sound? Any logical errors?");
  parts.push("3. **DRY** — Does it avoid duplicating existing code/patterns in the codebase?");
  parts.push("4. **Security** — Any injection, XSS, or OWASP top-10 risks?");
  parts.push("5. **Testability** — Is the testing strategy thorough? Missing edge cases?");
  parts.push("6. **Dependency awareness** — Does it account for files from upstream tasks?");
  if (task.tddPhase.includes("RED") || task.tddPhase.includes("GREEN")) {
    parts.push("7. **TDD discipline** — Is the red-green-refactor order correct?");
  }
  parts.push("");
  parts.push("Provide specific, actionable feedback. Flag any blocking issues.");
  parts.push("Do NOT make changes — only review and report findings.");
  parts.push("```");
  parts.push("");
  parts.push("After receiving the review, critically evaluate EACH piece of feedback:");
  parts.push("- Do NOT blindly agree with every suggestion");
  parts.push("- Push back on incorrect or unnecessary suggestions with technical reasoning");
  parts.push("- Accept valid improvements and update your plan accordingly");
  parts.push("- If a suggestion is wrong, explain WHY it's wrong — don't just ignore it");
  parts.push("Then update your plan file with accepted changes before proceeding.");
  parts.push("");

  // Phase 3: Implement
  parts.push("## Phase 3: Implement");
  if (task.tddPhase.includes("RED") || task.tddPhase.includes("GREEN")) {
    parts.push("Follow strict TDD Red-Green-Refactor:");
    parts.push("1. **RED** — Write failing tests first that define expected behavior");
    parts.push("2. **GREEN** — Write minimum implementation to pass tests");
    parts.push("3. **REFACTOR** — Clean up without changing behavior, keeping tests green");
  } else {
    parts.push("Implement according to your reviewed plan.");
  }
  parts.push("Run `npm run build` and `npm test` after implementation — fix any failures.");
  parts.push("");

  // Phase 4: Code Review (subagent via Agent tool)
  parts.push("## Phase 4: Code Review (via subagent)");
  parts.push("After implementation passes build + tests, you MUST dispatch a code review subagent.");
  parts.push("Use the Agent tool to spawn a review subagent with this prompt:");
  parts.push("");
  parts.push("```");
  parts.push(`Review the code changes for Task ${task.id}: ${task.title}.`);
  parts.push("");
  parts.push(`Run \`git diff HEAD~1\` (or \`git diff\` if uncommitted) to see all changes.`);
  parts.push(`Also read the implementation plan at plan-t${task.id}.md for context.`);
  parts.push("");
  parts.push("Evaluate against these criteria:");
  parts.push("1. **Correctness** — Does the code do what the plan says? Any bugs?");
  parts.push("2. **Security** — Command injection, XSS, SQL injection, OWASP top-10?");
  parts.push("3. **DRY** — Any code duplication? Could existing utilities be reused?");
  parts.push("4. **Test coverage** — Are all requirements tested? Edge cases covered?");
  parts.push("5. **Performance** — Any O(n²) loops, unnecessary allocations, blocking calls?");
  parts.push("6. **Code quality** — Clear naming, proper error handling, no dead code?");
  parts.push("7. **Navigability** — Will future developers understand this code easily?");
  parts.push("");
  parts.push("Provide specific, line-level feedback. Flag blocking issues vs nice-to-haves.");
  parts.push("Do NOT make changes — only review and report findings.");
  parts.push("```");
  parts.push("");
  parts.push("After receiving the code review, critically evaluate EACH piece of feedback:");
  parts.push("- Do NOT performatively agree — technically verify each suggestion");
  parts.push("- Push back on wrong suggestions with evidence (run the code, check the docs)");
  parts.push("- Accept and fix valid issues");
  parts.push("- If you disagree, explain your reasoning clearly");
  parts.push("Implement accepted fixes, then re-run `npm run build` and `npm test`.");
  parts.push("");

  // Phase 5: Finalize
  parts.push("## Phase 5: Verify & Commit");
  parts.push("1. Run `npm run build` — verify no TypeScript errors");
  parts.push("2. Run `npm test` — verify all tests pass");
  parts.push(`3. Commit all changes with exactly this message: \`${task.commitMessage}\``);
  parts.push(`4. Write a file called \`.memory-entry.md\` in the repo root with these three lines:`);
  parts.push("```");
  parts.push(`**Created:** <list of files you created>`);
  parts.push(`**Exports:** <key public exports other tasks might use>`);
  parts.push(`**Gotcha:** <one key lesson, convention, or decision future tasks should know>`);
  parts.push("```");
  parts.push("5. Delete the plan file: `rm plan-t${task.id}.md`");
  parts.push("6. Do NOT push. Just commit locally.");
  parts.push("");

  // Important notes
  parts.push("---");
  parts.push("");
  parts.push("**Important:**");
  parts.push(`- You are working in a git worktree. Your branch is based on \`${args.branch}\`.`);
  parts.push("- Only modify/create the files listed above. Do not touch unrelated files.");
  parts.push("- If you encounter an issue you cannot resolve, describe it clearly and commit what you have.");
  parts.push("- Explore existing code patterns before writing anything new.");
  parts.push("- The plan review (Phase 2) and code review (Phase 4) are NOT optional — you MUST use the Agent tool to spawn independent review subagents for both.");
  parts.push("- When receiving review feedback, apply critical thinking — no blind agreement, no performative fixes. Verify technically, push back when wrong, accept when right.");

  return parts.join("\n");
}

// ─── 9. Terminal Output ─────────────────────────────────────────────────────

const CSI = "\x1b[";
const CURSOR_HOME = `${CSI}H`;           // Move cursor to top-left
const CLEAR_LINE = `${CSI}K`;            // Clear from cursor to end of line
const CLEAR_BELOW = `${CSI}J`;           // Clear from cursor to end of screen
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const RESET = `${CSI}0m`;
const C_RED = `${CSI}31m`;
const C_GREEN = `${CSI}32m`;
const C_YELLOW = `${CSI}33m`;
const C_BLUE = `${CSI}34m`;
const C_CYAN = `${CSI}36m`;
const C_GRAY = `${CSI}90m`;

function log(msg: string): void {
  console.error(msg);
}

let lastRenderLineCount = 0;

function renderStatus(tasks: MiniTask[]): void {
  const cols = process.stdout.columns || 80;
  const done = tasks.filter(t => t.status === "done").length;
  const failed = tasks.filter(t => t.status === "failed").length;
  const running = tasks.filter(t => t.status === "running");
  const queued = tasks.filter(t => t.status === "queued");
  const blocked = tasks.filter(t => t.status === "blocked");
  const total = tasks.length;

  const lines: string[] = [];

  // Header + progress bar
  const barWidth = Math.min(40, cols - 30);
  const pct = total > 0 ? done / total : 0;
  const filled = Math.round(pct * barWidth);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
  lines.push(`${BOLD}${C_CYAN}AUTOBOARD${RESET}  ${done}/${total} ${C_GREEN}${bar}${RESET}  ${failed > 0 ? `${C_RED}${failed} failed${RESET}  ` : ""}`);
  lines.push("");

  // Running tasks
  if (running.length > 0) {
    lines.push(`${C_YELLOW}${BOLD}RUNNING (${running.length})${RESET}`);
    for (const t of running) {
      const elapsed = t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : 0;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const time = `${mins}:${String(secs).padStart(2, "0")}`;
      const kb = (t.bytesReceived / 1024).toFixed(0);
      const lastLine = t.lastLine ? `  ${DIM}${t.lastLine.slice(0, cols - 55)}${RESET}` : "";
      lines.push(`  ${C_YELLOW}T${t.id}${RESET} ${t.title.slice(0, 35)}  ${C_GRAY}turns:${t.turnCount} ${time} ${kb}KB${RESET}${lastLine}`);
    }
    lines.push("");
  }

  // Queued
  if (queued.length > 0) {
    const ids = queued.map(t => `T${t.id}`).join(", ");
    lines.push(`${C_BLUE}QUEUED (${queued.length})${RESET}  ${DIM}${ids}${RESET}`);
  }

  // Blocked
  if (blocked.length > 0) {
    const ids = blocked.map(t => `T${t.id}`).join(", ");
    lines.push(`${C_GRAY}BLOCKED (${blocked.length})${RESET}  ${DIM}${ids}${RESET}`);
  }

  // Done
  const doneTasks = tasks.filter(t => t.status === "done");
  if (doneTasks.length > 0) {
    const ids = doneTasks.map(t => `T${t.id}`).join(", ");
    lines.push(`${C_GREEN}DONE (${doneTasks.length})${RESET}  ${DIM}${ids}${RESET}`);
  }

  // Failed
  const failedTasks = tasks.filter(t => t.status === "failed");
  if (failedTasks.length > 0) {
    lines.push(`${C_RED}FAILED (${failedTasks.length})${RESET}`);
    for (const t of failedTasks) {
      lines.push(`  ${C_RED}T${t.id}${RESET} ${t.title}  ${DIM}${t.lastLine.slice(0, cols - 40)}${RESET}`);
    }
  }

  // Log hint
  lines.push("");
  lines.push(`${DIM}Logs: .autoboard-logs/t<N>.jsonl  (tail -f to watch)${RESET}`);

  // Move cursor to home, write each line with clear-to-end, then clear remaining
  const output = CURSOR_HOME
    + lines.map(l => l + CLEAR_LINE).join("\n")
    + "\n"
    + CLEAR_BELOW;
  process.stdout.write(output);
  lastRenderLineCount = lines.length;
}

// ─── 10. Main Loop ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  checkPrereqs(args);

  log(`${BOLD}Autoboard Mini-MVP${RESET}`);
  log(`Manifest: ${args.manifestPath}`);
  log(`Design:   ${args.designPath}`);
  log(`Model:    ${args.models.implementation.model}`);
  log(`Branch:   ${args.branch}`);
  log(`Parallel: ${args.concurrency}`);
  log("");

  // Parse manifest — always parse ALL tasks for progress tracking
  const allTasks = parseManifest(args.manifestPath);
  log(`Parsed ${allTasks.length} tasks from manifest.`);

  // Resume: merge completed tasks from progress.md AND git log (belt and suspenders)
  const completedFromProgress = readProgress();
  const completedFromGit = detectCompletedTasksFromGitLog(args.branch, allTasks, args.verbose);
  const completedTaskIds = new Set([...completedFromProgress.keys(), ...completedFromGit]);
  if (completedTaskIds.size > 0) {
    let skipped = 0;
    for (const t of allTasks) {
      if (completedTaskIds.has(t.id)) {
        t.status = "done";
        t.completedAt = completedFromProgress.get(t.id) || new Date().toISOString();
        t.lastLine = "Already merged (resumed)";
        skipped++;
      }
    }
    if (skipped > 0) {
      const ids = [...completedTaskIds].filter(id => allTasks.some(t => t.id === id)).sort((a, b) => a - b);
      log(`${C_GREEN}Resuming: ${skipped} task(s) already completed: ${ids.map(id => `T${id}`).join(", ")}${RESET}`);
    }
    // Unblock tasks whose deps are now all done
    for (const t of allTasks) {
      if (t.status === "blocked") {
        const depsOk = t.dependsOn.every(d => {
          const dep = allTasks.find(dt => dt.id === d);
          return dep ? dep.status === "done" : true;
        });
        if (depsOk) t.status = "queued";
      }
    }
  }

  // Filter tasks if --tasks specified — only affects which tasks are scheduled
  let tasks: MiniTask[];
  if (args.taskFilter) {
    const filterSet = new Set(args.taskFilter);
    tasks = allTasks.filter(t => filterSet.has(t.id));
    // Remove deps that aren't in the filtered set (treat them as already done)
    for (const t of tasks) {
      t.dependsOn = t.dependsOn.filter(d => filterSet.has(d));
      if (t.dependsOn.length === 0 && t.status !== "done") t.status = "queued";
    }
    log(`Filtered to ${tasks.length} tasks: ${args.taskFilter.join(", ")}`);
  } else {
    tasks = allTasks;
  }

  // Write initial progress file — always writes ALL tasks to preserve status
  writeProgress(allTasks);

  // Topological sort and display layers
  const layers = topologicalSort(tasks);
  log("");
  log(`${BOLD}Execution layers:${RESET}`);
  for (const layer of layers) {
    const taskDescs = layer.taskIds.map(id => {
      const t = tasks.find(t => t.id === id)!;
      return `T${id}(${t.title.slice(0, 25)})`;
    });
    log(`  Layer ${layer.layerIndex}: ${taskDescs.join(", ")}`);
  }
  log("");

  if (args.dryRun) {
    log(`${C_CYAN}Dry run — not spawning agents.${RESET}`);
    log("");
    for (const t of tasks) {
      log(`  T${t.id}: ${t.title}`);
      log(`    Creates:    ${t.creates.join(", ") || "(none)"}`);
      log(`    Modifies:   ${t.modifies.join(", ") || "(none)"}`);
      log(`    Deps:       ${t.dependsOn.map(d => `T${d}`).join(", ") || "(none)"}`);
      log(`    TDD:        ${t.tddPhase}`);
      log(`    Commit:     ${t.commitMessage}`);
      log(`    Complexity: ${t.complexity}`);
      log(`    Reqs (${t.requirements.length}):`);
      for (const req of t.requirements) {
        log(`      - ${req.split("\n")[0]}`);
      }
      log("");
    }
    return;
  }

  // Setup feature branch
  setupFeatureBranch(args.branch, args.verbose);

  // Shutdown handling
  let shuttingDown = false;
  let forceShutdown = false;

  process.on("SIGINT", () => {
    if (forceShutdown) {
      log(`\n${C_RED}Force shutdown — cleaning up worktrees...${RESET}`);
      cleanupAllWorktrees(tasks, args.branch, args.verbose);
      process.stdout.write(SHOW_CURSOR);
      process.exit(1);
    }
    if (shuttingDown) {
      forceShutdown = true;
      log(`\n${C_YELLOW}Press Ctrl+C again to force shutdown.${RESET}`);
      return;
    }
    shuttingDown = true;
    log(`\n${C_YELLOW}Graceful shutdown — waiting for running tasks (10s timeout)...${RESET}`);
    log(`${C_YELLOW}Press Ctrl+C again to force.${RESET}`);

    // Kill running agents after 10s
    setTimeout(() => {
      for (const t of tasks) {
        if (t.status === "running" && t.process) {
          t.process.kill("SIGTERM");
        }
      }
    }, 10000);
  });

  // Hide cursor, clear screen once for initial render
  process.stdout.write(HIDE_CURSOR + `${CSI}2J` + CURSOR_HOME);

  // Main event loop
  const taskMap = new Map<number, MiniTask>();
  for (const t of tasks) taskMap.set(t.id, t);

  const displayInterval = setInterval(() => renderStatus(tasks), 1000);

  try {
    await runLoop(tasks, allTasks, taskMap, args, () => shuttingDown, () => forceShutdown);
  } finally {
    clearInterval(displayInterval);
    process.stdout.write(SHOW_CURSOR);

    // Final status
    renderStatus(tasks);

    // Cleanup all worktrees
    cleanupAllWorktrees(tasks, args.branch, args.verbose);

    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    log("");
    if (failed > 0) {
      log(`${C_RED}${BOLD}Completed with ${failed} failures.${RESET} ${done}/${tasks.length} tasks done.`);
    } else if (done === tasks.length) {
      log(`${C_GREEN}${BOLD}All ${tasks.length} tasks completed successfully!${RESET}`);
      log(`Branch \`${args.branch}\` is ready. Review and push when ready.`);
    } else {
      log(`${C_YELLOW}${done}/${tasks.length} tasks completed.${RESET}`);
    }
  }
}

async function runLoop(
  tasks: MiniTask[],
  allTasks: MiniTask[],
  taskMap: Map<number, MiniTask>,
  args: CLIArgs,
  isShuttingDown: () => boolean,
  isForceShutdown: () => boolean,
): Promise<void> {
  // Track active agent promises
  const activeAgents = new Map<number, Promise<void>>();

  while (true) {
    // Check if we're done
    const allSettled = tasks.every(t => t.status === "done" || t.status === "failed");
    if (allSettled) break;

    // Check if we're stuck (no running, no queued, but some blocked/failed)
    const running = tasks.filter(t => t.status === "running");
    const queued = tasks.filter(t => t.status === "queued");
    if (running.length === 0 && queued.length === 0 && activeAgents.size === 0) {
      const blocked = tasks.filter(t => t.status === "blocked");
      if (blocked.length > 0) {
        log(`${C_RED}Stuck: ${blocked.length} tasks blocked, no tasks can proceed.${RESET}`);
        log(`Blocked tasks depend on failed tasks.`);
      }
      break;
    }

    // Check for shutdown
    if (isShuttingDown() || isForceShutdown()) {
      if (activeAgents.size === 0) break;
      // Wait for remaining agents
      await Promise.race([
        Promise.all(activeAgents.values()),
        new Promise(r => setTimeout(r, isForceShutdown() ? 0 : 10000)),
      ]);
      break;
    }

    // Unblock tasks whose deps are all done
    for (const t of tasks) {
      if (t.status === "blocked") {
        const depsOk = t.dependsOn.every(d => {
          const dep = taskMap.get(d);
          return dep ? dep.status === "done" : true; // missing dep treated as done
        });
        if (depsOk) t.status = "queued";
      }
    }

    // Spawn unblocked tasks up to concurrency limit
    if (!isShuttingDown()) {
      const runningNow = tasks.filter(t => t.status === "running");
      const available = args.concurrency - runningNow.length;

      if (available > 0) {
        const candidates = tasks.filter(t => t.status === "queued");
        let spawned = 0;

        for (const candidate of candidates) {
          if (spawned >= available) break;

          // Check file conflicts with running tasks
          const conflictsWithRunning = runningNow.some(r => hasFileConflict(r, candidate));
          if (conflictsWithRunning) {
            candidate.lastLine = `Held: file conflict with T${runningNow.find(r => hasFileConflict(r, candidate))!.id}`;
            continue;
          }

          // Spawn this task
          candidate.status = "running";
          candidate.startedAt = Date.now();

          const promise = spawnTaskAgent(candidate, allTasks, args);
          activeAgents.set(candidate.id, promise);

          promise.then(() => {
            activeAgents.delete(candidate.id);
          });

          spawned++;
        }
      }

      // Persist status changes (running, unblocked) each loop iteration
      writeProgress(allTasks);
    }

    // Wait a bit before next iteration
    await new Promise(r => setTimeout(r, 2000));
  }

  // Wait for any remaining active agents
  if (activeAgents.size > 0) {
    await Promise.all(activeAgents.values());
  }
}

async function spawnTaskAgent(task: MiniTask, allTasks: MiniTask[], args: CLIArgs): Promise<void> {
  let wp: string;
  try {
    wp = createWorktree(task.id, args.branch, args.verbose);
  } catch (e: any) {
    log(`${C_RED}Failed to create worktree for T${task.id}: ${e.message}${RESET}`);
    task.status = "failed";
    task.lastLine = `Worktree creation failed: ${e.message}`;
    return;
  }

  task.worktreePath = wp;

  const brief = buildBrief(task, allTasks, args);
  const child = spawnAgent(task, brief, args.models.implementation.model, wp, args.verbose);
  task.process = child;

  // Timeout: kill if no bytes within 120s at startup, or no new bytes for 5 min mid-task
  const STARTUP_TIMEOUT_MS = 120_000;
  const STALL_TIMEOUT_MS = 300_000;
  let lastBytesChecked = 0;
  let lastByteTime = Date.now();

  const stallTimer = setInterval(() => {
    if (task.status !== "running") return;
    const now = Date.now();

    if (task.bytesReceived > lastBytesChecked) {
      // Progress — reset stall clock
      lastBytesChecked = task.bytesReceived;
      lastByteTime = now;
      return;
    }

    const silenceMs = now - lastByteTime;

    if (task.bytesReceived === 0 && silenceMs >= STARTUP_TIMEOUT_MS) {
      log(`${C_RED}[T${task.id}] No output received after ${STARTUP_TIMEOUT_MS / 1000}s — killing agent.${RESET}`);
      log(`${C_YELLOW}[T${task.id}] Likely caused by API throttling. Close other Claude sessions and retry.${RESET}`);
      child.kill("SIGTERM");
    } else if (task.bytesReceived > 0 && silenceMs >= STALL_TIMEOUT_MS) {
      log(`${C_RED}[T${task.id}] No output for ${STALL_TIMEOUT_MS / 1000 / 60} minutes — killing stalled agent.${RESET}`);
      log(`${C_YELLOW}[T${task.id}] May have hit session limits. Re-run to resume.${RESET}`);
      child.kill("SIGTERM");
    }
  }, 15_000);

  return new Promise<void>((resolve) => {
    child.on("close", async (code) => {
      clearInterval(stallTimer);
      task.process = undefined;

      if (code === 0) {
        // Capture memory entry BEFORE merge (stash in squashMerge would hide it)
        const entryPath = path.join(wp, ".memory-entry.md");
        let memoryBody = "";
        if (fs.existsSync(entryPath)) {
          memoryBody = fs.readFileSync(entryPath, "utf-8").trim();
        } else {
          log(`${C_YELLOW}[T${task.id}] No .memory-entry.md found at ${entryPath} — agent skipped memory write.${RESET}`);
        }

        // Squash merge back to feature branch
        try {
          await squashMerge(task.id, args.branch, task.commitMessage, args.verbose);
          task.status = "done";
          task.completedAt = new Date().toISOString();
          task.lastLine = "Completed and merged";

          if (memoryBody) {
            appendMemoryEntry(task.id, task.title, memoryBody);
          }
        } catch (e: any) {
          log(`${C_RED}Merge failed for T${task.id}: ${e.message}${RESET}`);
          task.status = "failed";
          task.lastLine = `Merge failed: ${e.message.slice(0, 80)}`;
        }
      } else {
        task.status = "failed";
        task.lastLine = `Agent exited with code ${code}`;
      }

      // Persist progress after each task completes or fails
      writeProgress(allTasks);

      // Cleanup worktree
      cleanupWorktree(task.id, args.branch, args.verbose);
      task.worktreePath = undefined;

      resolve();
    });

    child.on("error", (err) => {
      clearInterval(stallTimer);
      task.status = "failed";
      task.lastLine = `Spawn error: ${err.message}`;
      task.process = undefined;
      cleanupWorktree(task.id, args.branch, args.verbose);
      task.worktreePath = undefined;
      resolve();
    });
  });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

main().catch((e) => {
  process.stdout.write(SHOW_CURSOR);
  console.error(`${C_RED}Fatal: ${e.message}${RESET}`);
  process.exit(1);
});
