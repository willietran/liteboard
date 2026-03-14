import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Session,
  SessionStatus,
  Task,
  TaskStatus,
  TriageDecision,
  DecisionContext,
  FailureStage,
  ErrorClass,
} from "../src/types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn() })),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

vi.mock("../src/progress.js", () => ({
  writeProgress: vi.fn(),
}));

vi.mock("../src/memory.js", () => ({
  appendMemoryEntry: vi.fn(),
}));

vi.mock("../src/provider.js", () => ({
  getProviderEnv: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(() => "/tmp/worktree"),
  cleanupWorktree: vi.fn(),
  recreateWorktreeFromBranch: vi.fn(() => "/tmp/worktree"),
}));

vi.mock("../src/merger.js", () => ({
  squashMerge: vi.fn(),
}));

vi.mock("../src/spawner.js", () => ({
  spawnAgent: vi.fn(),
  getRecentOutput: vi.fn(() => []),
  extendStallTimeout: vi.fn(),
}));

vi.mock("../src/triage.js", () => ({
  gatherDecisionContext: vi.fn(),
  askTriage: vi.fn(),
  executeTriageAction: vi.fn(),
  writeDecisionRecord: vi.fn(),
}));

vi.mock("../src/brief.js", () => ({
  buildSessionBrief: vi.fn(() => "session-brief"),
  buildSessionArchitectBrief: vi.fn(() => "architect-brief"),
  buildSessionImplementationBrief: vi.fn(() => "impl-brief"),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn(() => ""),
}));

vi.mock("../src/paths.js", () => ({
  artifactsDir: vi.fn((dir: string) => `${dir}/artifacts`),
}));

import {
  classifyMergeError,
  cleanupAfterTriage,
  handleStallCallback,
  handleMergingSession,
  invokeTriageForSession,
} from "../src/task-runner.js";
import type { SessionRunnerContext } from "../src/types.js";
import { writeProgress } from "../src/progress.js";
import { cleanupWorktree } from "../src/worktree.js";
import { squashMerge } from "../src/merger.js";
import { gatherDecisionContext, askTriage, executeTriageAction, writeDecisionRecord } from "../src/triage.js";

const mockSquashMerge = vi.mocked(squashMerge);

