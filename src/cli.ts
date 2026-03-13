#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, CLIArgs } from "./types.js";
import { defaultModelConfig } from "./types.js";
import { parseManifest } from "./parser.js";
import { topologicalSort, hasFileConflict } from "./resolver.js";
import { writeProgress, readProgress, detectCompletedFromGitLog } from "./progress.js";
import { createProvider, validateOllamaBaseUrl, checkOllamaHealth, checkOllamaModel, pullOllamaModel } from "./provider.js";
import { parseProjectConfig, validateConfig, hasOllamaProvider, applyOllamaFallback } from "./config.js";
import {
  setupFeatureBranch,
  cleanupWorktree,
  cleanupAllWorktrees,
  cleanupStaleWorktrees,
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
  spawnTask as runTask,
  handleMergingTask,
  type TaskRunnerContext,
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
    if (!content.includes(".brief-t")) additions.push(".brief-t*.md");
    if (!content.includes(".memory-entry")) additions.push(".memory-entry.md");
    if (!content.includes(".qa-report")) additions.push(".qa-report.md");
    if (additions.length > 0) {
      fs.appendFileSync(repoGitignore, "\n" + additions.join("\n") + "\n", "utf-8");
    }
  }
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

  // Apply task filter
  // allTasks retains the full manifest for progress writes; filteredTasks drives scheduling.
  const allTasks = tasks;
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

  // Startup cleanup
  cleanupStaleWorktrees(slug, args.verbose);

  // Resume detection
  const previousProgress = readProgress(args.projectPath);
  const gitCompleted = detectCompletedFromGitLog(args.branch, allTasks, args.verbose);

  for (const t of allTasks) {
    const progressEntry = previousProgress.get(t.id);
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
  const qaReports = new Map<number, string>();
  let shuttingDown = false;

  function printQAReports(): void {
    if (qaReports.size === 0) return;
    console.log("");
    for (const [taskId, report] of qaReports) {
      const task = filteredTasks.find(t => t.id === taskId);
      const title = task?.title ?? "QA Validation";
      console.log(`\x1b[1mT${taskId}: ${title}\x1b[0m`);
      console.log(report);
    }
  }

  // ─── Task Runner Context ────────────────────────────────────────────────

  const ctx: TaskRunnerContext = {
    args,
    slug,
    filteredTasks,
    allTasks,
    designDoc,
    manifestContent,
    provider,
    projectConfig,
    activePromises,
    qaReports,
    updateStatuses,
  };

  // Startup validation: detect stale branches from previous runs and invoke triage
  {
    const existingBranches = new Set<string>();
    try {
      const branchList = git(["branch", "--list", `${args.branch}-t*`], { verbose: args.verbose });
      for (const line of branchList.split("\n")) {
        const name = line.trim().replace(/^\* /, "");
        if (name) existingBranches.add(name);
      }
    } catch {}

    for (const task of filteredTasks) {
      if (task.status === "done" || task.status === "needs_human") continue;
      const taskBranch = `${args.branch}-t${task.id}`;
      if (!existingBranches.has(taskBranch)) continue;

      // This task has a branch from a previous run but wasn't marked done
      log(`Stale branch detected for T${task.id}, invoking triage for recovery assessment...`);
      try {
        const context = await gatherDecisionContext(
          task, filteredTasks, args.branch, args.projectPath, args.concurrency,
          { stage: "startup_validation", exitCode: -1 },
        );
        const decision = await askTriage(context, args.projectPath, projectConfig);
        writeDecisionRecord(task.id, {
          timestamp: new Date().toISOString(),
          attemptNumber: context.state.attemptCount + 1,
          trigger: {
            stage: "startup_validation",
            errorSummary: "Stale branch from previous run",
          },
          decision,
        }, args.projectPath);
        await executeTriageAction(
          task, decision, context, slug, args.branch, args.projectPath, filteredTasks, args.verbose,
        );

        // Cleanup for terminal statuses only (cast needed: executeTriageAction may
        // have changed status back to "needs_human" despite earlier narrowing)
        const postTriageStatus = task.status as string;
        if (postTriageStatus === "needs_human" || postTriageStatus === "merging") {
          cleanupWorktree(slug, task.id, args.branch, args.verbose, { preserveBranch: true });
        }
      } catch (e) {
        log(`Startup triage failed for T${task.id}: ${e instanceof Error ? e.message : String(e)}`);
        // Don't block startup — let the task proceed normally
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
    renderStatus(filteredTasks, args.projectPath);
  }, 1000);
  renderStatus(filteredTasks, args.projectPath);

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

    setTimeout(() => {
      clearInterval(dashboardInterval);
      if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      cleanupAllWorktrees(filteredTasks, slug, args.branch, args.verbose, { preserveFailedBranches: true });
      writeProgress(allTasks, args.projectPath);
      process.exit(1);
    }, 10000);
  });

  // ─── Main Loop ──────────────────────────────────────────────────────

  // Loop until all tasks are done/failed or stuck
  while (!shuttingDown) {
    updateStatuses();

    const runningTasks = filteredTasks.filter(t => t.status === "running");
    const queuedTasks = filteredTasks.filter(t => t.status === "queued");
    const blockedTasks = filteredTasks.filter(t => t.status === "blocked");

    // Handle tasks in "merging" state (set by retry_merge_only or mark_done)
    const mergingTasks = filteredTasks.filter(
      t => t.status === "merging" && !activePromises.has(t.id),
    );
    for (const task of mergingTasks) {
      const mergePromise = handleMergingTask(ctx, task);
      activePromises.set(task.id, mergePromise);
    }

    // Check completion — nothing running, queued, or in-flight
    if (runningTasks.length === 0 && queuedTasks.length === 0) {
      // Wait for in-flight merge/triage promises before exiting
      if (activePromises.size > 0) {
        await Promise.race(activePromises.values());
        continue; // Re-check statuses after promise completes
      }

      if (blockedTasks.length > 0) {
        log("\x1b[31mStuck: blocked tasks remain but nothing is running or queued.\x1b[0m");
        const taskById = new Map(filteredTasks.map(t => [t.id, t]));
        for (const t of blockedTasks) {
          const failedDeps = t.dependsOn.filter(d => {
            const dep = taskById.get(d);
            return dep && (dep.status === "failed" || dep.status === "needs_human");
          });
          if (failedDeps.length > 0) {
            log(`  T${t.id} blocked by: ${failedDeps.map(d => {
              const dep = taskById.get(d);
              return `T${d} (${dep?.status})`;
            }).join(", ")}`);
          }
        }
      }
      break;
    }

    // Spawn queued tasks up to concurrency limit
    if (activePromises.size < args.concurrency && queuedTasks.length > 0) {
      const spawnedThisIteration: Task[] = [];
      for (const task of queuedTasks) {
        if (activePromises.size >= args.concurrency) break;

        // Check file conflicts with running tasks and those spawned earlier this iteration
        const hasConflict = [...runningTasks, ...spawnedThisIteration].some(rt => hasFileConflict(task, rt));
        if (hasConflict) continue;

        runTask(ctx, task);
        spawnedThisIteration.push(task);
      }
    }

    writeProgress(allTasks, args.projectPath);

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
  const needsHumanCount = filteredTasks.filter(t => t.status === "needs_human").length;

  if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  console.log("");
  console.log(`\x1b[1mLiteboard Complete\x1b[0m`);

  if (failed > 0 || needsHumanCount > 0) {
    let summary = `  \x1b[32m${done} done\x1b[0m`;
    if (failed > 0) summary += `, \x1b[31m${failed} failed\x1b[0m`;
    if (needsHumanCount > 0) summary += `, \x1b[33m${needsHumanCount} needs human\x1b[0m`;
    summary += ` of ${filteredTasks.length} tasks`;
    console.log(summary);

    if (failed > 0) {
      console.log(`  Check logs at ${args.projectPath}/logs/ for failure details.`);
    }
    if (needsHumanCount > 0) {
      console.log(`  ${needsHumanCount} task(s) need human intervention — see artifacts/t<N>-escalation.md`);
    }
    printQAReports();
    process.exit(1);
  }

  console.log(`  \x1b[32mAll ${done} tasks merged\x1b[0m`);
  console.log(`  Branch \x1b[36m${args.branch}\x1b[0m is ready for PR.`);
  printQAReports();

  process.exit(0);
}

main().catch(e => {
  if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  console.error(e);
  process.exit(1);
});
