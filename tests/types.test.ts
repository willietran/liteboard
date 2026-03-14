import { describe, it, expect } from "vitest";
import {
  defaultModelConfig,
  LOW_COMPLEXITY_THRESHOLD,
  type TaskStatus,
  type SessionStatus,
  type Session,
  type ProgressEntry,
  type SessionProgressEntry,
  type FailureStage,
  type ErrorClass,
  type TriageAction,
  type TriageDecision,
  type DecisionContext,
  type DecisionRecord,
  type SimpleAgentConfig,
  type ActionDescription,
  type Task,
} from "../src/types.js";

describe("LOW_COMPLEXITY_THRESHOLD", () => {
  it("is exported as 2", () => {
    expect(LOW_COMPLEXITY_THRESHOLD).toBe(2);
  });
});

describe("defaultModelConfig", () => {
  it("returns an object with exactly 3 agent roles", () => {
    const config = defaultModelConfig();
    const keys = Object.keys(config);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("architect");
    expect(keys).toContain("implementation");
    expect(keys).toContain("qa");
  });

  it("returns a fresh object on each call (no shared references)", () => {
    const a = defaultModelConfig();
    const b = defaultModelConfig();
    expect(a).not.toBe(b);
    expect(a.architect).not.toBe(b.architect);
    expect(a.architect.subagents).not.toBe(b.architect.subagents);
  });

  describe("architect agent", () => {
    it('has provider "claude"', () => {
      const config = defaultModelConfig();
      expect(config.architect.provider).toBe("claude");
    });

    it('has model "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.architect.model).toBe("claude-opus-4-6");
    });

    it("has exactly 2 subagents: explore and planReview", () => {
      const config = defaultModelConfig();
      const subKeys = Object.keys(config.architect.subagents);
      expect(subKeys).toHaveLength(2);
      expect(subKeys).toContain("explore");
      expect(subKeys).toContain("planReview");
    });

    it('explore subagent uses "claude-sonnet-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.architect.subagents.explore.model).toBe("claude-sonnet-4-6");
    });

    it('planReview subagent uses "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.architect.subagents.planReview.model).toBe("claude-opus-4-6");
    });
  });

  describe("implementation agent", () => {
    it('has provider "claude"', () => {
      const config = defaultModelConfig();
      expect(config.implementation.provider).toBe("claude");
    });

    it('has model "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.implementation.model).toBe("claude-opus-4-6");
    });

    it("has exactly 1 subagent: codeReview", () => {
      const config = defaultModelConfig();
      const subKeys = Object.keys(config.implementation.subagents);
      expect(subKeys).toHaveLength(1);
      expect(subKeys).toContain("codeReview");
    });

    it('codeReview subagent uses "claude-sonnet-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.implementation.subagents.codeReview.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("qa agent", () => {
    it('has provider "claude"', () => {
      const config = defaultModelConfig();
      expect(config.qa.provider).toBe("claude");
    });

    it('has model "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.qa.model).toBe("claude-opus-4-6");
    });

    it("has exactly 1 subagent: qaFixer", () => {
      const config = defaultModelConfig();
      const subKeys = Object.keys(config.qa.subagents);
      expect(subKeys).toHaveLength(1);
      expect(subKeys).toContain("qaFixer");
    });

    it('qaFixer subagent uses "claude-opus-4-6"', () => {
      const config = defaultModelConfig();
      expect(config.qa.subagents.qaFixer.model).toBe("claude-opus-4-6");
    });
  });

  it("all agent roles use provider claude", () => {
    const config = defaultModelConfig();
    expect(config.architect.provider).toBe("claude");
    expect(config.implementation.provider).toBe("claude");
    expect(config.qa.provider).toBe("claude");
  });
});

describe("TaskStatus type", () => {
  it("accepts all original status values", () => {
    const statuses: TaskStatus[] = ["blocked", "queued", "running", "done", "failed"];
    expect(statuses).toHaveLength(5);
  });

  it("accepts needs_human status", () => {
    const status: TaskStatus = "needs_human";
    expect(status).toBe("needs_human");
  });

  it("accepts merging status", () => {
    const status: TaskStatus = "merging";
    expect(status).toBe("merging");
  });
});