const mockCleanupWorktree = vi.mocked(cleanupWorktree);
const mockWriteProgress = vi.mocked(writeProgress);
const mockGatherDecisionContext = vi.mocked(gatherDecisionContext);
const mockAskTriage = vi.mocked(askTriage);
const mockExecuteTriageAction = vi.mocked(executeTriageAction);
const mockWriteDecisionRecord = vi.mocked(writeDecisionRecord);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: number; title: string }): Task {
  return {
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    explore: [],
    tddPhase: "GREEN",
    commitMessage: `implement task ${overrides.id}`,
    complexity: 5,
    status: "running" as TaskStatus,
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    tasks: [makeTask({ id: 1, title: "Task 1" })],
    complexity: 5,
    focus: "Test session",
    status: "running" as SessionStatus,
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<SessionRunnerContext>): SessionRunnerContext {
  return {
    args: {
      projectPath: "/test/project",
      concurrency: 2,
      models: {
        architect: { provider: "claude", model: "opus", subagents: {} },
        implementation: { provider: "claude", model: "opus", subagents: {} },
        qa: { provider: "claude", model: "opus", subagents: {} },
      },
      branch: "feat/x",
      taskFilter: null,
      dryRun: false,
      verbose: false,
      noTui: false,
    },
    slug: "test-proj",
    filteredSessions: [],
    allSessions: [],
    allTasks: [],
    designDoc: "",
    manifestContent: "",
    provider: { name: "claude" } as SessionRunnerContext["provider"],
    projectConfig: {
      agents: {
        architect: { provider: "claude", model: "opus", subagents: {} },
        implementation: { provider: "claude", model: "opus", subagents: {} },
        qa: { provider: "claude", model: "opus", subagents: {} },
      },
      concurrency: 2,
    },
    activePromises: new Map(),
    qaReports: new Map(),
    updateStatuses: vi.fn(),
    sessionDeps: new Map(),
    ...overrides,
  };
}

function makeDecisionContext(): DecisionContext {
  return {
    trigger: { stage: "implementation", exitCode: 1, errorTail: "some error" },
    task: { id: 1, title: "Test", type: "", tddPhase: "GREEN", complexity: 5, requirements: [], files: [], blockedDownstream: 0 },
    session: { id: "s1", totalTasks: 1, completedTasks: 0, remainingTasks: [], complexity: 5, taskTddPhases: [] },
    state: { branchExists: true, commitsAhead: 3, diffStat: "", worktreeExists: true, worktreeClean: false, planExists: true, attemptCount: 0, runningTasks: 1, freeSlots: 1 },
    history: [],
    actions: [],
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── classifyMergeError ──────────────────────────────────────────────────────

describe("classifyMergeError", () => {
  it("classifies rebase conflicts as merge_conflict/git_conflict", () => {
    const result = classifyMergeError(new Error("Rebase conflicts for session 1"));
    expect(result).toEqual({ stage: "merge_conflict", errorClass: "git_conflict" });
  });

  it("classifies test suite failures as test_validation/test_failure", () => {
    const result = classifyMergeError(new Error("Test suite failed for session 2"));
    expect(result).toEqual({ stage: "test_validation", errorClass: "test_failure" });
  });

  it("classifies type check failures as build_validation/type_error", () => {
    const result = classifyMergeError(new Error("Type check failed"));
    expect(result).toEqual({ stage: "build_validation", errorClass: "type_error" });
  });

  it("classifies build validation failures as build_validation/build_failure", () => {
    const result = classifyMergeError(new Error("Build validation failed"));
    expect(result).toEqual({ stage: "build_validation", errorClass: "build_failure" });
  });

  it("classifies dependency installation failures as build_validation/install_failure", () => {
    const result = classifyMergeError(new Error("Dependency installation failed"));
    expect(result).toEqual({ stage: "build_validation", errorClass: "install_failure" });
  });

  it("classifies unknown errors as merge_conflict/unknown", () => {
    const result = classifyMergeError(new Error("Something unexpected"));
    expect(result).toEqual({ stage: "merge_conflict", errorClass: "unknown" });
  });

  it("handles non-Error values", () => {
    const result = classifyMergeError("string error");
    expect(result).toEqual({ stage: "merge_conflict", errorClass: "unknown" });
  });

  it("handles null/undefined", () => {
    const result = classifyMergeError(null);
    expect(result).toEqual({ stage: "merge_conflict", errorClass: "unknown" });
  });
});

// ─── cleanupAfterTriage ──────────────────────────────────────────────────────

describe("cleanupAfterTriage", () => {
  it("does not clean up when session is re-queued", () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1", status: "queued" });
    cleanupAfterTriage(ctx, session);
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });

  it("cleans worktree and preserves branch for merging sessions", () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1", status: "merging" });
    cleanupAfterTriage(ctx, session);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", "s1", "feat/x", false, { preserveBranch: true },
    );
  });

  it("cleans worktree and preserves branch for needs_human sessions", () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s2", status: "needs_human" });
    cleanupAfterTriage(ctx, session);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", "s2", "feat/x", false, { preserveBranch: true },
    );
  });

  it("cleans worktree and deletes branch for done sessions", () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s3", status: "done" });
    cleanupAfterTriage(ctx, session);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", "s3", "feat/x", false, { preserveBranch: false },
    );
  });

  it("cleans worktree and preserves branch for failed sessions", () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s4", status: "failed" });
    cleanupAfterTriage(ctx, session);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", "s4", "feat/x", false, { preserveBranch: true },
    );
  });

  it("does not clean up when session is still running (extend_timeout)", () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s5", status: "running" });
    cleanupAfterTriage(ctx, session);
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });
});

// ─── handleStallCallback ─────────────────────────────────────────────────────

