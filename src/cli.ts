#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, CLIArgs } from "./types.js";
import { parseManifest } from "./parser.js";
import { topologicalSort, hasFileConflict } from "./resolver.js";
import { writeProgress, readProgress, detectCompletedFromGitLog } from "./progress.js";
import { appendMemoryEntry } from "./memory.js";
import { createProvider } from "./provider.js";
import {
  setupFeatureBranch,
  createWorktree,
  cleanupWorktree,
  cleanupAllWorktrees,
  cleanupStaleWorktrees,
  getWorktreePath,
} from "./worktree.js";
import { squashMerge } from "./merger.js";
import { spawnAgent } from "./spawner.js";
import { renderStatus, isTTY, setForcePipeMode, HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN } from "./dashboard.js";
import { buildBrief } from "./brief.js";
import { runIntegrationGate, gateCleanupProcesses } from "./validator.js";

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

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: liteboard run <project-path-or-slug> [options]

Options:
  --concurrency=<N>       Max parallel agents, 1-5 (default: 1)
  --model=<model>         Override implementation model
  --branch=<name>         Feature branch name
  --tasks=<1,2,3>         Run specific task IDs only
  --dry-run               Parse and show dependency graph only
  --verbose               Log all git commands to stderr
  --skip-validation       Skip integration gate entirely
  --skip-smoke            Skip smoke test phase
  --skip-qa               Skip Playwright QA phase
  --no-fixer              Report failures without auto-fix
  --fixer-patience=<N>    Override fixer patience (default: 3)
  --no-tui                Disable TUI dashboard (line-based output)`);
    process.exit(0);
  }

  // First positional arg after "run" is the project path
  const positional: string[] = [];
  let concurrency = 1;
  let model = "claude-opus-4-6";
  let branch = "";
  let taskFilter: number[] | null = null;
  let dryRun = false;
  let verbose = false;
  let skipValidation = false;
  let skipSmoke = false;
  let skipQA = false;
  let noFixer = false;
  let fixerPatience = 3;
  let noTui = false;

  for (const arg of args) {
    if (arg === "run") continue;
    if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, Math.min(5, parseInt(arg.slice("--concurrency=".length), 10)));
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg.startsWith("--branch=")) {
      branch = arg.slice("--branch=".length);
    } else if (arg.startsWith("--tasks=")) {
      taskFilter = arg.slice("--tasks=".length).split(",").map(s => parseInt(s.trim(), 10));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--skip-validation") {
      skipValidation = true;
    } else if (arg === "--skip-smoke") {
      skipSmoke = true;
    } else if (arg === "--skip-qa") {
      skipQA = true;
    } else if (arg === "--no-fixer") {
      noFixer = true;
    } else if (arg.startsWith("--fixer-patience=")) {
      fixerPatience = Math.max(1, parseInt(arg.slice("--fixer-patience=".length), 10));
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

  return { projectPath, concurrency, model, branch, taskFilter, dryRun, verbose, skipValidation, skipSmoke, skipQA, noFixer, fixerPatience, noTui };
}

// ─── Startup Checks ─────────────────────────────────────────────────────

function checkPrereqs(args: CLIArgs): void {
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

  // Ensure repo .gitignore has ephemeral patterns
  const repoGitignore = path.resolve(".gitignore");
  if (fs.existsSync(repoGitignore)) {
    const content = fs.readFileSync(repoGitignore, "utf-8");
    const additions: string[] = [];
    if (!content.includes(".brief-t")) additions.push(".brief-t*.md");
    if (!content.includes(".memory-entry")) additions.push(".memory-entry.md");
    if (additions.length > 0) {
      fs.appendFileSync(repoGitignore, "\n" + additions.join("\n") + "\n", "utf-8");
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  setForcePipeMode(args.noTui);
  checkPrereqs(args);
  ensureGitignores(args.projectPath);

  const slug = path.basename(args.projectPath);
  const manifestPath = path.join(args.projectPath, "manifest.md");
  const designPath = path.join(args.projectPath, "design.md");

  // Parse manifest
  const tasks = parseManifest(manifestPath);
  if (tasks.length === 0) die("No tasks found in manifest.");

  // Apply task filter
  let filteredTasks = tasks;
  if (args.taskFilter) {
    const filterSet = new Set(args.taskFilter);
    filteredTasks = tasks.filter(t => filterSet.has(t.id));
    if (filteredTasks.length === 0) die("No tasks match the filter.");
    // Adjust: tasks not in filter that are deps should be treated as done
    for (const t of filteredTasks) {
      t.dependsOn = t.dependsOn.filter(d => filterSet.has(d));
      if (t.dependsOn.length === 0 && t.status === "blocked") {
        t.status = "queued";
      }
    }
  }

  // Resolve dependency layers
  const layers = topologicalSort(filteredTasks);

  // Dry-run: show graph and exit
  if (args.dryRun) {
    console.log("\n\x1b[1mDependency Layers:\x1b[0m\n");
    for (const layer of layers) {
      const taskNames = layer.taskIds
        .map(id => {
          const t = filteredTasks.find(t => t.id === id);
          return t ? `T${t.id}: ${t.title}` : `T${id}`;
        })
        .join(", ");
      console.log(`  Layer ${layer.layerIndex}: ${taskNames}`);
    }
    console.log(`\n  Total: ${filteredTasks.length} tasks, ${layers.length} layers`);
    console.log(`  Max parallelism: ${Math.max(...layers.map(l => l.taskIds.length))}\n`);
    process.exit(0);
  }

  // Read config.json if exists
  const configPath = path.join(args.projectPath, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.concurrency && !process.argv.some(a => a.startsWith("--concurrency"))) {
        args.concurrency = config.concurrency;
      }
      if (config.branch && !process.argv.some(a => a.startsWith("--branch"))) {
        args.branch = config.branch;
      }
      if (config.models?.implementation?.model && !process.argv.some(a => a.startsWith("--model"))) {
        args.model = config.models.implementation.model;
      }
    } catch {
      log("\x1b[33mWarning: Could not parse config.json\x1b[0m");
    }
  }

  // Startup cleanup
  cleanupStaleWorktrees(slug, args.verbose);

  // Resume detection
  const previousProgress = readProgress(args.projectPath);
  const gitCompleted = detectCompletedFromGitLog(args.branch, filteredTasks, args.verbose);

  for (const t of filteredTasks) {
    if (previousProgress.has(t.id) || gitCompleted.has(t.id)) {
      t.status = "done";
      t.completedAt = previousProgress.get(t.id) || new Date().toISOString();
    }
  }

  // Unblock tasks whose deps are all done
  function updateStatuses(): void {
    const taskById = new Map(filteredTasks.map(t => [t.id, t]));
    for (const t of filteredTasks) {
      if (t.status === "blocked") {
        const allDepsDone = t.dependsOn.every(depId => {
          const dep = taskById.get(depId);
          return dep?.status === "done";
        });
        if (allDepsDone) t.status = "queued";
      }
    }
  }
  updateStatuses();

  // Setup feature branch
  setupFeatureBranch(args.branch, args.verbose);

  // Provider
  const provider = createProvider("claude");

  // Active promises
  const activePromises = new Map<number, Promise<void>>();
  let shuttingDown = false;

  // Dashboard interval
  if (isTTY()) process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN);
  const dashboardInterval = setInterval(() => {
    renderStatus(filteredTasks, args.projectPath);
  }, 1000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    shuttingDown = true;
    log("\n\x1b[33mShutting down... waiting for running tasks (10s timeout)\x1b[0m");

    // Kill running agents
    for (const t of filteredTasks) {
      if (t.status === "running" && t.process) {
        t.process.kill("SIGTERM");
      }
    }

    // Kill integration gate processes
    for (const proc of gateCleanupProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }

    setTimeout(() => {
      clearInterval(dashboardInterval);
      if (isTTY()) process.stdout.write(SHOW_CURSOR);
      cleanupAllWorktrees(filteredTasks, slug, args.branch, args.verbose);
      writeProgress(filteredTasks, args.projectPath);
      process.exit(1);
    }, 10000);
  });

  // ─── Main Loop ──────────────────────────────────────────────────────

  function spawnTask(task: Task): void {
    task.status = "running";
    task.startedAt = new Date().toISOString();

    let wp: string;
    let child: ReturnType<typeof spawnAgent>;
    try {
      wp = createWorktree(slug, task.id, args.branch, args.verbose);
      task.worktreePath = wp;

      const brief = buildBrief(task, filteredTasks, args.projectPath, designPath, manifestPath, args.branch);
      child = spawnAgent(task, brief, provider, args.model, wp, args.projectPath, args.verbose);
      task.process = child;
    } catch (e: unknown) {
      task.status = "failed";
      task.stage = "";
      task.lastLine = `[SETUP FAILED] ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
      cleanupWorktree(slug, task.id, args.branch, args.verbose);
      writeProgress(filteredTasks, args.projectPath);
      updateStatuses();
      return;
    }

    const promise = new Promise<void>((resolve) => {
      child.on("close", async (code) => {
        if (code === 0) {
          try {
            // Read memory entry from worktree
            const memEntryPath = path.join(wp, ".memory-entry.md");
            let memBody = "";
            if (fs.existsSync(memEntryPath)) {
              memBody = fs.readFileSync(memEntryPath, "utf-8");
            }

            // Squash merge
            task.stage = "Merging";
            await squashMerge(task.id, slug, args.branch, task.commitMessage, args.verbose);

            // Append memory AFTER successful merge
            if (memBody) {
              await appendMemoryEntry(args.projectPath, task.id, task.title, memBody);
            }

            task.status = "done";
            task.stage = "";
            task.completedAt = new Date().toISOString();
          } catch (e: unknown) {
            task.status = "failed";
            task.stage = "";
            task.lastLine = `[MERGE FAILED] ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`;
          }
        } else {
          task.status = "failed";
          task.stage = "";
          task.lastLine = task.lastLine || `[EXIT ${code}]`;
        }

        // Cleanup worktree always
        cleanupWorktree(slug, task.id, args.branch, args.verbose);
        writeProgress(filteredTasks, args.projectPath);
        updateStatuses();
        activePromises.delete(task.id);
        resolve();
      });
    });

    activePromises.set(task.id, promise);
  }

  // Loop until all tasks are done/failed or stuck
  while (!shuttingDown) {
    updateStatuses();

    const runningTasks = filteredTasks.filter(t => t.status === "running");
    const queuedTasks = filteredTasks.filter(t => t.status === "queued");
    const blockedTasks = filteredTasks.filter(t => t.status === "blocked");
    const doneTasks = filteredTasks.filter(t => t.status === "done");
    const failedTasks = filteredTasks.filter(t => t.status === "failed");

    // Check completion
    if (runningTasks.length === 0 && queuedTasks.length === 0) {
      if (blockedTasks.length > 0) {
        log("\x1b[31mStuck: blocked tasks remain but nothing is running or queued.\x1b[0m");
        const taskById = new Map(filteredTasks.map(t => [t.id, t]));
        for (const t of blockedTasks) {
          const missingDeps = t.dependsOn.filter(d => {
            const dep = taskById.get(d);
            return dep && dep.status === "failed";
          });
          if (missingDeps.length > 0) {
            log(`  T${t.id} blocked by failed: ${missingDeps.map(d => `T${d}`).join(", ")}`);
          }
        }
      }
      break;
    }

    // Spawn queued tasks up to concurrency limit
    if (runningTasks.length < args.concurrency && queuedTasks.length > 0) {
      for (const task of queuedTasks) {
        if (runningTasks.length + activePromises.size >= args.concurrency) break;

        // Check file conflicts with running tasks
        const hasConflict = runningTasks.some(rt => hasFileConflict(task, rt));
        if (hasConflict) continue;

        spawnTask(task);
      }
    }

    writeProgress(filteredTasks, args.projectPath);

    // Wait a bit before next iteration
    await new Promise(r => setTimeout(r, 2000));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  // Wait for any remaining promises
  if (activePromises.size > 0) {
    await Promise.allSettled(activePromises.values());
  }

  // Stop task dashboard
  clearInterval(dashboardInterval);

  const done = filteredTasks.filter(t => t.status === "done").length;
  const failed = filteredTasks.filter(t => t.status === "failed").length;

  if (failed > 0) {
    // No gate — show cursor and print failure summary
    if (isTTY()) process.stdout.write(SHOW_CURSOR);
    console.log("");
    console.log(`\x1b[1mLiteboard Complete\x1b[0m`);
    console.log(`  \x1b[32m${done} done\x1b[0m, \x1b[31m${failed} failed\x1b[0m of ${filteredTasks.length} tasks`);
    console.log(`  Check logs at ${args.projectPath}/logs/ for failure details.`);
    process.exit(1);
  }

  // Integration gate: only run if ALL tasks succeeded
  if (done === filteredTasks.length && !args.skipValidation) {
    // Cursor stays hidden — gate dashboard takes over the screen
    const gateResult = await runIntegrationGate(process.cwd(), filteredTasks, {
      branch: args.branch,
      provider,
      model: args.model,
      skipSmoke: args.skipSmoke,
      skipQA: args.skipQA,
      noFixer: args.noFixer,
      fixerPatience: args.fixerPatience,
      verbose: args.verbose,
      projectDir: args.projectPath,
      designPath,
      manifestPath,
    });

    // Gate dashboard done — cursor restored by gate, print final summary
    console.log("");
    console.log(`\x1b[1mLiteboard Complete\x1b[0m`);
    console.log(`  \x1b[32mAll ${done} tasks merged\x1b[0m`);

    if (gateResult.finalSuccess) {
      console.log(`  \x1b[32mIntegration gate passed.\x1b[0m`);
      console.log(`  Branch \x1b[36m${args.branch}\x1b[0m is ready for PR.`);
    } else {
      console.log(`  \x1b[31mIntegration gate failed.\x1b[0m`);
      if (gateResult.failReason) {
        console.log(`  Reason: ${gateResult.failReason}`);
      }
      console.log(`  Check logs at ${args.projectPath}/logs/ for details.`);
      process.exit(2);
    }
  } else {
    // No gate — show cursor and print summary
    if (isTTY()) process.stdout.write(SHOW_CURSOR);
    console.log("");
    console.log(`\x1b[1mLiteboard Complete\x1b[0m`);
    console.log(`  \x1b[32mAll ${done} tasks merged\x1b[0m`);
    console.log(`  Branch \x1b[36m${args.branch}\x1b[0m is ready for PR.`);
  }

  process.exit(0);
}

main().catch(e => {
  if (isTTY()) process.stdout.write(SHOW_CURSOR);
  console.error(e);
  process.exit(1);
});
