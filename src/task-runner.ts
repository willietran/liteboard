import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
  Session,
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
import {
  buildSessionBrief,
  buildSessionArchitectBrief,
  buildSessionImplementationBrief,
} from "./brief.js";
import { git } from "./git.js";
import { artifactsDir } from "./paths.js";

// ─── Session Runner Context ───────────────────────────────────────────────────

export interface SessionRunnerContext {
  args: CLIArgs;
  slug: string;
  filteredSessions: Session[];
  allSessions: Session[];
  allTasks: Task[];
  designDoc: string;
  manifestContent: string;
  provider: Provider;
  projectConfig: ProjectConfig;
  activePromises: Map<string, Promise<void>>;
  qaReports: Map<string, string>;
  updateStatuses: () => void;
  sessionDeps: Map<string, string[]>;
}

// ─── Module-Level State ──────────────────────────────────────────────────────

/**
 * Pre-decided triage results from stall callbacks. When the stall callback
 * kills a process, it stores the decision here. handleFinalClose checks
 * this map to execute the decision without re-triaging.
 */
const pendingStallDecisions = new Map<string, {
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

// ─── invokeTriageForSession ───────────────────────────────────────────────────

export async function invokeTriageForSession(
  ctx: SessionRunnerContext,
  session: Session,
  stage: FailureStage,
  exitCode: number,
  errorClass?: ErrorClass,
): Promise<void> {
  const context = await gatherDecisionContext(
    session, ctx.filteredSessions, ctx.args.branch, ctx.args.projectPath, ctx.args.concurrency,
    { stage, exitCode, errorClass },
  );
  const decision = await askTriage(context, ctx.args.projectPath, ctx.projectConfig);
  writeDecisionRecord(session.id, {
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
    session, decision, context, ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredSessions, ctx.args.verbose,
  );
}

// ─── cleanupAfterTriage ──────────────────────────────────────────────────────

export function cleanupAfterTriage(ctx: SessionRunnerContext, session: Session): void {
  switch (session.status) {
    case "queued":
      // Re-queued by triage (retry_from_scratch cleaned worktree+branch;
      // resume_from_branch/reuse_plan keep worktree). Don't clean up.
      break;
    case "merging":
      // retry_merge_only or mark_done — clean worktree, keep branch for merge
      cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: true });
      break;
    case "needs_human":
      // escalate — clean worktree, keep branch for recovery
      cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: true });
      break;
    case "done":
      // skip_and_continue — clean worktree and branch
      cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: false });
      break;
    case "failed":
      // invokeTriageForSession threw — fall back to standard failure cleanup
      cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: true });
      break;
    // "running" (extend_timeout) — no cleanup, process still alive
  }
}

// ─── handleStallCallback ─────────────────────────────────────────────────────

export async function handleStallCallback(ctx: SessionRunnerContext, session: Session): Promise<"keep" | "kill"> {
  try {
    const context = await gatherDecisionContext(
      session, ctx.filteredSessions, ctx.args.branch, ctx.args.projectPath, ctx.args.concurrency,
      { stage: "stall", exitCode: -1, errorClass: "stall" },
    );
    const decision = await askTriage(context, ctx.args.projectPath, ctx.projectConfig);
    writeDecisionRecord(session.id, {
      timestamp: new Date().toISOString(),
      attemptNumber: context.state.attemptCount + 1,
      trigger: {
        stage: "stall",
        errorClass: "stall",
        errorSummary: session.lastLine || "Stall detected",
      },
      decision,
    }, ctx.args.projectPath);

    if (decision.action === "extend_timeout") {
      await executeTriageAction(
        session, decision, context, ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredSessions, ctx.args.verbose,
      );
      return "keep";
    }

    // For all other actions, store decision for handleFinalClose
    pendingStallDecisions.set(session.id, { decision, context });
    return "kill";
  } catch {
    // Triage failed — fall back to kill, let handleFinalClose handle normally
    return "kill";
  }
}

// ─── trySpawnSessionPhase ─────────────────────────────────────────────────────

type AgentRole = "architect" | "implementation" | "qa";

/**
 * Spawns an agent for the given role. Returns the ChildProcess on success,
 * or null if spawning failed (session is marked failed and cleaned up).
 */
