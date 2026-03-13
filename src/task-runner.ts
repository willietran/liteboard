import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
  Task,
  CLIArgs,
  FailureStage,
  ErrorClass,
  TriageDecision,
  DecisionContext,
  Provider,
  ProjectConfig,
} from "./types.js";
import { LOW_COMPLEXITY_THRESHOLD } from "./types.js";
import { writeProgress } from "./progress.js";
import { appendMemoryEntry } from "./memory.js";
import { getProviderEnv } from "./provider.js";
import { createWorktree, cleanupWorktree } from "./worktree.js";
import { squashMerge } from "./merger.js";
import { spawnAgent } from "./spawner.js";
import {
  gatherDecisionContext,
  askTriage,
  executeTriageAction,
  writeDecisionRecord,
} from "./triage.js";
import { buildBrief, buildArchitectBrief, buildImplementationBrief } from "./brief.js";
import { git } from "./git.js";
import { artifactsDir } from "./paths.js";

// ─── Task Runner Context ─────────────────────────────────────────────────────

export interface TaskRunnerContext {
  args: CLIArgs;
  slug: string;
  filteredTasks: Task[];
  allTasks: Task[];
  designDoc: string;
  manifestContent: string;
  provider: Provider;
  projectConfig: ProjectConfig;
  activePromises: Map<number, Promise<void>>;
  qaReports: Map<number, string>;
  updateStatuses: () => void;
}

// ─── Module-Level State ──────────────────────────────────────────────────────

/**
 * Pre-decided triage results from stall callbacks. When the stall callback
 * kills a process, it stores the decision here. handleFinalClose checks
 * this map to execute the decision without re-triaging.
 */
const pendingStallDecisions = new Map<number, {
  decision: TriageDecision;
  context: DecisionContext;
}>();

// ─── classifyMergeError ──────────────────────────────────────────────────────

export function classifyMergeError(error: unknown): { stage: FailureStage; errorClass: ErrorClass } {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("Rebase conflicts")) return { stage: "merge_conflict", errorClass: "git_conflict" };
  if (msg.includes("Test suite")) return { stage: "test_validation", errorClass: "test_failure" };
  if (msg.includes("Type check")) return { stage: "build_validation", errorClass: "type_error" };
  if (msg.includes("Build validation")) return { stage: "build_validation", errorClass: "build_failure" };
  if (msg.includes("Dependency installation")) return { stage: "build_validation", errorClass: "install_failure" };
  return { stage: "merge_conflict", errorClass: "unknown" };
}

// ─── invokeTriageForTask ─────────────────────────────────────────────────────

export async function invokeTriageForTask(
  ctx: TaskRunnerContext,
  task: Task,
  stage: FailureStage,
  exitCode: number,
  errorClass?: ErrorClass,
): Promise<void> {
  const context = await gatherDecisionContext(
    task, ctx.filteredTasks, ctx.args.branch, ctx.args.projectPath, ctx.args.concurrency,
    { stage, exitCode, errorClass },
  );
  const decision = await askTriage(context, ctx.args.projectPath, ctx.projectConfig);
  writeDecisionRecord(task.id, {
    timestamp: new Date().toISOString(),
    attemptNumber: context.state.attemptCount + 1,
    trigger: {
      stage,
      errorClass,
      errorSummary: (context.trigger.errorTail || "").split("\n")[0].slice(0, 100),
    },
    decision,
  }, ctx.args.projectPath);
  await executeTriageAction(
    task, decision, context, ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredTasks, ctx.args.verbose,
  );
}

// ─── cleanupAfterTriage ──────────────────────────────────────────────────────

export function cleanupAfterTriage(ctx: TaskRunnerContext, task: Task): void {
  switch (task.status) {
    case "queued":
      // Re-queued by triage (retry_from_scratch cleaned worktree+branch;
      // resume_from_branch/reuse_plan keep worktree). Don't clean up.
      break;
    case "merging":
      // retry_merge_only or mark_done — clean worktree, keep branch for merge
      cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: true });
      break;
    case "needs_human":
      // escalate — clean worktree, keep branch for recovery
      cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: true });
      break;
    case "done":
      // skip_and_continue — clean worktree and branch
      cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: false });
      break;
    case "failed":
      // invokeTriageForTask threw — fall back to standard failure cleanup
      cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: true });
      break;
    // "running" (extend_timeout) — no cleanup, process still alive
  }
}

// ─── handleStallCallback ─────────────────────────────────────────────────────