describe("Task interface extensions", () => {
  it("accepts skipArchitect as optional boolean", () => {
    const partial: Pick<Task, "skipArchitect"> = { skipArchitect: true };
    expect(partial.skipArchitect).toBe(true);
  });

  it("accepts attemptCount as optional number", () => {
    const partial: Pick<Task, "attemptCount"> = { attemptCount: 3 };
    expect(partial.attemptCount).toBe(3);
  });

  it("does not require skipArchitect or attemptCount (undefined by default)", () => {
    const partial: Pick<Task, "skipArchitect" | "attemptCount"> = {};
    expect(partial.skipArchitect).toBeUndefined();
    expect(partial.attemptCount).toBeUndefined();
  });

  it("accepts suggestedSession as optional string", () => {
    const partial: Pick<Task, "suggestedSession"> = { suggestedSession: "S1" };
    expect(partial.suggestedSession).toBe("S1");
  });

  it("does not require suggestedSession (undefined by default)", () => {
    const partial: Pick<Task, "suggestedSession"> = {};
    expect(partial.suggestedSession).toBeUndefined();
  });
});

describe("Triage types", () => {
  it("FailureStage accepts all defined stages", () => {
    const stages: FailureStage[] = [
      "worktree_creation", "architect", "plan_validation", "implementation",
      "merge_conflict", "build_validation", "test_validation", "commit",
      "stall", "startup_validation",
    ];
    expect(stages).toHaveLength(10);
  });

  it("ErrorClass accepts all defined classes", () => {
    const classes: ErrorClass[] = [
      "git_conflict", "test_failure", "build_failure", "type_error",
      "install_failure", "timeout", "stall", "missing_artifact", "unknown",
    ];
    expect(classes).toHaveLength(9);
  });

  it("TriageAction accepts all defined actions", () => {
    const actions: TriageAction[] = [
      "retry_from_scratch", "resume_from_branch", "retry_merge_only",
      "skip_and_continue", "escalate", "reuse_plan", "extend_timeout", "mark_done",
    ];
    expect(actions).toHaveLength(8);
  });

  it("TriageDecision requires action and reasoning", () => {
    const decision: TriageDecision = {
      action: "escalate",
      reasoning: "Cannot recover",
    };
    expect(decision.action).toBe("escalate");
    expect(decision.reasoning).toBe("Cannot recover");
    expect(decision.details).toBeUndefined();
  });

  it("TriageDecision accepts optional details", () => {
    const decision: TriageDecision = {
      action: "extend_timeout",
      reasoning: "Agent is still producing output",
      details: { timeoutMs: "600000" },
    };
    expect(decision.details?.timeoutMs).toBe("600000");
  });

  it("SimpleAgentConfig has provider and model", () => {
    const config: SimpleAgentConfig = { provider: "claude", model: "claude-sonnet-4-6" };
    expect(config.provider).toBe("claude");
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("DecisionRecord has required fields and optional outcome", () => {
    const record: DecisionRecord = {
      timestamp: "2026-03-13T08:15:00Z",
      attemptNumber: 1,
      trigger: {
        stage: "test_validation",
        errorClass: "test_failure",
        errorSummary: "vitest exit code 1",
      },
      decision: { action: "retry_from_scratch", reasoning: "First attempt failed" },
    };
    expect(record.outcome).toBeUndefined();
  });

  it("DecisionRecord accepts outcome with success and optional fields", () => {
    const record: DecisionRecord = {
      timestamp: "2026-03-13T08:15:00Z",
      attemptNumber: 1,
      trigger: { stage: "merge_conflict", errorSummary: "CONFLICT in src/foo.ts" },
      decision: { action: "resume_from_branch", reasoning: "Branch has work" },
      outcome: { success: true, duration: 120 },
    };
    expect(record.outcome?.success).toBe(true);
    expect(record.outcome?.resultStage).toBeUndefined();
  });

  it("ActionDescription has action, description, and legalWhen fields", () => {
    const desc: ActionDescription = {
      action: "escalate",
      description: "Pause task and notify human",
      legalWhen: "always",
    };
    expect(desc.action).toBe("escalate");
    expect(desc.description).toBeDefined();
    expect(desc.legalWhen).toBeDefined();
  });

  it("DecisionContext has all required sections", () => {
    const ctx: DecisionContext = {
      trigger: { stage: "implementation", exitCode: 1, errorTail: "Error: compile failed" },
      task: {
        id: 1, title: "T1", type: "implementation", tddPhase: "RED → GREEN",
        complexity: 3, requirements: [], files: [], blockedDownstream: 0,
      },
      state: {
        branchExists: true, commitsAhead: 2, diffStat: "2 files changed",
        worktreeExists: true, worktreeClean: false, planExists: true,
        attemptCount: 1, runningTasks: 3, freeSlots: 1,
      },
      history: [],
      actions: [],
    };
    expect(ctx.trigger.stage).toBe("implementation");
    expect(ctx.task.id).toBe(1);
    expect(ctx.state.branchExists).toBe(true);
    expect(ctx.history).toHaveLength(0);
    expect(ctx.actions).toHaveLength(0);
  });
});

describe("SessionStatus type", () => {
  it("accepts all valid session status values", () => {
    const statuses: SessionStatus[] = [
      "queued", "blocked", "running", "merging", "done", "failed", "needs_human",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("accepts queued status", () => {
    const s: SessionStatus = "queued";
    expect(s).toBe("queued");
  });

  it("accepts blocked status", () => {
    const s: SessionStatus = "blocked";
    expect(s).toBe("blocked");
  });

  it("accepts running status", () => {
    const s: SessionStatus = "running";
    expect(s).toBe("running");
  });

  it("accepts merging status", () => {
    const s: SessionStatus = "merging";
    expect(s).toBe("merging");
  });

  it("accepts done status", () => {
    const s: SessionStatus = "done";
    expect(s).toBe("done");
  });

  it("accepts failed status", () => {
    const s: SessionStatus = "failed";
    expect(s).toBe("failed");
  });

  it("accepts needs_human status", () => {
    const s: SessionStatus = "needs_human";
    expect(s).toBe("needs_human");
  });
});

describe("Session interface", () => {
  it("requires identity fields: id, tasks, complexity, focus", () => {
    const session: Pick<Session, "id" | "tasks" | "complexity" | "focus"> = {
      id: "S1",
      tasks: [],
      complexity: 8,
      focus: "Types/config + brief improvements",
    };
    expect(session.id).toBe("S1");
    expect(session.tasks).toEqual([]);
    expect(session.complexity).toBe(8);
    expect(session.focus).toBe("Types/config + brief improvements");
  });

  it("requires runtime state fields with correct defaults", () => {
    const session: Pick<Session, "status" | "bytesReceived" | "turnCount" | "lastLine" | "stage" | "attemptCount"> = {
      status: "queued",
      bytesReceived: 0,
      turnCount: 0,
      lastLine: "",
      stage: "",
      attemptCount: 0,
    };
    expect(session.status).toBe("queued");
    expect(session.bytesReceived).toBe(0);
    expect(session.turnCount).toBe(0);
    expect(session.lastLine).toBe("");
    expect(session.stage).toBe("");
    expect(session.attemptCount).toBe(0);
  });

  it("accepts optional fields as undefined", () => {
    const session: Pick<Session, "process" | "worktreePath" | "branchName" | "startedAt" | "completedAt" | "logPath" | "provider" | "skipArchitect"> = {};
    expect(session.process).toBeUndefined();
    expect(session.worktreePath).toBeUndefined();
    expect(session.branchName).toBeUndefined();
    expect(session.startedAt).toBeUndefined();
    expect(session.completedAt).toBeUndefined();
    expect(session.logPath).toBeUndefined();
    expect(session.provider).toBeUndefined();
    expect(session.skipArchitect).toBeUndefined();
  });

  it("accepts string values for optional fields", () => {
    const session: Pick<Session, "worktreePath" | "branchName" | "startedAt" | "completedAt" | "logPath" | "provider"> = {
      worktreePath: "/tmp/worktrees/s1",
      branchName: "feature/my-branch-s1",
      startedAt: "2026-03-13T10:00:00Z",
      completedAt: "2026-03-13T11:00:00Z",
      logPath: "/tmp/logs/s1.log",
      provider: "claude",
    };
    expect(session.worktreePath).toBe("/tmp/worktrees/s1");
    expect(session.branchName).toBe("feature/my-branch-s1");
    expect(session.provider).toBe("claude");
  });
});

describe("SessionProgressEntry type", () => {
  it("accepts done variant with completedAt timestamp", () => {
    const entry: SessionProgressEntry = { status: "done", completedAt: "2026-03-13T10:00:00Z" };
    expect(entry.status).toBe("done");
    if (entry.status === "done") {
      expect(entry.completedAt).toBe("2026-03-13T10:00:00Z");
    }
  });

  it("accepts needs_human variant", () => {
    const entry: SessionProgressEntry = { status: "needs_human" };
    expect(entry.status).toBe("needs_human");
  });

  it("is structurally parallel to ProgressEntry", () => {
    // ProgressEntry and SessionProgressEntry have the same variant shapes
    const sessionEntry: SessionProgressEntry = { status: "done", completedAt: "2026-03-13T00:00:00Z" };
    const taskEntry: ProgressEntry = { status: "done", completedAt: "2026-03-13T00:00:00Z" };
    expect(sessionEntry.status).toBe(taskEntry.status);
    if (sessionEntry.status === "done" && taskEntry.status === "done") {
      expect(sessionEntry.completedAt).toBe(taskEntry.completedAt);
    }
  });
});
