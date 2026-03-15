import type { ChildProcess } from "node:child_process";

// ─── Task Status ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "blocked"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "needs_human";

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

// "Merging" is set by cli.ts, not parsed from agent output.
export const VALID_STAGE_MARKERS: ReadonlySet<string> = new Set([
  "Exploring", "Planning", "Plan Review", "Implementing", "Verifying",
  "Code Review", "Committing",
  "Validating", "Smoke Testing", "QA Testing", "Fixing",
]);

// ─── TDD Phase ──────────────────────────────────────────────────────────

export type TddPhase = "RED" | "GREEN" | "RED → GREEN" | "RED → GREEN → REFACTOR" | "Exempt" | "";

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
  suggestedSession?: string;
}

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
  id: string;
  tasks: Task[];
  complexity: number;
  focus: string;
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
}

// ─── Stream Events ────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: "message_start"; turnIndex: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolName: string }
  | { type: "tool_use_end" }
  | { type: "message_end" }
  | { type: "error"; message: string };

/** A stateful parser that accumulates a buffer and emits events from chunks. */
export type StreamParser = (chunk: Buffer) => StreamEvent[];

// ─── Build Validation ────────────────────────────────────────────────────

export interface BuildValidationResult {
  success: boolean;
  failedPhase: "install" | "typecheck" | "build" | "test" | "none";
  error?: string;
  stderr?: string;
  timedOut?: boolean;
  tscErrorCount: number;
  testFailCount: number;
  testPassCount: number;
}

// ─── Progress Entry ───────────────────────────────────────────────────────

export type ProgressEntry =
  | { status: "done"; completedAt: string }
  | { status: "needs_human" };

export type SessionProgressEntry =
  | { status: "done"; completedAt: string }
  | { status: "needs_human" };

// ─── V2 Config ────────────────────────────────────────────────────────────

export interface AgentConfig {
  provider: string;
  model: string;
}

export interface SubagentConfig {
  model: string;
}

export interface V2Config {
  agents: {
    session: AgentConfig;
    manifest: AgentConfig;
    qa: AgentConfig;
  };
  subagents: {
    explore: SubagentConfig;
    planReview: SubagentConfig;
    codeReview: SubagentConfig;
  };
  concurrency: number;
  branch?: string;
}

export function defaultV2Config(): V2Config {
  return {
    agents: {
      session: { provider: "claude", model: "claude-opus-4-6" },
      manifest: { provider: "claude", model: "claude-opus-4-6" },
      qa: { provider: "claude", model: "claude-sonnet-4-6" },
    },
    subagents: {
      explore: { model: "sonnet" },
      planReview: { model: "opus" },
      codeReview: { model: "sonnet" },
    },
    concurrency: 1,
  };
}

// ─── V2 CLI Arguments ─────────────────────────────────────────────────────

export interface V2CLIArgs {
  projectPath: string;
  specPath?: string;
  concurrency: number;
  branch: string;
  taskFilter: number[] | null;
  dryRun: boolean;
  verbose: boolean;
  noTui: boolean;
}

// ─── Dependency Layer ─────────────────────────────────────────────────────

export interface Layer {
  layerIndex: number;
  taskIds: number[];
}