export async function handleStallCallback(ctx: TaskRunnerContext, task: Task): Promise<"keep" | "kill"> {
  try {
    const context = await gatherDecisionContext(
      task, ctx.filteredTasks, ctx.args.branch, ctx.args.projectPath, ctx.args.concurrency,
      { stage: "stall", exitCode: -1, errorClass: "stall" },
    );
    const decision = await askTriage(context, ctx.args.projectPath, ctx.projectConfig);
    writeDecisionRecord(task.id, {
      timestamp: new Date().toISOString(),
      attemptNumber: context.state.attemptCount + 1,
      trigger: {
        stage: "stall",
        errorClass: "stall",
        errorSummary: task.lastLine || "Stall detected",
      },
      decision,
    }, ctx.args.projectPath);

    if (decision.action === "extend_timeout") {
      await executeTriageAction(
        task, decision, context, ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredTasks, ctx.args.verbose,
      );
      return "keep";
    }

    // For all other actions, store decision for handleFinalClose
    pendingStallDecisions.set(task.id, { decision, context });
    return "kill";
  } catch {
    // Triage failed — fall back to kill, let handleFinalClose handle normally
    return "kill";
  }
}

// ─── trySpawnPhase ───────────────────────────────────────────────────────────

type AgentRole = "architect" | "implementation" | "qa";

/**
 * Spawns an agent for the given role. Returns the ChildProcess on success,
 * or null if spawning failed (task is marked failed and cleaned up).
 */