describe("handleStallCallback", () => {
  it("returns 'keep' when triage decides extend_timeout", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    const decision: TriageDecision = {
      action: "extend_timeout",
      reasoning: "Agent is making progress, just slow",
      details: { timeoutMs: "600000" },
    };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    const result = await handleStallCallback(ctx, session);
    expect(result).toBe("keep");
    expect(mockExecuteTriageAction).toHaveBeenCalledWith(
      session, decision, context, "test-proj", "feat/x", "/test/project", [], false,
    );
  });

  it("returns 'kill' for non-extend_timeout actions", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    const decision: TriageDecision = {
      action: "retry_from_scratch",
      reasoning: "Session appears stuck",
    };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    const result = await handleStallCallback(ctx, session);
    expect(result).toBe("kill");
    // Should NOT execute the action — stores it for handleFinalClose
    expect(mockExecuteTriageAction).not.toHaveBeenCalled();
  });

  it("returns 'kill' when triage itself fails", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    mockGatherDecisionContext.mockRejectedValue(new Error("triage failed"));

    const result = await handleStallCallback(ctx, session);
    expect(result).toBe("kill");
  });

  it("writes decision record for all triage decisions", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1", lastLine: "working on it" });

    const decision: TriageDecision = { action: "escalate", reasoning: "giving up" };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    await handleStallCallback(ctx, session);

    expect(mockWriteDecisionRecord).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        trigger: expect.objectContaining({
          stage: "stall",
          errorClass: "stall",
          errorSummary: "working on it",
        }),
        decision,
      }),
      "/test/project",
    );
  });

  it("uses 'Stall detected' as default summary when lastLine is empty", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1", lastLine: "" });

    const decision: TriageDecision = { action: "escalate", reasoning: "giving up" };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    await handleStallCallback(ctx, session);

    expect(mockWriteDecisionRecord).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        trigger: expect.objectContaining({ errorSummary: "Stall detected" }),
      }),
      "/test/project",
    );
  });
});

// ─── invokeTriageForSession ───────────────────────────────────────────────────

describe("invokeTriageForSession", () => {
  it("calls gatherDecisionContext → askTriage → writeDecisionRecord → executeTriageAction in sequence", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    const context = makeDecisionContext();
    const decision: TriageDecision = { action: "retry_from_scratch", reasoning: "let's try again" };

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    await invokeTriageForSession(ctx, session, "implementation", 1);

    // Verify correct sequence
    expect(mockGatherDecisionContext).toHaveBeenCalledWith(
      session, [], "feat/x", "/test/project", 2,
      { stage: "implementation", exitCode: 1, errorClass: undefined },
      "test-proj", false,
    );
    expect(mockAskTriage).toHaveBeenCalledWith(context, "/test/project", ctx.projectConfig);
    expect(mockWriteDecisionRecord).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        attemptNumber: 1,
        trigger: expect.objectContaining({ stage: "implementation" }),
        decision,
      }),
      "/test/project",
    );
    expect(mockExecuteTriageAction).toHaveBeenCalledWith(
      session, decision, context, "test-proj", "feat/x", "/test/project", [], false,
    );
  });

  it("passes errorClass to gatherDecisionContext when provided", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s2" });

    const context = makeDecisionContext();
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "done" });

    await invokeTriageForSession(ctx, session, "merge_conflict", 1, "git_conflict");

    expect(mockGatherDecisionContext).toHaveBeenCalledWith(
      session, [], "feat/x", "/test/project", 2,
      { stage: "merge_conflict", exitCode: 1, errorClass: "git_conflict" },
      "test-proj", false,
    );
  });

  it("truncates error summary to 100 chars", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    const longError = "A".repeat(200);
    const context = { ...makeDecisionContext(), trigger: { ...makeDecisionContext().trigger, errorTail: longError } };
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "done" });

    await invokeTriageForSession(ctx, session, "implementation", 1);

    const recordArg = mockWriteDecisionRecord.mock.calls[0][1];
    expect(recordArg.trigger.errorSummary.length).toBe(100);
  });

  it("uses filteredSessions from ctx when calling gatherDecisionContext", async () => {
    const session1 = makeSession({ id: "s1" });
    const session2 = makeSession({ id: "s2" });
    const ctx = makeCtx({ filteredSessions: [session1, session2] });

    const context = makeDecisionContext();
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "done" });

    await invokeTriageForSession(ctx, session1, "implementation", 1);

    expect(mockGatherDecisionContext).toHaveBeenCalledWith(
      session1, [session1, session2], "feat/x", "/test/project", 2,
      expect.any(Object), "test-proj", false,
    );
  });

  it("writes correct attemptNumber based on context.state.attemptCount", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    const context = { ...makeDecisionContext(), state: { ...makeDecisionContext().state, attemptCount: 2 } };
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "done" });

    await invokeTriageForSession(ctx, session, "implementation", 1);

    const recordArg = mockWriteDecisionRecord.mock.calls[0][1];
    expect(recordArg.attemptNumber).toBe(3);
  });

  it("passes exit code 1 (not 0) for merge-path failures", async () => {
    const ctx = makeCtx();
    const session = makeSession({ id: "s1" });

    const context = makeDecisionContext();
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "merge failed" });

    await invokeTriageForSession(ctx, session, "test_validation", 1, "test_failure");

    expect(mockGatherDecisionContext).toHaveBeenCalledWith(
      session, [], "feat/x", "/test/project", 2,
      { stage: "test_validation", exitCode: 1, errorClass: "test_failure" },
      "test-proj", false,
    );
  });
});

