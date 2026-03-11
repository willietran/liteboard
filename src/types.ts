import type { ChildProcess } from "node:child_process";

// ─── Task Status ──────────────────────────────────────────────────────────

export type TaskStatus =
  | "blocked"
  | "queued"
  | "running"
  | "done"
  | "failed";

// ─── Task Stage ──────────────────────────────────────────────────────────

export type TaskStage =
  | ""
  | "Exploring"
  | "Planning"
  | "Plan Review"
  | "Implementing"
  | "Code Review"
  | "Committing"
  | "Merging";

// "Merging" is intentionally excluded — it is set by cli.ts, not parsed from agent output.
export const VALID_STAGE_MARKERS: ReadonlySet<string> = new Set([
  "Exploring", "Planning", "Plan Review", "Implementing",
  "Code Review", "Committing",
]);

// ─── TDD Phase ──────────────────────────────────────────────────────────

export type TddPhase = "RED" | "GREEN" | "RED \u2192 GREEN" | "RED \u2192 GREEN \u2192 REFACTOR" | "Exempt" | "";

// ─── Task ─────────────────────────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  creates: string[];
  modifies: string[];
  dependsOn: number[];
  requirements: string[];
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
  skipValidation: boolean;
  skipSmoke: boolean;
  skipQA: boolean;
  noFixer: boolean;
  fixerPatience: number;
}

// ─── Project Type ────────────────────────────────────────────────────────

export type ProjectType = "nextjs" | "vite" | "express" | "cli" | "library" | "generic";

// ─── Build Validation ────────────────────────────────────────────────────

export interface BuildValidationResult {
  success: boolean;
  failedPhase: "install" | "typecheck" | "build" | "test" | "none";
  error?: string;
  stderr?: string;
  tscErrorCount: number;
  testFailCount: number;
  testPassCount: number;
}

// ─── Smoke Test ──────────────────────────────────────────────────────────

export interface SmokeTestResult {
  success: boolean;
  projectType: ProjectType;
  error?: string;
  appUrl?: string;
}

// ─── Validation Metrics ──────────────────────────────────────────────────

export interface ValidationMetrics {
  tscErrorCount: number;
  testFailCount: number;
  buildPasses: boolean;
  smokeTestPasses: boolean;
  qaFailures: number;
}

// ─── QA Report ───────────────────────────────────────────────────────────

export interface QAReport {
  features: Array<{ name: string; passed: boolean; error?: string }>;
  totalPassed: number;
  totalFailed: number;
}

// ─── Integration Gate ────────────────────────────────────────────────────

export interface IntegrationGateResult {
  finalSuccess: boolean;
  buildResult: BuildValidationResult;
  smokeResult?: SmokeTestResult;
  qaReport?: QAReport;
  fixerResult?: FixerResult;
  phases: string[];
}

// ─── Fixer ───────────────────────────────────────────────────────────────

export interface FixerResult {
  rounds: number;
  converged: boolean;
  finalMetrics: ValidationMetrics;
  error?: string;
}

// ─── Dependency Layer ─────────────────────────────────────────────────────

export interface Layer {
  layerIndex: number;
  taskIds: number[];
}