function trySpawnPhase(
  ctx: TaskRunnerContext,
  task: Task,
  wp: string,
  role: AgentRole,
  buildBriefFn: () => string,
  onStall: (t: Task) => Promise<"keep" | "kill">,
): ChildProcess | null {
  task.provider = ctx.args.models[role].provider;
  try {
    const brief = buildBriefFn();
    const env = getProviderEnv(ctx.args.models[role].provider, ctx.args.ollama);
    const child = spawnAgent(
      task, brief, ctx.provider, ctx.args.models[role].model,
      wp, ctx.args.projectPath, ctx.args.verbose, env, onStall,
    );
    task.process = child;
    return child;
  } catch (e: unknown) {
    task.status = "failed";
    task.stage = "";
    task.lastLine = `[SETUP FAILED] ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose);
    writeProgress(ctx.allTasks, ctx.args.projectPath);
    ctx.updateStatuses();
    return null;
  }
}

// ─── handleFinalClose ────────────────────────────────────────────────────────

/** Shared close handler for the final phase (implementation or QA). */
async function handleFinalClose(
  ctx: TaskRunnerContext,
  task: Task,
  code: number | null,
  resolve: () => void,
): Promise<void> {
  // ── Check for pre-decided stall triage ──
  const stallResult = pendingStallDecisions.get(task.id);
  if (stallResult) {
    pendingStallDecisions.delete(task.id);
    await executeTriageAction(
      task, stallResult.decision, stallResult.context,
      ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredTasks, ctx.args.verbose,
    );
    if (task.type === "qa") {
      const qaReportPath = path.join(artifactsDir(ctx.args.projectPath), `t${task.id}-qa-report.md`);
      if (fs.existsSync(qaReportPath)) {
        ctx.qaReports.set(task.id, fs.readFileSync(qaReportPath, "utf-8"));
      }
    }
    cleanupAfterTriage(ctx, task);
    writeProgress(ctx.allTasks, ctx.args.projectPath);
    ctx.updateStatuses();
    ctx.activePromises.delete(task.id);
    resolve();
    return;
  }

  // ── Happy path: exit code 0 ──
  if (code === 0) {
    try {
      // Read memory entry from artifacts directory
      const memEntryPath = path.join(artifactsDir(ctx.args.projectPath), `t${task.id}-memory-entry.md`);
      let memBody = "";
      if (fs.existsSync(memEntryPath)) {
        memBody = fs.readFileSync(memEntryPath, "utf-8");
      }

      // Check if task produced any changes to merge
      let hasDiff = true;
      try {
        git(["diff", "--quiet", ctx.args.branch, `${ctx.args.branch}-t${task.id}`], { verbose: ctx.args.verbose });
        hasDiff = false; // exit 0 = no diff
      } catch {
        // exit 1 = has diff (expected for implementation tasks)
      }

      if (!hasDiff) {
        // No changes to merge (QA passed clean, or edge case)
        if (memBody) {
          await appendMemoryEntry(ctx.args.projectPath, task.id, task.title, memBody);
        }
        task.status = "done";
        task.stage = "";
        task.completedAt = new Date().toISOString();
      } else {
        // Normal merge path
        task.stage = "Merging";
        await squashMerge(task.id, ctx.args.branch, task.commitMessage, ctx.args.verbose);

        // Append memory AFTER successful merge
        if (memBody) {
          await appendMemoryEntry(ctx.args.projectPath, task.id, task.title, memBody);
        }

        task.status = "done";
        task.stage = "";
        task.completedAt = new Date().toISOString();
      }
    } catch (mergeErr) {
      // Merge failed — invoke triage
      try {
        const mergeInfo = classifyMergeError(mergeErr);
        await invokeTriageForTask(ctx, task, mergeInfo.stage, 0, mergeInfo.errorClass);
      } catch (triageErr) {
        // Triage itself failed — fall back to marking task failed
        task.status = "failed";
        task.stage = "";
        task.lastLine = `[MERGE FAILED] ${(mergeErr instanceof Error ? mergeErr.message : String(mergeErr)).slice(0, 100)}`;
        console.error(`[triage] Triage failed for T${task.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
      }
    }
  } else {
    // ── Non-zero exit — invoke triage ──
    try {
      await invokeTriageForTask(ctx, task, "implementation", code ?? -1);
    } catch (triageErr) {
      // Triage itself failed — fall back to marking task failed
      task.status = "failed";
      task.stage = "";
      task.lastLine = task.lastLine || `[EXIT ${code}]`;
      console.error(`[triage] Triage failed for T${task.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
    }
  }

  // Capture QA report from artifacts directory
  if (task.type === "qa") {
    const qaReportPath = path.join(artifactsDir(ctx.args.projectPath), `t${task.id}-qa-report.md`);
    if (fs.existsSync(qaReportPath)) {
      ctx.qaReports.set(task.id, fs.readFileSync(qaReportPath, "utf-8"));
    }
  }

  // Cleanup based on resulting status
  if (task.status === "done") {
    cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: false });
  } else {
    cleanupAfterTriage(ctx, task);
  }

  writeProgress(ctx.allTasks, ctx.args.projectPath);
  ctx.updateStatuses();
  ctx.activePromises.delete(task.id);
  resolve();
}

// ─── spawnTask ───────────────────────────────────────────────────────────────

export function spawnTask(ctx: TaskRunnerContext, task: Task): void {
  task.status = "running";
  task.startedAt = new Date().toISOString();

  let wp: string;
  try {
    if (task.worktreePath && fs.existsSync(task.worktreePath)) {
      // Reuse existing worktree (set by resume_from_branch or reuse_plan)
      wp = task.worktreePath;
    } else {
      wp = createWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose);
      task.worktreePath = wp;
    }
  } catch (e: unknown) {
    task.status = "failed";
    task.stage = "";
    task.lastLine = `[SETUP FAILED] ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose);
    writeProgress(ctx.allTasks, ctx.args.projectPath);
    ctx.updateStatuses();
    return;
  }

  const onStall = (t: Task) => handleStallCallback(ctx, t);

  // QA tasks: single-phase spawn (no architect)
  if (task.type === "qa") {
    const child = trySpawnPhase(ctx, task, wp, "qa",
      () => buildBrief(task, ctx.filteredTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
      onStall,
    );
    if (!child) return;

    const promise = new Promise<void>((resolve) => {
      child.on("close", (code) => handleFinalClose(ctx, task, code, resolve));
    });
    ctx.activePromises.set(task.id, promise);
    return;
  }

  // Low-complexity tasks: single-phase implementation (no architect)
  if (task.complexity <= LOW_COMPLEXITY_THRESHOLD) {
    const child = trySpawnPhase(ctx, task, wp, "implementation",
      () => buildImplementationBrief(task, ctx.filteredTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
      onStall,
    );
    if (!child) return;

    const promise = new Promise<void>((resolve) => {
      child.on("close", (code) => handleFinalClose(ctx, task, code, resolve));
    });
    ctx.activePromises.set(task.id, promise);
    return;
  }

  // Skip architect phase if flagged by triage (resume_from_branch, reuse_plan)
  if (task.skipArchitect) {
    task.skipArchitect = false; // One-shot: clear after use
    const child = trySpawnPhase(ctx, task, wp, "implementation",
      () => buildImplementationBrief(task, ctx.filteredTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
      onStall,
    );
    if (!child) return;

    const promise = new Promise<void>((resolve) => {
      child.on("close", (code) => handleFinalClose(ctx, task, code, resolve));
    });
    ctx.activePromises.set(task.id, promise);
    return;
  }

  // Non-QA, higher-complexity tasks: two-phase architect → implementation
  const architectChild = trySpawnPhase(ctx, task, wp, "architect",
    () => buildArchitectBrief(task, ctx.filteredTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
    onStall,
  );
  if (!architectChild) return;

  const promise = new Promise<void>((resolve) => {
    architectChild.on("close", async (architectCode) => {
      // Check for pre-decided stall triage
      const stallResult = pendingStallDecisions.get(task.id);
      if (stallResult) {
        pendingStallDecisions.delete(task.id);
        await executeTriageAction(
          task, stallResult.decision, stallResult.context,
          ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredTasks, ctx.args.verbose,
        );
        cleanupAfterTriage(ctx, task);
        writeProgress(ctx.allTasks, ctx.args.projectPath);
        ctx.updateStatuses();
        ctx.activePromises.delete(task.id);
        resolve();
        return;
      }

      if (architectCode !== 0) {
        // Architect failed — invoke triage
        try {
          await invokeTriageForTask(ctx, task, "architect", architectCode ?? -1);
        } catch (triageErr) {
          task.status = "failed";
          task.stage = "";
          task.lastLine = `[ARCHITECT EXIT ${architectCode}]`;
          console.error(`[triage] Triage failed for T${task.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
        }
        cleanupAfterTriage(ctx, task);
        writeProgress(ctx.allTasks, ctx.args.projectPath);
        ctx.updateStatuses();
        ctx.activePromises.delete(task.id);
        resolve();
        return;
      }

      // Verify plan was written
      const planPath = path.join(artifactsDir(ctx.args.projectPath), `t${task.id}-task-plan.md`);
      if (!fs.existsSync(planPath)) {
        try {
          await invokeTriageForTask(ctx, task, "plan_validation", 0, "missing_artifact");
        } catch (triageErr) {
          task.status = "failed";
          task.stage = "";
          task.lastLine = "[ARCHITECT] No task plan produced";
          console.error(`[triage] Triage failed for T${task.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
        }
        cleanupAfterTriage(ctx, task);
        writeProgress(ctx.allTasks, ctx.args.projectPath);
        ctx.updateStatuses();
        ctx.activePromises.delete(task.id);
        resolve();
        return;
      }

      // ── Architect succeeded — proceed to implementation ──
      // Reset task state for phase 2 handoff
      task.stage = "";
      task.lastLine = "";
      task.bytesReceived = 0;
      task.turnCount = 0;

      // Rename architect log and brief for debugging
      const logDir = path.join(ctx.args.projectPath, "logs");
      try { fs.renameSync(path.join(logDir, `t${task.id}.jsonl`), path.join(logDir, `t${task.id}-architect.jsonl`)); } catch {}
      const artPath = artifactsDir(ctx.args.projectPath);
      try { fs.renameSync(path.join(artPath, `t${task.id}-brief.md`), path.join(artPath, `t${task.id}-architect-brief.md`)); } catch {}

      // Phase 2: Implementation
      const implChild = trySpawnPhase(ctx, task, wp, "implementation",
        () => buildImplementationBrief(task, ctx.filteredTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
        onStall,
      );
      if (!implChild) {
        ctx.activePromises.delete(task.id);
        resolve();
        return;
      }

      implChild.on("close", (code) => handleFinalClose(ctx, task, code, resolve));
    });
  });

  ctx.activePromises.set(task.id, promise);
}

// ─── handleMergingTask ───────────────────────────────────────────────────────

/** Handles tasks in "merging" state (set by retry_merge_only or mark_done). */
export async function handleMergingTask(ctx: TaskRunnerContext, task: Task): Promise<void> {
  try {
    task.stage = "Merging";

    const memEntryPath = path.join(artifactsDir(ctx.args.projectPath), `t${task.id}-memory-entry.md`);
    let memBody = "";
    if (fs.existsSync(memEntryPath)) {
      memBody = fs.readFileSync(memEntryPath, "utf-8");
    }

    await squashMerge(task.id, ctx.args.branch, task.commitMessage, ctx.args.verbose);

    if (memBody) {
      await appendMemoryEntry(ctx.args.projectPath, task.id, task.title, memBody);
    }

    task.status = "done";
    task.stage = "";
    task.completedAt = new Date().toISOString();
    // Clean up task branch (worktree already gone)
    cleanupWorktree(ctx.slug, task.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: false });
  } catch (mergeErr) {
    // Merge failed again — invoke triage
    task.stage = ""; // Clear stale "Merging" stage before triage changes status
    try {
      const mergeInfo = classifyMergeError(mergeErr);
      await invokeTriageForTask(ctx, task, mergeInfo.stage, 1, mergeInfo.errorClass);
    } catch (triageErr) {
      task.status = "failed";
      task.lastLine = `[MERGE FAILED] ${(mergeErr instanceof Error ? mergeErr.message : String(mergeErr)).slice(0, 100)}`;
      console.error(`[triage] Triage failed for T${task.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
    }
    cleanupAfterTriage(ctx, task);
  }

  writeProgress(ctx.allTasks, ctx.args.projectPath);
  ctx.updateStatuses();
  ctx.activePromises.delete(task.id);
}