// ─── handleMergingSession — TDD-Exempt skipTests ──────────────────────────────

describe("handleMergingSession", () => {
  it("passes skipTests=true for TDD-Exempt session", async () => {
    mockSquashMerge.mockResolvedValue(undefined);
    const session = makeSession({
      id: "s1",
      status: "merging",
      tasks: [
        makeTask({ id: 1, title: "Setup DB", tddPhase: "Exempt" }),
        makeTask({ id: 2, title: "Write schema", tddPhase: "Exempt" }),
      ],
    });
    const ctx = makeCtx({ filteredSessions: [session] });
    ctx.activePromises.set(session.id, Promise.resolve());

    await handleMergingSession(ctx, session);

    expect(mockSquashMerge).toHaveBeenCalledWith(
      session, "feat/x", false, true,
    );
    expect(session.status).toBe("done");
  });

  it("passes skipTests=false for TDD session (GREEN phase)", async () => {
    mockSquashMerge.mockResolvedValue(undefined);
    const session = makeSession({
      id: "s2",
      status: "merging",
      tasks: [
        makeTask({ id: 1, title: "Implement feature", tddPhase: "GREEN" }),
      ],
    });
    const ctx = makeCtx({ filteredSessions: [session] });
    ctx.activePromises.set(session.id, Promise.resolve());

    await handleMergingSession(ctx, session);

    expect(mockSquashMerge).toHaveBeenCalledWith(
      session, "feat/x", false, false,
    );
  });

  it("passes skipTests=false for mixed TDD/Exempt session", async () => {
    mockSquashMerge.mockResolvedValue(undefined);
    const session = makeSession({
      id: "s3",
      status: "merging",
      tasks: [
        makeTask({ id: 1, title: "Exempt task", tddPhase: "Exempt" }),
        makeTask({ id: 2, title: "TDD task", tddPhase: "RED" }),
      ],
    });
    const ctx = makeCtx({ filteredSessions: [session] });
    ctx.activePromises.set(session.id, Promise.resolve());

    await handleMergingSession(ctx, session);

    expect(mockSquashMerge).toHaveBeenCalledWith(
      session, "feat/x", false, false,
    );
  });

  it("passes skipTests=true when tasks have empty tddPhase", async () => {
    mockSquashMerge.mockResolvedValue(undefined);
    const session = makeSession({
      id: "s4",
      status: "merging",
      tasks: [
        makeTask({ id: 1, title: "No TDD", tddPhase: "" }),
      ],
    });
    const ctx = makeCtx({ filteredSessions: [session] });
    ctx.activePromises.set(session.id, Promise.resolve());

    await handleMergingSession(ctx, session);

    expect(mockSquashMerge).toHaveBeenCalledWith(
      session, "feat/x", false, true,
    );
  });

  it("invokes triage on merge failure", async () => {
    mockSquashMerge.mockRejectedValue(new Error("Test suite failed for session s5"));
    const context = makeDecisionContext();
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "cannot fix" });

    const session = makeSession({
      id: "s5",
      status: "merging",
      tasks: [makeTask({ id: 1, title: "Task", tddPhase: "Exempt" })],
    });
    const ctx = makeCtx({ filteredSessions: [session] });
    ctx.activePromises.set(session.id, Promise.resolve());

    await handleMergingSession(ctx, session);

    expect(mockGatherDecisionContext).toHaveBeenCalled();
    expect(mockAskTriage).toHaveBeenCalled();
  });
});
