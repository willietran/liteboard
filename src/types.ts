import type { ChildProcess } from "node:child_process";

// ─── Complexity ───────────────────────────────────────────────────────────

/** Tasks at or below this complexity skip the architect phase and go directly to implementation. */
export const LOW_COMPLEXITY_THRESHOLD = 2;

// ─── Task Status ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "blocked"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "needs_human"
  | "merging";

// ─── Task Stage ──────────────────────────────────────────────────────────

export type TaskStage =
  | ""
  | "Exploring"
  | "Planning"
  | "Plan Review"
  | "Implementing"
  | "Verifying"
  | "Code Review"
  | "Committing"
  | "Merging"
  | "Validating"
  | "Smoke Testing"
  | "QA Testing"
  | "Fixing";

// "Merging" is intentionally excluded — it is set by cli.ts, not parsed from agent output.
export const VALID_STAGE_MARKERS: ReadonlySet<string> = new Set([
  "Exploring", "Planning", "Plan Review", "Implementing", "Verifying",
  "Code Review", "Committing",
  "Validating", "Smoke Testing", "QA Testing", "Fixing",
]);

// ─── TDD Phase ──────────────────────────────────────────────────────────

export type TddPhase = "RED" | "GREEN" | "RED \u2192 GREEN" | "RED \u2192 GREEN \u2192 REFACTOR" | "Exempt" | "";

// ─── Task ─────────────────────────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  type?: "qa";
  creates: string[];
  modifies: string[];
  dependsOn: number[];
  requirements: string[];
  explore: string[];
  tddPhase: TddPhase;
  commitMessage: string;
  complexity: number;
  status: TaskStatus;
  stage: TaskStage;
  turnCount: number;
  lastLine: string;
  bytesReceived: number;
  startedAt?: string;
  completedAt?: string;
  process?: ChildProcess;
  worktreePath?: string;
  logPath?: string;
  provider?: string;
  skipArchitect?: boolean;
  attemptCount?: number;
  suggestedSession?: string;
}

// ─── Ollama Config ────────────────────────────────────────────────────────

export interface OllamaConfig {
  baseUrl: string;
  fallback: boolean;
}

// ─── Model Config ─────────────────────────────────────────────────────────

export interface SubagentConfig {
  model: string;
}

export interface AgentConfig {
  provider: string;
  model: string;
  subagents: Record<string, SubagentConfig>;
}

export interface ModelConfig {
  architect:      AgentConfig;
  implementation: AgentConfig;
  qa:             AgentConfig;
}

export function defaultModelConfig(): ModelConfig {
  return {
    architect: {
      provider: "claude",
      model: "claude-opus-4-6",
      subagents: {
        explore: { model: "claude-sonnet-4-6" },
        planReview: { model: "claude-opus-4-6" },
      },
    },
    implementation: {
      provider: "claude",
      model: "claude-opus-4-6",
      subagents: {
        codeReview: { model: "claude-sonnet-4-6" },
      },
    },
    qa: {
      provider: "claude",
      model: "claude-opus-4-6",
      subagents: {
        qaFixer: { model: "claude-opus-4-6" },
      },
    },
  };
}

// ─── Simple Agent Config ──────────────────────────────────────────────────

/** Agent config without subagents (used by triage). */
export interface SimpleAgentConfig {
  provider: string;
  model: string;
}

// ─── Project Config ───────────────────────────────────────────────────────

export interface ProjectConfig {
  ollama?: OllamaConfig;
  agents: ModelConfig;
  triage?: SimpleAgentConfig;
  concurrency: number;
  branch?: string;
}

// ─── Triage Types ────────────────────────────────────────────────────────

export type FailureStage =
  | "worktree_creation"
  | "architect"
  | "plan_validation"
  | "implementation"
  | "merge_conflict"
  | "build_validation"
  | "test_validation"
  | "commit"
  | "stall"
  | "startup_validation";

export type ErrorClass =
  | "git_conflict"
  | "test_failure"
  | "build_failure"
  | "type_error"
  | "install_failure"
  | "timeout"
  | "stall"
  | "missing_artifact"
  | "unknown";

export type TriageAction =
  | "retry_from_scratch"
  | "resume_from_branch"
  | "retry_merge_only"
  | "skip_and_continue"
  | "escalate"
  | "reuse_plan"
  | "extend_timeout"
  | "mark_done";

