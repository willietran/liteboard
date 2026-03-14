#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Session, Task, CLIArgs } from "./types.js";
import { defaultModelConfig } from "./types.js";
import { parseManifest, parseSessions } from "./parser.js";
import { resolveSessionDependencies, hasSessionFileConflict } from "./resolver.js";
import { writeProgress, readProgress, detectCompletedFromGitLog } from "./progress.js";
import { createProvider, validateOllamaBaseUrl, checkOllamaHealth, checkOllamaModel, pullOllamaModel } from "./provider.js";
import { parseProjectConfig, validateConfig, hasOllamaProvider, applyOllamaFallback } from "./config.js";
import {
  setupFeatureBranch,
  cleanupWorktree,
  cleanupAllWorktrees,
  cleanupStaleWorktrees,
  getWorktreePath,
} from "./worktree.js";
import {
  gatherDecisionContext,
  askTriage,
  executeTriageAction,
  writeDecisionRecord,
} from "./triage.js";
import { renderStatus, isTTY, setForcePipeMode, HIDE_CURSOR, SHOW_CURSOR, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "./dashboard.js";
import { git } from "./git.js";
import { artifactsDir } from "./paths.js";
import {
  spawnSession,
  handleMergingSession,
  type SessionRunnerContext,
} from "./task-runner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

// Logs to stderr intentionally — stdout is reserved for the dashboard TUI rendering.
function log(msg: string): void {
  console.error(msg);
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);

  if (args[0] && args[0] !== "run" && !args[0].startsWith("--")) {
    console.error(`\x1b[31mError:\x1b[0m Unknown subcommand: ${args[0]}`);
    console.error(`Did you mean: liteboard run <project-path>  or  liteboard-setup`);
    process.exit(1);
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: liteboard run <project-path-or-slug> [options]

Options:
  --concurrency=<N>       Max parallel agents (default: 1)
  --model=<model>         Override implementation model
  --branch=<name>         Feature branch name
  --tasks=<1,2,3>         Run specific task IDs only
  --dry-run               Parse and show dependency graph only
  --verbose               Log all git commands to stderr
  --no-tui                Disable TUI dashboard (line-based output)`);
    process.exit(0);
  }

  // First positional arg after "run" is the project path
  const positional: string[] = [];
  let concurrency = 1;
  const models = defaultModelConfig();
  let branch = "";
  let taskFilter: number[] | null = null;
  let dryRun = false;
  let verbose = false;
  let noTui = false;

  for (const arg of args) {
    if (arg === "run") continue;
    if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, parseInt(arg.slice("--concurrency=".length), 10) || 1);
    } else if (arg.startsWith("--model=")) {
      models.implementation.model = arg.slice("--model=".length);
    } else if (arg.startsWith("--branch=")) {
      branch = arg.slice("--branch=".length);
    } else if (arg.startsWith("--tasks=")) {
      taskFilter = arg.slice("--tasks=".length).split(",").map(s => parseInt(s.trim(), 10));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--no-tui") {
      noTui = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  let projectPath = positional[0] || "";
  if (!projectPath) die("Missing required argument: <project-path-or-slug>");

  // Resolve slug to path
  if (!projectPath.includes("/") && !projectPath.includes("\\")) {
    const slugPath = path.resolve("docs", "liteboard", projectPath);
    if (fs.existsSync(slugPath)) {
      projectPath = slugPath;
    }
  }
  projectPath = path.resolve(projectPath);

  if (!branch) {
    const slug = path.basename(projectPath);
    branch = `liteboard/${slug}`;
  }

  return { projectPath, concurrency, models, branch, taskFilter, dryRun, verbose, noTui };
}

// ─── Startup Checks ─────────────────────────────────────────────────────

async function checkPrereqs(args: CLIArgs): Promise<void> {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "pipe" });
  } catch {
    die("Not a git repository. Run this from a git repo root.");
  }

  try {
    execFileSync("which", ["claude"], { stdio: "pipe" });
  } catch {
    die("`claude` CLI not found on PATH. Install Claude Code first.");
  }

  const manifestPath = path.join(args.projectPath, "manifest.md");
  if (!fs.existsSync(manifestPath)) {
    die(`Manifest not found: ${manifestPath}`);
  }

  // Warn about concurrent claude processes
  try {
    const psOutput = execFileSync("pgrep", ["-afl", "claude"], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const lines = psOutput.trim().split("\n").filter(line =>
      line.includes("claude") && !line.includes("pgrep") && !line.includes("liteboard"),
    );
    if (lines.length > 0) {
      log(`\x1b[33mWarning: Found ${lines.length} other claude process(es) running.\x1b[0m`);
      log(`\x1b[33mConcurrent sessions may cause spawned agents to hang due to API throttling.\x1b[0m`);
    }
  } catch {
    // pgrep returns non-zero if no matches
  }

  // Ollama health check
  const projectConfig = { agents: args.models, concurrency: args.concurrency, ollama: args.ollama };
  if (hasOllamaProvider(projectConfig)) {
    const baseUrl = args.ollama?.baseUrl ?? "http://localhost:11434";
    validateOllamaBaseUrl(baseUrl);
    const healthy = await checkOllamaHealth(baseUrl);
    if (!healthy) {
      if (args.ollama?.fallback) {
        applyOllamaFallback(projectConfig);
        // args.models is mutated in-place (same reference as projectConfig.agents)
      } else {
        die(`Ollama is not reachable at ${baseUrl}. Start Ollama or set fallback: true in config.json.`);
      }
    } else {
      // Server is healthy — verify each Ollama model is registered
      const ollamaModels = new Set<string>();
      for (const agent of Object.values(args.models)) {
        if (agent.provider === "ollama") ollamaModels.add(agent.model);
      }
      const modelChecks = await Promise.all(
        [...ollamaModels].map(async (model) => ({
          model,
          available: await checkOllamaModel(baseUrl, model),
        })),
      );
      for (const { model, available } of modelChecks) {
        if (!available) {
          log(`Ollama model '${model}' not registered. Pulling...`);
          if (!pullOllamaModel(model)) {
            die(`Failed to pull Ollama model '${model}' (timed out after 30s). Run manually: ollama pull ${model}`);
          }
        }
      }
    }
  }
}

// ─── Gitignore Management ───────────────────────────────────────────────

function ensureGitignores(projectDir: string): void {
  // Ensure logs/.gitignore
  const logsDir = path.join(projectDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logsGitignore = path.join(logsDir, ".gitignore");
  if (!fs.existsSync(logsGitignore)) {
    fs.writeFileSync(logsGitignore, "*\n", "utf-8");
  }

  // Ensure artifacts/.gitignore
  const artDir = artifactsDir(projectDir);
  if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });
  const artifactsGitignore = path.join(artDir, ".gitignore");
  if (!fs.existsSync(artifactsGitignore)) {
    fs.writeFileSync(artifactsGitignore, "*\n!.gitignore\n", "utf-8");
  }

  // Ensure repo .gitignore has ephemeral patterns
  const repoGitignore = path.resolve(".gitignore");
  if (fs.existsSync(repoGitignore)) {
    const content = fs.readFileSync(repoGitignore, "utf-8");
    const additions: string[] = [];
    if (!content.includes(".brief-s")) additions.push(".brief-s*.md");
    if (!content.includes(".memory-entry")) additions.push(".memory-entry.md");
    if (!content.includes(".qa-report")) additions.push(".qa-report.md");
    if (additions.length > 0) {
      fs.appendFileSync(repoGitignore, "\n" + additions.join("\n") + "\n", "utf-8");
    }
  }
}

// ─── Dry-Run Helpers ──────────────────────────────────────────────────────

/** Computes the critical path through session dependencies (longest chain by complexity sum). */
function computeCriticalPath(sessions: Session[], sessionDeps: Map<string, string[]>): string[] {
  if (sessions.length === 0) return [];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  const memo = new Map<string, number>();

  function pathCost(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    const s = sessionMap.get(id);
    if (!s) { memo.set(id, 0); return 0; }
    const deps = sessionDeps.get(id) ?? [];
    const maxDepCost = deps.reduce((max, d) => Math.max(max, pathCost(d)), 0);
    const cost = s.complexity + maxDepCost;
    memo.set(id, cost);
    return cost;
  }

  for (const s of sessions) pathCost(s.id);

  let maxCost = -1;
  let endId = sessions[0].id;
  for (const s of sessions) {
    const cost = memo.get(s.id) ?? 0;
    if (cost > maxCost) { maxCost = cost; endId = s.id; }
  }

  const chain: string[] = [];
  let current: string | null = endId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.unshift(current);
    const deps: string[] = sessionDeps.get(current) ?? [];
    if (deps.length === 0) break;
    let nextId: string = deps[0];
    let nextCost = memo.get(deps[0]) ?? 0;
    for (const depId of deps.slice(1)) {
      const c = memo.get(depId) ?? 0;
      if (c > nextCost) { nextCost = c; nextId = depId; }
    }
    current = nextId;
  }
  return chain;
}

/** Groups sessions into waves — sessions in the same wave can run concurrently. */
function computeWaves(sessions: Session[], sessionDeps: Map<string, string[]>): string[][] {
  const waveMap = new Map<string, number>();

  function getWave(id: string): number {
    if (waveMap.has(id)) return waveMap.get(id)!;
    const deps = sessionDeps.get(id) ?? [];
    const wave = deps.length === 0 ? 0 : Math.max(...deps.map(d => getWave(d))) + 1;
    waveMap.set(id, wave);
    return wave;
  }

  for (const s of sessions) getWave(s.id);

  const grouped = new Map<number, string[]>();
  for (const [id, wave] of waveMap) {
    if (!grouped.has(wave)) grouped.set(wave, []);
    grouped.get(wave)!.push(id);
  }
  const maxWave = waveMap.size > 0 ? Math.max(...waveMap.values()) : -1;
  return Array.from({ length: maxWave + 1 }, (_, i) => grouped.get(i) ?? []);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  setForcePipeMode(args.noTui);

  const slug = path.basename(args.projectPath);
  const manifestPath = path.join(args.projectPath, "manifest.md");
  const designPath = path.join(args.projectPath, "design.md");

  // Load and merge config.json (before checkPrereqs so Ollama health check has config)
  const configPath = path.join(args.projectPath, "config.json");
  const projectConfig = parseProjectConfig(configPath);

  // Apply config values — CLI flags take priority
  if (!process.argv.some(a => a.startsWith("--concurrency"))) {
    args.concurrency = projectConfig.concurrency;
  }
  if (projectConfig.branch && !process.argv.some(a => a.startsWith("--branch"))) {
    args.branch = projectConfig.branch;
  }
  const cliHasModel = process.argv.some(a => a.startsWith("--model"));
  for (const role of ["architect", "implementation", "qa"] as const) {
    if (role === "implementation" && cliHasModel) {
      // Keep CLI-provided model, take other fields from config
      args.models[role].provider = projectConfig.agents[role].provider;
      args.models[role].subagents = projectConfig.agents[role].subagents;
    } else {
      args.models[role] = projectConfig.agents[role];
    }
  }
  args.ollama = projectConfig.ollama;

  validateConfig({ agents: args.models, concurrency: args.concurrency, ollama: args.ollama });

  await checkPrereqs(args);
  ensureGitignores(args.projectPath);

  // Read docs once; pass inline content to all brief builders
  const designDoc = fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf-8") : "";
  const manifestContent = fs.readFileSync(manifestPath, "utf-8");

  // Warn if combined inline content is very large
  if (designDoc.length + manifestContent.length > 100_000) {
    log(`\x1b[33mWarning: inlined docs total ${Math.round((designDoc.length + manifestContent.length) / 1024)}KB — brief will be large\x1b[0m`);
  }

  // Parse manifest
  const tasks = parseManifest(manifestPath);
  if (tasks.length === 0) die("No tasks found in manifest.");

  const allTasks = tasks;
  let filteredTasks = tasks;

  // Apply task filter
  if (args.taskFilter) {
    const filterSet = new Set(args.taskFilter);
    filteredTasks = tasks.filter(t => filterSet.has(t.id));
    if (filteredTasks.length === 0) die("No tasks match the filter.");
    for (const t of filteredTasks) {
      t.dependsOn = t.dependsOn.filter(d => filterSet.has(d));
      if (t.dependsOn.length === 0 && t.status === "blocked") t.status = "queued";
    }
  }

  // Build sessions
  let filteredSessions = parseSessions(filteredTasks, manifestContent);
  const allSessions = parseSessions(allTasks, manifestContent);
  const sessionDeps = resolveSessionDependencies(filteredSessions);

  // Dry-run: show rich session-oriented execution plan and exit
  if (args.dryRun) {
    const totalTasks = filteredSessions.reduce((sum, s) => sum + s.tasks.length, 0);
    const tddCount = filteredSessions.reduce(
      (sum, s) => sum + s.tasks.filter(t => t.tddPhase && t.tddPhase !== "Exempt").length,
      0,
    );
    const BAR   = "═".repeat(54);
    const RULER = "━".repeat(54);
    const LINE  = "─".repeat(54);

    console.log(`\n${BAR}`);
    console.log(`EXECUTION PLAN  (concurrency=${args.concurrency})`);
    console.log(`${BAR}`);
    console.log(`  Project:  ${args.projectPath}`);
    console.log(`  Branch:   ${args.branch}`);
    console.log(`  Sessions: ${filteredSessions.length}   Tasks: ${totalTasks}   TDD: ${tddCount}`);

    for (const session of filteredSessions) {
      const isQa = session.tasks.some(t => t.type === "qa");
      const deps = sessionDeps.get(session.id) ?? [];
      console.log(isQa
        ? `\nSession ${session.id} — ${session.focus} ${RULER}`
        : `\nSession ${session.id} — ${session.focus}`);
      for (const task of session.tasks) {
        const prefix   = task.type === "qa" ? "[Q]" : "[ ]";
        const tddLabel = task.type === "qa" ? "QA Gate" : (task.tddPhase || "Exempt");
        console.log(`  ${prefix} ${"T" + task.id}`.padEnd(9) + `${task.title}`.padEnd(46) + `C:${task.complexity}  ${tddLabel}`);
      }
      if (deps.length > 0) console.log(`            depends on: ${deps.join(", ")}`);
      if (isQa) console.log(RULER);
    }

    console.log(`\n${LINE}`);
    console.log("  Agent config (from config.json):");
    for (const role of ["architect", "implementation", "qa"] as const) {
      const cfg = args.models[role];
      console.log(`    ${(role + ":").padEnd(17)} ${cfg.provider} / ${cfg.model}`);
    }
    const trCfg = projectConfig.triage ?? { provider: "claude", model: "claude-sonnet-4-6" };
    console.log(`    ${"triage:".padEnd(17)} ${trCfg.provider} / ${trCfg.model}`);

    console.log(`\n${LINE}`);
    console.log("  Worktree plan:");
    for (const session of filteredSessions) {
      console.log(`    ${getWorktreePath(slug, session.id)}`);
    }

    const cp = computeCriticalPath(filteredSessions, sessionDeps);
    console.log(`\n${LINE}`);
    console.log(`  Critical path:  ${cp.join(" → ")}`);

    const parallelWaves = computeWaves(filteredSessions, sessionDeps).filter(w => w.length > 1);
    if (parallelWaves.length > 0) {
      console.log(`\n${LINE}`);
      console.log("  Parallelism opportunities:");
      for (const wave of parallelWaves) {
        console.log(`    Concurrent: ${wave.join(", ")}`);
      }
    }

    console.log();
    process.exit(0);
  }

  // Startup cleanup
  cleanupStaleWorktrees(slug, args.verbose);

  // Resume detection
  const previousProgress = readProgress(args.projectPath);
  const gitCompleted = detectCompletedFromGitLog(args.branch, allTasks, args.verbose);

  // Apply task-level resume
  for (const t of allTasks) {
    const progressEntry = previousProgress.tasks.get(t.id);
    if (progressEntry?.status === "needs_human") {
      t.status = "needs_human";
    } else if (progressEntry?.status === "done") {
      t.status = "done";
      t.completedAt = progressEntry.completedAt;
    } else if (gitCompleted.has(t.id)) {
      t.status = "done";
      t.completedAt = new Date().toISOString();
    }
  }

  // Apply session-level resume
  for (const s of filteredSessions) {
    const sessionEntry = previousProgress.sessions.get(s.id);
    if (sessionEntry?.status === "needs_human") {
      s.status = "needs_human";
    } else if (sessionEntry?.status === "done") {
      s.status = "done";
      s.completedAt = sessionEntry.completedAt;
      // Also mark constituent tasks as done
      for (const t of s.tasks) {
        if (t.status !== "done") {
          t.status = "done";
          t.completedAt = sessionEntry.completedAt;
        }
      }
    }
  }

  // Unblock sessions whose deps are all done
  function updateStatuses(): void {
    // Update task statuses within sessions
    for (const s of filteredSessions) {
      for (const t of s.tasks) {
        if (t.status === "blocked") {
          const allDepsDone = t.dependsOn.every(depId => {
            const dep = allTasks.find(x => x.id === depId);
            return dep?.status === "done";
          });
          if (allDepsDone) t.status = "queued";
        }
      }
    }

    // Update session statuses based on session-level deps
    for (const s of filteredSessions) {
      if (s.status !== "queued" && s.status !== "blocked") continue;
      const deps = sessionDeps.get(s.id) ?? [];
      const allDepsDone = deps.every(depId => {
        const dep = filteredSessions.find(x => x.id === depId);
        return dep?.status === "done";
      });
      s.status = allDepsDone ? "queued" : "blocked";
    }
  }
  updateStatuses();

  // Setup feature branch
  setupFeatureBranch(args.branch, args.verbose);

  // Provider
  const provider = createProvider("claude");

  // Active promises
  const activePromises = new Map<string, Promise<void>>();
  const qaReports = new Map<string, string>();
  let shuttingDown = false;

  function printQAReports(): void {
    if (qaReports.size === 0) return;
    console.log("");
    for (const [sessionId, report] of qaReports) {
      const session = filteredSessions.find(s => s.id === sessionId);
      const title = session?.focus ?? "QA Validation";
      console.log(`\x1b[1mS${sessionId}: ${title}\x1b[0m`);
      console.log(report);
    }
  }

  // ─── Session Runner Context ────────────────────────────────────────────────

  const ctx: SessionRunnerContext = {
    args,
    slug,
    filteredSessions,
    allSessions,
    allTasks,
    designDoc,
    manifestContent,
    provider,
    projectConfig,
    activePromises,
    qaReports,
    updateStatuses,
    sessionDeps,
  };

  // Startup validation: detect stale branches from previous runs and invoke triage
  {
    const existingBranches = new Set<string>();
    try {
      const branchList = git(["branch", "--list", `${args.branch}-s*`], { verbose: args.verbose });
      for (const line of branchList.split("\n")) {
        const name = line.trim().replace(/^\* /, "");
        if (name) existingBranches.add(name);
      }
    } catch {}

    for (const session of filteredSessions) {
      if (session.status === "done" || session.status === "needs_human") continue;
      const sessionBranch = session.branchName ?? `${args.branch}-s${session.id}`;
      if (!existingBranches.has(sessionBranch)) continue;

      // This session has a branch from a previous run but wasn't marked done
      log(`Stale branch detected for S${session.id}, invoking triage for recovery assessment...`);
      try {
        const context = await gatherDecisionContext(
          session, filteredSessions, args.branch, args.projectPath, args.concurrency,
          { stage: "startup_validation", exitCode: -1 },
        );
        const decision = await askTriage(context, args.projectPath, projectConfig);
        writeDecisionRecord(session.id, {
          timestamp: new Date().toISOString(),
          attemptNumber: context.state.attemptCount + 1,
          trigger: {
            stage: "startup_validation",
            errorSummary: "Stale branch from previous run",
          },
          decision,
        }, args.projectPath);
        await executeTriageAction(
          session, decision, context, slug, args.branch, args.projectPath, filteredSessions, args.verbose,
        );

        // Cleanup for terminal statuses only
        const postTriageStatus = session.status as string;
        if (postTriageStatus === "needs_human" || postTriageStatus === "merging") {
          cleanupWorktree(slug, session.id, args.branch, args.verbose, { preserveBranch: true });
        }
      } catch (e) {
        log(`Startup triage failed for S${session.id}: ${e instanceof Error ? e.message : String(e)}`);
        // Don't block startup — let the session proceed normally
      }
    }
    updateStatuses();
  }

  // Clean up per-run artifacts. Preserve durable triage files so that
  // decision history and escalation notes survive across restarts.
  {
    const artDir = artifactsDir(args.projectPath);
    if (fs.existsSync(artDir)) {
      for (const f of fs.readdirSync(artDir)) {
        if (f === ".gitignore") continue;
        if (f.endsWith("-decisions.jsonl")) continue;
        if (f.endsWith("-escalation.md")) continue;
        try { fs.unlinkSync(path.join(artDir, f)); } catch {}
      }
    }
  }

  // Dashboard interval
  if (isTTY()) process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  process.on("exit", () => {
    if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  });
  const dashboardInterval = setInterval(() => {
    renderStatus(filteredSessions, args.projectPath);
  }, 1000);
  renderStatus(filteredSessions, args.projectPath);

  // Graceful shutdown
  process.on("SIGINT", () => {
    shuttingDown = true;
    log("\n\x1b[33mShutting down... waiting for running sessions (10s timeout)\x1b[0m");

    // Kill running agents
    for (const s of filteredSessions) {
      if (s.status === "running" && s.process) {
        s.process.kill("SIGTERM");
      }
    }

    setTimeout(() => {
      clearInterval(dashboardInterval);
      if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      cleanupAllWorktrees(filteredSessions, slug, args.branch, args.verbose, { preserveFailedBranches: true });
      writeProgress(filteredSessions, allTasks, args.projectPath);
      process.exit(1);
    }, 10000);
  });

  // ─── Main Loop ──────────────────────────────────────────────────────

  while (!shuttingDown) {
    updateStatuses();

    const runningSessions = filteredSessions.filter(s => s.status === "running");
    const queuedSessions = filteredSessions.filter(s => s.status === "queued");
    const blockedSessions = filteredSessions.filter(s => s.status === "blocked");

    // Handle sessions in "merging" state (set by retry_merge_only or mark_done)
    const mergingSessions = filteredSessions.filter(
      s => s.status === "merging" && !activePromises.has(s.id),
    );
    for (const session of mergingSessions) {
      const mergePromise = handleMergingSession(ctx, session);
      activePromises.set(session.id, mergePromise);
    }

    // Check completion — nothing running, queued, or in-flight
    if (runningSessions.length === 0 && queuedSessions.length === 0) {
      // Wait for in-flight merge/triage promises before exiting
      if (activePromises.size > 0) {
        await Promise.race(activePromises.values());
        continue; // Re-check statuses after promise completes
      }

      if (blockedSessions.length > 0) {
        log("\x1b[31mStuck: blocked sessions remain but nothing is running or queued.\x1b[0m");
        const sessionById = new Map(filteredSessions.map(s => [s.id, s]));
        for (const s of blockedSessions) {
          const deps = sessionDeps.get(s.id) ?? [];
          const failedDeps = deps.filter(depId => {
            const dep = sessionById.get(depId);
            return dep && (dep.status === "failed" || dep.status === "needs_human");
          });
          if (failedDeps.length > 0) {
            log(`  S${s.id} blocked by: ${failedDeps.map(depId => {
              const dep = sessionById.get(depId);
              return `S${depId} (${dep?.status})`;
            }).join(", ")}`);
          }
        }
      }
      break;
    }

    // Spawn queued sessions up to concurrency limit
    if (activePromises.size < args.concurrency && queuedSessions.length > 0) {
      const spawnedThisIteration: Session[] = [];
      for (const session of queuedSessions) {
        if (activePromises.size >= args.concurrency) break;

        // Check file conflicts with running sessions and those spawned earlier this iteration
        const hasConflict = [...runningSessions, ...spawnedThisIteration].some(
          rs => hasSessionFileConflict(session, rs),
        );
        if (hasConflict) continue;

        spawnSession(ctx, session);
        spawnedThisIteration.push(session);
      }
    }

    writeProgress(filteredSessions, allTasks, args.projectPath);

    // Wait a bit before next iteration
    await new Promise(r => setTimeout(r, 2000));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  // Wait for any remaining promises
  if (activePromises.size > 0) {
    await Promise.allSettled(activePromises.values());
  }

  // Stop session dashboard
  clearInterval(dashboardInterval);

  const doneSessions = filteredSessions.filter(s => s.status === "done").length;
  const failedSessions = filteredSessions.filter(s => s.status === "failed").length;
  const needsHumanCount = filteredSessions.filter(s => s.status === "needs_human").length;
  const totalTasks = filteredSessions.reduce((sum, s) => sum + s.tasks.length, 0);

  if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  console.log("");
  console.log(`\x1b[1mLiteboard Complete\x1b[0m`);

  if (failedSessions > 0 || needsHumanCount > 0) {
    let summary = `  \x1b[32m${doneSessions} done\x1b[0m`;
    if (failedSessions > 0) summary += `, \x1b[31m${failedSessions} failed\x1b[0m`;
    if (needsHumanCount > 0) summary += `, \x1b[33m${needsHumanCount} needs human\x1b[0m`;
    summary += ` of ${filteredSessions.length} sessions (${totalTasks} tasks)`;
    console.log(summary);

    if (failedSessions > 0) {
      console.log(`  Check logs at ${args.projectPath}/logs/ for failure details.`);
    }
    if (needsHumanCount > 0) {
      console.log(`  ${needsHumanCount} session(s) need human intervention — see artifacts/s<ID>-escalation.md`);
    }
    printQAReports();
    process.exit(1);
  }

  console.log(`  \x1b[32mAll ${doneSessions} sessions merged (${totalTasks} tasks)\x1b[0m`);
  console.log(`  Branch \x1b[36m${args.branch}\x1b[0m is ready for PR.`);
  printQAReports();

  process.exit(0);
}

main().catch(e => {
  if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  console.error(e);
  process.exit(1);
});