function trySpawnSessionPhase(
  ctx: SessionRunnerContext,
  session: Session,
  wp: string,
  role: AgentRole,
  buildBriefFn: () => string,
  onStall: (s: Session) => Promise<"keep" | "kill">,
): ChildProcess | null {
  session.provider = ctx.args.models[role].provider;
  try {
    const brief = buildBriefFn();
    const env = getProviderEnv(ctx.args.models[role].provider, ctx.args.ollama);
    const child = spawnAgent(
      session, brief, ctx.provider, ctx.args.models[role].model,
      wp, ctx.args.projectPath, ctx.args.verbose, env, onStall,
    );
    session.process = child;
    return child;
  } catch (e: unknown) {
    session.status = "failed";
    session.stage = "";
    session.lastLine = `[SETUP FAILED] ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose);
    writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
    ctx.updateStatuses();
    return null;
  }
}

// ─── handleFinalClose ────────────────────────────────────────────────────────

/** Shared close handler for the final phase (implementation or QA). */
async function handleFinalClose(
  ctx: SessionRunnerContext,
  session: Session,
  code: number | null,
  resolve: () => void,
): Promise<void> {
  // ── Check for pre-decided stall triage ──
  const stallResult = pendingStallDecisions.get(session.id);
  if (stallResult) {
    pendingStallDecisions.delete(session.id);
    await executeTriageAction(
      session, stallResult.decision, stallResult.context,
      ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredSessions, ctx.args.verbose,
    );
    if (session.tasks.every(t => t.type === "qa")) {
      const qaReportPath = path.join(artifactsDir(ctx.args.projectPath), `s${session.id}-qa-report.md`);
      if (fs.existsSync(qaReportPath)) {
        ctx.qaReports.set(session.id, fs.readFileSync(qaReportPath, "utf-8"));
      }
    }
    cleanupAfterTriage(ctx, session);
    writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
    ctx.updateStatuses();
    ctx.activePromises.delete(session.id);
    resolve();
    return;
  }

  // ── Happy path: exit code 0 ──
  if (code === 0) {
    try {
      // Read memory entry from artifacts directory
      const memEntryPath = path.join(artifactsDir(ctx.args.projectPath), `s${session.id}-memory-entry.md`);
      let memBody = "";
      if (fs.existsSync(memEntryPath)) {
        memBody = fs.readFileSync(memEntryPath, "utf-8");
      }

      // Check if session produced any changes to merge
      const branchName = session.branchName ?? `${ctx.args.branch}-s${session.id}`;
      let hasDiff = true;
      try {
        git(["diff", "--quiet", ctx.args.branch, branchName], { verbose: ctx.args.verbose });
        hasDiff = false; // exit 0 = no diff
      } catch {
        // exit 1 = has diff (expected for implementation sessions)
      }

      if (!hasDiff) {
        // No changes to merge (QA passed clean, or edge case)
        if (memBody) {
          await appendMemoryEntry(ctx.args.projectPath, session.id, session.focus, memBody);
        }
        session.status = "done";
        session.stage = "";
        session.completedAt = new Date().toISOString();
      } else {
        // Normal merge path
        session.stage = "Merging";
        await squashMerge(session, ctx.args.branch, ctx.args.verbose);

        // Append memory AFTER successful merge
        if (memBody) {
          await appendMemoryEntry(ctx.args.projectPath, session.id, session.focus, memBody);
        }

        session.status = "done";
        session.stage = "";
        session.completedAt = new Date().toISOString();
      }
    } catch (mergeErr) {
      // Merge failed — invoke triage
      try {
        const mergeInfo = classifyMergeError(mergeErr);
        await invokeTriageForSession(ctx, session, mergeInfo.stage, 1, mergeInfo.errorClass);
      } catch (triageErr) {
        // Triage itself failed — fall back to marking session failed
        session.status = "failed";
        session.stage = "";
        session.lastLine = `[MERGE FAILED] ${(mergeErr instanceof Error ? mergeErr.message : String(mergeErr)).slice(0, 100)}`;
        console.error(`[triage] Triage failed for S${session.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
      }
    }
  } else {
    // ── Non-zero exit — invoke triage ──
    try {
      await invokeTriageForSession(ctx, session, "implementation", code ?? -1);
    } catch (triageErr) {
      // Triage itself failed — fall back to marking session failed
      session.status = "failed";
      session.stage = "";
      session.lastLine = session.lastLine || `[EXIT ${code}]`;
      console.error(`[triage] Triage failed for S${session.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
    }
  }

  // Capture QA report from artifacts directory
  if (session.tasks.every(t => t.type === "qa")) {
    const qaReportPath = path.join(artifactsDir(ctx.args.projectPath), `s${session.id}-qa-report.md`);
    if (fs.existsSync(qaReportPath)) {
      ctx.qaReports.set(session.id, fs.readFileSync(qaReportPath, "utf-8"));
    }
  }

  // Cleanup based on resulting status
  if (session.status === "done") {
    cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: false });
  } else {
    cleanupAfterTriage(ctx, session);
  }

  writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
  ctx.updateStatuses();
  ctx.activePromises.delete(session.id);
  resolve();
}

// ─── spawnSession ─────────────────────────────────────────────────────────────

export function spawnSession(ctx: SessionRunnerContext, session: Session): void {
  session.status = "running";
  session.startedAt = new Date().toISOString();

  let wp: string;
  try {
    if (session.worktreePath && fs.existsSync(session.worktreePath)) {
      // Reuse existing worktree (set by resume_from_branch or reuse_plan)
      wp = session.worktreePath;
    } else {
      wp = createWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose);
      session.worktreePath = wp;
      session.branchName = `${ctx.args.branch}-s${session.id}`;
    }
  } catch (e: unknown) {
    session.status = "failed";
    session.stage = "";
    session.lastLine = `[SETUP FAILED] ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose);
    writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
    ctx.updateStatuses();
    return;
  }

  const onStall = (s: Session) => handleStallCallback(ctx, s);

  // QA sessions: single-phase spawn (no architect)
  if (session.tasks.every(t => t.type === "qa")) {
    const child = trySpawnSessionPhase(ctx, session, wp, "qa",
      () => buildSessionBrief(session, ctx.allTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
      onStall,
    );
    if (!child) return;

    const promise = new Promise<void>((resolve) => {
      child.on("close", (code) => handleFinalClose(ctx, session, code, resolve));
    });
    ctx.activePromises.set(session.id, promise);
    return;
  }

  // Low-complexity sessions: single-phase implementation (no architect)
  if (session.complexity <= LOW_COMPLEXITY_THRESHOLD) {
    const child = trySpawnSessionPhase(ctx, session, wp, "implementation",
      () => buildSessionImplementationBrief(session, ctx.allTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
      onStall,
    );
    if (!child) return;

    const promise = new Promise<void>((resolve) => {
      child.on("close", (code) => handleFinalClose(ctx, session, code, resolve));
    });
    ctx.activePromises.set(session.id, promise);
    return;
  }

  // Skip architect phase if flagged by triage (resume_from_branch, reuse_plan)
  if (session.skipArchitect) {
    session.skipArchitect = false; // One-shot: clear after use
    const child = trySpawnSessionPhase(ctx, session, wp, "implementation",
      () => buildSessionImplementationBrief(session, ctx.allTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
      onStall,
    );
    if (!child) return;

    const promise = new Promise<void>((resolve) => {
      child.on("close", (code) => handleFinalClose(ctx, session, code, resolve));
    });
    ctx.activePromises.set(session.id, promise);
    return;
  }

  // Non-QA, higher-complexity sessions: two-phase architect → implementation
  const architectChild = trySpawnSessionPhase(ctx, session, wp, "architect",
    () => buildSessionArchitectBrief(session, ctx.allTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
    onStall,
  );
  if (!architectChild) return;

  const promise = new Promise<void>((resolve) => {
    architectChild.on("close", async (architectCode) => {
      // Check for pre-decided stall triage
      const stallResult = pendingStallDecisions.get(session.id);
      if (stallResult) {
        pendingStallDecisions.delete(session.id);
        await executeTriageAction(
          session, stallResult.decision, stallResult.context,
          ctx.slug, ctx.args.branch, ctx.args.projectPath, ctx.filteredSessions, ctx.args.verbose,
        );
        cleanupAfterTriage(ctx, session);
        writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
        ctx.updateStatuses();
        ctx.activePromises.delete(session.id);
        resolve();
        return;
      }

      if (architectCode !== 0) {
        // Architect failed — invoke triage
        try {
          await invokeTriageForSession(ctx, session, "architect", architectCode ?? -1);
        } catch (triageErr) {
          session.status = "failed";
          session.stage = "";
          session.lastLine = `[ARCHITECT EXIT ${architectCode}]`;
          console.error(`[triage] Triage failed for S${session.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
        }
        cleanupAfterTriage(ctx, session);
        writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
        ctx.updateStatuses();
        ctx.activePromises.delete(session.id);
        resolve();
        return;
      }

      // Verify plan was written
      const planPath = path.join(artifactsDir(ctx.args.projectPath), `s${session.id}-session-plan.md`);
      if (!fs.existsSync(planPath)) {
        try {
          await invokeTriageForSession(ctx, session, "plan_validation", 0, "missing_artifact");
        } catch (triageErr) {
          session.status = "failed";
          session.stage = "";
          session.lastLine = "[ARCHITECT] No session plan produced";
          console.error(`[triage] Triage failed for S${session.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
        }
        cleanupAfterTriage(ctx, session);
        writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
        ctx.updateStatuses();
        ctx.activePromises.delete(session.id);
        resolve();
        return;
      }

      // ── Architect succeeded — proceed to implementation ──
      // Reset session state for phase 2 handoff
      session.stage = "";
      session.lastLine = "";
      session.bytesReceived = 0;
      session.turnCount = 0;

      // Rename architect log and brief for debugging
      const logDir = path.join(ctx.args.projectPath, "logs");
      try { fs.renameSync(path.join(logDir, `s${session.id}.jsonl`), path.join(logDir, `s${session.id}-architect.jsonl`)); } catch {}
      const artPath = artifactsDir(ctx.args.projectPath);
      try { fs.renameSync(path.join(artPath, `s${session.id}-brief.md`), path.join(artPath, `s${session.id}-architect-brief.md`)); } catch {}

      // Phase 2: Implementation
      const implChild = trySpawnSessionPhase(ctx, session, wp, "implementation",
        () => buildSessionImplementationBrief(session, ctx.allTasks, ctx.args.projectPath, ctx.designDoc, ctx.manifestContent, ctx.args.branch, ctx.args.models, ctx.provider),
        onStall,
      );
      if (!implChild) {
        ctx.activePromises.delete(session.id);
        resolve();
        return;
      }

      implChild.on("close", (code) => handleFinalClose(ctx, session, code, resolve));
    });
  });

  ctx.activePromises.set(session.id, promise);
}

// ─── handleMergingSession ─────────────────────────────────────────────────────

/** Handles sessions in "merging" state (set by retry_merge_only or mark_done). */
export async function handleMergingSession(ctx: SessionRunnerContext, session: Session): Promise<void> {
  try {
    session.stage = "Merging";

    const memEntryPath = path.join(artifactsDir(ctx.args.projectPath), `s${session.id}-memory-entry.md`);
    let memBody = "";
    if (fs.existsSync(memEntryPath)) {
      memBody = fs.readFileSync(memEntryPath, "utf-8");
    }

    await squashMerge(session, ctx.args.branch, ctx.args.verbose);

    if (memBody) {
      await appendMemoryEntry(ctx.args.projectPath, session.id, session.focus, memBody);
    }

    session.status = "done";
    session.stage = "";
    session.completedAt = new Date().toISOString();
    // Clean up session branch (worktree already gone)
    cleanupWorktree(ctx.slug, session.id, ctx.args.branch, ctx.args.verbose, { preserveBranch: false });
  } catch (mergeErr) {
    // Merge failed again — invoke triage
    session.stage = ""; // Clear stale "Merging" stage before triage changes status
    try {
      const mergeInfo = classifyMergeError(mergeErr);
      await invokeTriageForSession(ctx, session, mergeInfo.stage, 1, mergeInfo.errorClass);
    } catch (triageErr) {
      session.status = "failed";
      session.lastLine = `[MERGE FAILED] ${(mergeErr instanceof Error ? mergeErr.message : String(mergeErr)).slice(0, 100)}`;
      console.error(`[triage] Triage failed for S${session.id}: ${triageErr instanceof Error ? triageErr.message : String(triageErr)}`);
    }
    cleanupAfterTriage(ctx, session);
  }

  writeProgress(ctx.filteredSessions, ctx.allTasks, ctx.args.projectPath);
  ctx.updateStatuses();
  ctx.activePromises.delete(session.id);
}
