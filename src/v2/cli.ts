#!/usr/bin/env node
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Session, Task, V2CLIArgs } from "./types.js";
import { parseManifest, parseSessions, resolveSessionDependencies } from "./parser.js";
import { parseV2Config } from "./config.js";
import { writeProgress, readProgress, detectCompletedFromGitLog } from "./progress.js";
import {
  setupFeatureBranch,
  createWorktree,
  cleanupWorktree,
  cleanupAllWorktrees,
  cleanupStaleWorktrees,
} from "./worktree.js";
import { squashMerge } from "./merger.js";
import { spawnSession } from "./spawn.js";
import { renderStatus, isTTY, setForcePipeMode, HIDE_CURSOR, SHOW_CURSOR, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "./dashboard.js";
import { git } from "./git.js";
import { artifactsDir } from "./paths.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.error(msg);
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────

function parseArgs(): V2CLIArgs {
  const args = process.argv.slice(2);

  if (args[0] && args[0] !== "run" && !args[0].startsWith("--")) {
    console.error(`\x1b[31mError:\x1b[0m Unknown subcommand: ${args[0]}`);
    console.error("Did you mean: liteboard-v2 run <project-path>");
    process.exit(1);
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`Usage: liteboard-v2 run <project-path-or-slug> [options]

Options:
  --spec=<path>           Path to design doc (auto-generates manifest if missing)
  --concurrency=<N>       Max parallel agents (default: 1)
  --branch=<name>         Feature branch name
  --tasks=<1,2,3>         Run specific task IDs only
  --dry-run               Parse and show execution plan only
  --verbose               Log all git commands to stderr
  --no-tui                Disable TUI dashboard (line-based output)`);
    process.exit(0);
  }

  const positional: string[] = [];
  let concurrency = 1;
  let branch = "";
  let specPath: string | undefined;
  let taskFilter: number[] | null = null;
  let dryRun = false;
  let verbose = false;
  let noTui = false;

  for (const arg of args) {
    if (arg === "run") continue;
    if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(1, parseInt(arg.slice("--concurrency=".length), 10) || 1);
    } else if (arg.startsWith("--spec=")) {
      specPath = arg.slice("--spec=".length);
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
    if (fs.existsSync(slugPath)) projectPath = slugPath;
  }
  projectPath = path.resolve(projectPath);

  if (!branch) {
    branch = `liteboard/${path.basename(projectPath)}`;
  }

  return { projectPath, specPath, concurrency, branch, taskFilter, dryRun, verbose, noTui };
}

// ─── Startup Checks ─────────────────────────────────────────────────────

function checkPrereqs(args: V2CLIArgs): void {
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
  if (!fs.existsSync(manifestPath) && !args.specPath) {
    die(`No manifest found at ${manifestPath}. Provide --spec=<design-doc> to auto-generate.`);
  }
}

// ─── Gitignore Management ───────────────────────────────────────────────

function ensureGitignores(projectDir: string): void {
  const logsDir = path.join(projectDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logsGi = path.join(logsDir, ".gitignore");
  if (!fs.existsSync(logsGi)) fs.writeFileSync(logsGi, "*\n", "utf-8");

  const artDir = artifactsDir(projectDir);
  if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });
  const artGi = path.join(artDir, ".gitignore");
  if (!fs.existsSync(artGi)) fs.writeFileSync(artGi, "*\n!.gitignore\n", "utf-8");
}

// ─── Manifest Generation ────────────────────────────────────────────────

function generateManifest(specPath: string, projectDir: string, config: ReturnType<typeof parseV2Config>): void {
  const manifestPath = path.join(projectDir, "manifest.md");
  const absSpec = path.resolve(specPath);
  if (!fs.existsSync(absSpec)) die(`Design doc not found: ${absSpec}`);

  log("No manifest found. Generating from spec...");
  const prompt = `Read the instructions in commands/manifest-agent.md. Generate a task manifest from the design doc at ${absSpec}. Write the manifest to ${manifestPath}.`;

  const result = execFileSync("claude", [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--model", config.agents.manifest.model,
    "--output-format", "text",
    "--max-turns", "30",
    "--disable-slash-commands",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 600_000,
  });

  if (!fs.existsSync(manifestPath)) {
    die(`Manifest agent did not produce ${manifestPath}. Agent output:\n${result.slice(0, 500)}`);
  }
  log(`Manifest generated: ${manifestPath}`);
}