export interface TriageDecision {
  action: TriageAction;
  reasoning: string;
  details?: Record<string, string>;
}

export interface ActionDescription {
  action: TriageAction;
  description: string;
  legalWhen: string;
}

export interface DecisionContext {
  trigger: {
    stage: FailureStage;
    exitCode: number;
    errorTail: string;
    errorClass?: ErrorClass;
  };
  task: {
    id: number;
    title: string;
    type: string;
    tddPhase: TddPhase;
    complexity: number;
    requirements: string[];
    files: string[];
    blockedDownstream: number;
  };
  session: {
    id: string;
    totalTasks: number;
    completedTasks: number;
    remainingTasks: string[];
    complexity: number;
  };
  state: {
    branchExists: boolean;
    commitsAhead: number;
    diffStat: string;
    worktreeExists: boolean;
    worktreeClean: boolean;
    planExists: boolean;
    attemptCount: number;
    runningTasks: number;
    freeSlots: number;
  };
  history: DecisionRecord[];
  actions: ActionDescription[];
}

export interface DecisionRecord {
  timestamp: string;
  attemptNumber: number;
  trigger: {
    stage: FailureStage;
    errorClass?: ErrorClass;
    errorSummary: string;
  };
  decision: TriageDecision;
  outcome?: {
    success: boolean;
    resultStage?: FailureStage;
    duration?: number;
  };
}

// ─── Stream Events ────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: "message_start"; turnIndex: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolName: string }
  | { type: "tool_use_end" }
  | { type: "message_end" }
  | { type: "error"; message: string };

// ─── Stream Parser ────────────────────────────────────────────────────────

/** A stateful parser that accumulates a buffer and emits events from chunks. */
export type StreamParser = (chunk: Buffer) => StreamEvent[];

// ─── Provider ─────────────────────────────────────────────────────────────

export interface Provider {
  name: string;
  spawn(opts: SpawnOpts): ChildProcess;
  parseStream(chunk: Buffer): StreamEvent[];
  /** Creates an independent stream parser with its own buffer. */
  createStreamParser(): StreamParser;
  healthCheck(): Promise<boolean>;
  /** Translates a full model ID to the Agent tool shorthand for this provider. */
  subagentModelHint(fullModel: string, providerName: string): string;
}

// ─── Spawn Options ────────────────────────────────────────────────────────

export interface SpawnOpts {
  prompt: string;
  model: string;
  cwd: string;
  verbose: boolean;
  env?: Record<string, string>;
}

// ─── CLI Arguments ────────────────────────────────────────────────────────

export interface CLIArgs {
  projectPath: string;
  concurrency: number;
  models: ModelConfig;
  ollama?: OllamaConfig;
  branch: string;
  taskFilter: number[] | null;
  dryRun: boolean;
  verbose: boolean;
  noTui: boolean;
}

// ─── Build Validation ────────────────────────────────────────────────────

export interface BuildValidationResult {
  success: boolean;
  failedPhase: "install" | "typecheck" | "build" | "test" | "none";
  error?: string;
  stderr?: string;
  /** True when the failing phase was killed by execFileSync timeout, not a code error. */
  timedOut?: boolean;
  tscErrorCount: number;
  testFailCount: number;
  testPassCount: number;
}

// ─── Progress Entry ───────────────────────────────────────────────────────

export type ProgressEntry =
  | { status: "done"; completedAt: string }
  | { status: "needs_human" };

// ─── Session ──────────────────────────────────────────────────────────────

export type SessionStatus =
  | "queued"
  | "blocked"
  | "running"
  | "merging"
  | "done"
  | "failed"
  | "needs_human";

export interface Session {
  // Identity
  id: string;
  tasks: Task[];
  complexity: number;
  focus: string;

  // Runtime state
  status: SessionStatus;
  process?: ChildProcess;
  worktreePath?: string;
  branchName?: string;
  startedAt?: string;
  completedAt?: string;
  bytesReceived: number;
  turnCount: number;
  lastLine: string;
  stage: string;
  logPath?: string;
  provider?: string;
  attemptCount: number;
  skipArchitect?: boolean;
}

export type SessionProgressEntry =
  | { status: "done"; completedAt: string }
  | { status: "needs_human" };

// ─── Dependency Layer ─────────────────────────────────────────────────────

export interface Layer {
  layerIndex: number;
  taskIds: number[];
}
