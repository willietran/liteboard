import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task, TaskStatus, TriageDecision, DecisionContext, FailureStage, ErrorClass } from "../src/types.js";

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
  buildBrief: vi.fn(() => "brief"),
  buildArchitectBrief: vi.fn(() => "architect-brief"),
  buildImplementationBrief: vi.fn(() => "impl-brief"),
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
  invokeTriageForTask,
  type TaskRunnerContext,
} from "../src/task-runner.js";
import { writeProgress } from "../src/progress.js";
import { cleanupWorktree } from "../src/worktree.js";
import { gatherDecisionContext, askTriage, executeTriageAction, writeDecisionRecord } from "../src/triage.js";

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

function makeCtx(overrides?: Partial<TaskRunnerContext>): TaskRunnerContext {
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
    filteredTasks: [],
    allTasks: [],
    designDoc: "",
    manifestContent: "",
    provider: { name: "claude" } as TaskRunnerContext["provider"],
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
    ...overrides,
  };
}

function makeDecisionContext(): DecisionContext {
  return {
    trigger: { stage: "implementation", exitCode: 1, errorTail: "some error" },
    task: { id: 1, title: "Test", type: "", tddPhase: "GREEN", complexity: 5, requirements: [], files: [], blockedDownstream: 0 },
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
    const result = classifyMergeError(new Error("Rebase conflicts for task 1"));
    expect(result).toEqual({ stage: "merge_conflict", errorClass: "git_conflict" });
  });

  it("classifies test suite failures as test_validation/test_failure", () => {
    const result = classifyMergeError(new Error("Test suite failed for task 2"));
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
  it("does not clean up when task is re-queued", () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test", status: "queued" });
    cleanupAfterTriage(ctx, task);
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });

  it("cleans worktree and preserves branch for merging tasks", () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test", status: "merging" });
    cleanupAfterTriage(ctx, task);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", 1, "feat/x", false, { preserveBranch: true },
    );
  });

  it("cleans worktree and preserves branch for needs_human tasks", () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 2, title: "Test", status: "needs_human" });
    cleanupAfterTriage(ctx, task);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", 2, "feat/x", false, { preserveBranch: true },
    );
  });

  it("cleans worktree and deletes branch for done tasks", () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 3, title: "Test", status: "done" });
    cleanupAfterTriage(ctx, task);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", 3, "feat/x", false, { preserveBranch: false },
    );
  });

  it("cleans worktree and preserves branch for failed tasks", () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 4, title: "Test", status: "failed" });
    cleanupAfterTriage(ctx, task);
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      "test-proj", 4, "feat/x", false, { preserveBranch: true },
    );
  });

  it("does not clean up when task is still running (extend_timeout)", () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 5, title: "Test", status: "running" });
    cleanupAfterTriage(ctx, task);
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });
});

// ─── handleStallCallback ─────────────────────────────────────────────────────

describe("handleStallCallback", () => {
  it("returns 'keep' when triage decides extend_timeout", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test" });

    const decision: TriageDecision = {
      action: "extend_timeout",
      reasoning: "Agent is making progress, just slow",
      details: { timeoutMs: "600000" },
    };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    const result = await handleStallCallback(ctx, task);
    expect(result).toBe("keep");
    expect(mockExecuteTriageAction).toHaveBeenCalledWith(
      task, decision, context, "test-proj", "feat/x", "/test/project", [], false,
    );
  });

  it("returns 'kill' for non-extend_timeout actions", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test" });

    const decision: TriageDecision = {
      action: "retry_from_scratch",
      reasoning: "Task appears stuck",
    };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    const result = await handleStallCallback(ctx, task);
    expect(result).toBe("kill");
    // Should NOT execute the action — stores it for handleFinalClose
    expect(mockExecuteTriageAction).not.toHaveBeenCalled();
  });

  it("returns 'kill' when triage itself fails", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test" });

    mockGatherDecisionContext.mockRejectedValue(new Error("triage failed"));

    const result = await handleStallCallback(ctx, task);
    expect(result).toBe("kill");
  });

  it("writes decision record for all triage decisions", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test", lastLine: "working on it" });

    const decision: TriageDecision = { action: "escalate", reasoning: "giving up" };
    const context = makeDecisionContext();

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    await handleStallCallback(ctx, task);

    expect(mockWriteDecisionRecord).toHaveBeenCalledWith(
      1,
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
});

// ─── invokeTriageForTask ─────────────────────────────────────────────────────

describe("invokeTriageForTask", () => {
  it("calls gatherDecisionContext → askTriage → writeDecisionRecord → executeTriageAction in sequence", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test" });

    const context = makeDecisionContext();
    const decision: TriageDecision = { action: "retry_from_scratch", reasoning: "let's try again" };

    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue(decision);

    await invokeTriageForTask(ctx, task, "implementation", 1);

    // Verify correct sequence
    expect(mockGatherDecisionContext).toHaveBeenCalledWith(
      task, [], "feat/x", "/test/project", 2,
      { stage: "implementation", exitCode: 1, errorClass: undefined },
    );
    expect(mockAskTriage).toHaveBeenCalledWith(context, "/test/project", ctx.projectConfig);
    expect(mockWriteDecisionRecord).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        attemptNumber: 1,
        trigger: expect.objectContaining({ stage: "implementation" }),
        decision,
      }),
      "/test/project",
    );
    expect(mockExecuteTriageAction).toHaveBeenCalledWith(
      task, decision, context, "test-proj", "feat/x", "/test/project", [], false,
    );
  });

  it("passes errorClass to gatherDecisionContext when provided", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 2, title: "Test" });

    const context = makeDecisionContext();
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "done" });

    await invokeTriageForTask(ctx, task, "merge_conflict", 1, "git_conflict");

    expect(mockGatherDecisionContext).toHaveBeenCalledWith(
      task, [], "feat/x", "/test/project", 2,
      { stage: "merge_conflict", exitCode: 1, errorClass: "git_conflict" },
    );
  });

  it("truncates error summary to 100 chars", async () => {
    const ctx = makeCtx();
    const task = makeTask({ id: 1, title: "Test" });

    const longError = "A".repeat(200);
    const context = { ...makeDecisionContext(), trigger: { ...makeDecisionContext().trigger, errorTail: longError } };
    mockGatherDecisionContext.mockResolvedValue(context);
    mockAskTriage.mockResolvedValue({ action: "escalate", reasoning: "done" });

    await invokeTriageForTask(ctx, task, "implementation", 1);

    const recordArg = mockWriteDecisionRecord.mock.calls[0][1];
    expect(recordArg.trigger.errorSummary.length).toBe(100);
  });
});