// ─── Build Session Prompt ───────────────────────────────────────────────

function buildSessionPrompt(
  session: Session,
  manifestPath: string,
  artDir: string,
  config: ReturnType<typeof parseV2Config>,
): string {
  const subagentHints = [
    `- Explore sub-agents: model "${config.subagents.explore.model}"`,
    `- Plan Review sub-agents: model "${config.subagents.planReview.model}"`,
    `- Code Review sub-agents: model "${config.subagents.codeReview.model}"`,
  ].join("\n");

  return `Read the instructions in commands/session-agent.md and follow them exactly.

You are implementing **Session ${session.id}: ${session.focus}**.

Your tasks: ${session.tasks.map(t => `T${t.id} (${t.title})`).join(", ")}.

Manifest: \`${manifestPath}\`
Artifacts directory: \`${artDir}\`

Sub-agent model settings:
${subagentHints}

Write your session plan to: \`${artDir}/s${session.id}-session-plan.md\`
Write your memory entry to: \`${artDir}/s${session.id}-memory-entry.md\``;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  setForcePipeMode(args.noTui);

  const slug = path.basename(args.projectPath);
  const manifestPath = path.join(args.projectPath, "manifest.md");
  const logDir = path.join(args.projectPath, "logs");
  const artDir = artifactsDir(args.projectPath);

  // Load config
  const config = parseV2Config(args.projectPath);
  if (!process.argv.some(a => a.startsWith("--concurrency"))) {
    args.concurrency = config.concurrency;
  }
  if (config.branch && !process.argv.some(a => a.startsWith("--branch"))) {
    args.branch = config.branch;
  }

  checkPrereqs(args);
  ensureGitignores(args.projectPath);

  // Step 0: Generate manifest from spec if missing
  if (!fs.existsSync(manifestPath)) {
    if (!args.specPath) die("No manifest and no --spec provided.");
    generateManifest(args.specPath, args.projectPath, config);
  }

  // Parse manifest + sessions
  const allTasks = parseManifest(manifestPath);
  if (allTasks.length === 0) die("No tasks found in manifest.");

  let filteredTasks = allTasks;
  if (args.taskFilter) {
    const filterSet = new Set(args.taskFilter);
    filteredTasks = allTasks.filter(t => filterSet.has(t.id));
    if (filteredTasks.length === 0) die("No tasks match the filter.");
    for (const t of filteredTasks) {
      t.dependsOn = t.dependsOn.filter(d => filterSet.has(d));
      if (t.dependsOn.length === 0 && t.status === "blocked") t.status = "queued";
    }
  }

  const sessions = parseSessions(filteredTasks, fs.readFileSync(manifestPath, "utf-8"));
  const sessionDeps = resolveSessionDependencies(sessions);

  // Dry-run
  if (args.dryRun) {
    const totalTasks = sessions.reduce((sum, s) => sum + s.tasks.length, 0);
    console.log(`\nExecution Plan (concurrency=${args.concurrency})`);
    console.log(`  Project:  ${args.projectPath}`);
    console.log(`  Branch:   ${args.branch}`);
    console.log(`  Sessions: ${sessions.length}   Tasks: ${totalTasks}\n`);
    for (const s of sessions) {
      const deps = sessionDeps.get(s.id) ?? [];
      const depStr = deps.length > 0 ? ` (depends on: ${deps.join(", ")})` : "";
      console.log(`  S${s.id}: ${s.focus}${depStr}`);
      for (const t of s.tasks) {
        const tdd = t.tddPhase || "Exempt";
        console.log(`    T${t.id}: ${t.title}  [C:${t.complexity} ${tdd}]`);
      }
    }
    console.log(`\n  Agent: ${config.agents.session.provider}/${config.agents.session.model}`);
    process.exit(0);
  }

  // Resume detection
  cleanupStaleWorktrees(slug, args.verbose);
  const previousProgress = readProgress(args.projectPath);
  const gitCompleted = detectCompletedFromGitLog(args.branch, allTasks, args.verbose);

  for (const t of allTasks) {
    const entry = previousProgress.tasks.get(t.id);
    if (entry?.status === "needs_human") t.status = "needs_human";
    else if (entry?.status === "done") { t.status = "done"; t.completedAt = entry.completedAt; }
    else if (gitCompleted.has(t.id)) { t.status = "done"; t.completedAt = new Date().toISOString(); }
  }

  for (const s of sessions) {
    const entry = previousProgress.sessions.get(s.id);
    if (entry?.status === "needs_human") s.status = "needs_human";
    else if (entry?.status === "done") {
      s.status = "done";
      s.completedAt = entry.completedAt;
      for (const t of s.tasks) {
        if (t.status !== "done") { t.status = "done"; t.completedAt = entry.completedAt; }
      }
    }
  }

  // Status update function
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const taskById = new Map<number, Task>();
  for (const t of allTasks) taskById.set(t.id, t);

  function updateStatuses(): void {
    for (const s of sessions) {
      for (const t of s.tasks) {
        if (t.status === "blocked") {
          if (t.dependsOn.every(d => taskById.get(d)?.status === "done")) t.status = "queued";
        }
      }
    }
    for (const s of sessions) {
      if (s.status !== "queued" && s.status !== "blocked") continue;
      const deps = sessionDeps.get(s.id) ?? [];
      s.status = deps.every(d => sessionById.get(d)?.status === "done") ? "queued" : "blocked";
    }
  }
  updateStatuses();

  // Setup feature branch
  setupFeatureBranch(args.branch, args.verbose);

  // Clean per-run artifacts (keep decision history)
  if (fs.existsSync(artDir)) {
    for (const f of fs.readdirSync(artDir)) {
      if (f === ".gitignore") continue;
      try { fs.unlinkSync(path.join(artDir, f)); } catch {}
    }
  }

  // Dashboard
  if (isTTY()) process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  process.on("exit", () => {
    if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  });
  const dashboardInterval = setInterval(() => renderStatus(sessions, args.projectPath), 1000);
  renderStatus(sessions, args.projectPath);

  // Active promises + shutdown
  const activePromises = new Map<string, Promise<void>>();
  let shuttingDown = false;

  process.on("SIGINT", () => {
    shuttingDown = true;
    log("\n\x1b[33mShutting down... waiting for running sessions (10s timeout)\x1b[0m");
    for (const s of sessions) {
      if (s.status === "running" && s.process) s.process.kill("SIGTERM");
    }
    setTimeout(() => {
      clearInterval(dashboardInterval);
      if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      cleanupAllWorktrees(sessions, slug, args.branch, args.verbose, { preserveFailedBranches: true });
      writeProgress(sessions, allTasks, args.projectPath);
      process.exit(1);
    }, 10000);
  });

  // ─── Main Loop ──────────────────────────────────────────────────────

  while (!shuttingDown) {
    updateStatuses();

    const running = sessions.filter(s => s.status === "running");
    const queued = sessions.filter(s => s.status === "queued");

    // Check completion
    if (running.length === 0 && queued.length === 0) {
      if (activePromises.size > 0) {
        await Promise.race(activePromises.values());
        continue;
      }
      break;
    }

    // Spawn queued sessions up to concurrency
    for (const session of queued) {
      if (activePromises.size >= args.concurrency) break;

      session.status = "running";
      session.startedAt = new Date().toISOString();

      let wp: string;
      try {
        wp = createWorktree(slug, session.id, args.branch, args.verbose);
        session.worktreePath = wp;
        session.branchName = `${args.branch}-s${session.id}`;
      } catch (e) {
        session.status = "failed";
        session.lastLine = `[SETUP FAILED] ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
        continue;
      }

      const prompt = buildSessionPrompt(session, manifestPath, artDir, config);
      session.provider = config.agents.session.provider;

      // Build env for multi-provider support
      let providerEnv: Record<string, string> | undefined;
      if (config.agents.session.provider !== "claude") {
        providerEnv = { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" };
      }

      const child = spawnSession(
        session, prompt, config.agents.session.model,
        wp, logDir, args.verbose, providerEnv,
      );
      session.process = child;

      const promise = new Promise<void>((resolve) => {
        child.on("close", async (code) => {
          session.process = undefined;

          if (code === 0) {
            // Merge to feature branch
            try {
              session.stage = "Merging";
              await squashMerge(session, args.branch, args.verbose);
              session.status = "done";
              session.stage = "";
              session.completedAt = new Date().toISOString();
              cleanupWorktree(slug, session.id, args.branch, args.verbose, { preserveBranch: false });
            } catch (mergeErr) {
              // Merge failed — retry once
              if (session.attemptCount < 2) {
                session.attemptCount += 1;
                session.status = "queued";
                session.stage = "";
                session.lastLine = "";
                session.turnCount = 0;
                session.bytesReceived = 0;
                cleanupWorktree(slug, session.id, args.branch, args.verbose, { preserveBranch: false });
                log(`[retry] S${session.id} merge failed, retrying (attempt ${session.attemptCount})`);
              } else {
                session.status = "failed";
                session.stage = "";
                session.lastLine = `[MERGE FAILED] ${(mergeErr instanceof Error ? mergeErr.message : String(mergeErr)).slice(0, 100)}`;
                cleanupWorktree(slug, session.id, args.branch, args.verbose, { preserveBranch: true });
              }
            }
          } else {
            // Non-zero exit — retry once, then fail
            if (session.attemptCount < 2) {
              session.attemptCount += 1;
              session.status = "queued";
              session.stage = "";
              session.lastLine = "";
              session.turnCount = 0;
              session.bytesReceived = 0;
              cleanupWorktree(slug, session.id, args.branch, args.verbose, { preserveBranch: false });
              log(`[retry] S${session.id} exited ${code}, retrying (attempt ${session.attemptCount})`);
            } else {
              session.status = "failed";
              session.stage = "";
              session.lastLine = session.lastLine || `[EXIT ${code}]`;
              cleanupWorktree(slug, session.id, args.branch, args.verbose, { preserveBranch: true });
            }
          }

          writeProgress(sessions, allTasks, args.projectPath);
          updateStatuses();
          activePromises.delete(session.id);
          resolve();
        });
      });

      activePromises.set(session.id, promise);
    }

    writeProgress(sessions, allTasks, args.projectPath);
    await new Promise(r => setTimeout(r, 2000));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────

  if (activePromises.size > 0) await Promise.allSettled(activePromises.values());
  clearInterval(dashboardInterval);

  const done = sessions.filter(s => s.status === "done").length;
  const failed = sessions.filter(s => s.status === "failed").length;
  const totalTasks = sessions.reduce((sum, s) => sum + s.tasks.length, 0);

  if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  console.log("");
  console.log("\x1b[1mLiteboard v2 Complete\x1b[0m");

  if (failed > 0) {
    console.log(`  \x1b[32m${done} done\x1b[0m, \x1b[31m${failed} failed\x1b[0m of ${sessions.length} sessions (${totalTasks} tasks)`);
    console.log(`  Check logs at ${args.projectPath}/logs/ for failure details.`);
    process.exit(1);
  }

  console.log(`  \x1b[32mAll ${done} sessions merged (${totalTasks} tasks)\x1b[0m`);
  console.log(`  Branch \x1b[36m${args.branch}\x1b[0m is ready for PR.`);
  process.exit(0);
}

main().catch(e => {
  if (isTTY()) process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  console.error(e);
  process.exit(1);
});
