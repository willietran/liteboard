import type { ChildProcess } from "node:child_process";

// ─── Task Status ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "blocked"
  | "queued"
  | "running"
  | "done"
  | "failed";

// ─── Task ─────────────────────────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  creates: string[];
  modifies: string[];
  dependsOn: number[];
  requirements: string[];
  tddPhase: string;
  commitMessage: string;
  complexity: number;
  status: TaskStatus;
  turnCount: number;
  lastLine: string;
  bytesReceived: number;
  startedAt?: string;
  completedAt?: string;
  process?: ChildProcess;
  worktreePath?: string;
  logPath?: string;
}

// ─── Model Config ─────────────────────────────────────────────────────────

export interface ModelConfig {
  brainstorm: { provider: string; model: string };
  taskManifest: { provider: string; model: string };
  architectReview: { provider: string; model: string };
  implementation: { provider: string; model: string };
  reviewGates: { provider: string; model: string };
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
}

// ─── Spawn Options ────────────────────────────────────────────────────────

export interface SpawnOpts {
  prompt: string;
  model: string;
  cwd: string;
  verbose: boolean;
}

// ─── CLI Arguments ────────────────────────────────────────────────────────

export interface CLIArgs {
  projectPath: string;
  concurrency: number;
  model: string;
  branch: string;
  taskFilter: number[] | null;
  dryRun: boolean;
  verbose: boolean;
}

// ─── Dependency Layer ─────────────────────────────────────────────────────

export interface Layer {
  layerIndex: number;
  taskIds: number[];
}
