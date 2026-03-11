import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Task,
  ValidationMetrics,
  FixerResult,
  Provider,
} from "./types.js";
import { runBuildValidation } from "./build-validation.js";
import { git } from "./git.js";
import { buildFixerBrief } from "./brief.js";
import { gateCleanupProcesses } from "./validator.js";

// ─── Progress Detection ─────────────────────────────────────────────────────

export function isProgress(
  current: ValidationMetrics,
  previous: ValidationMetrics,
): boolean {
  const currentScore =
    current.tscErrorCount +
    current.testFailCount +
    current.qaFailures +
    (current.buildPasses ? 0 : 10) +
    (current.smokeTestPasses ? 0 : 10);
  const previousScore =
    previous.tscErrorCount +
    previous.testFailCount +
    previous.qaFailures +
    (previous.buildPasses ? 0 : 10) +
    (previous.smokeTestPasses ? 0 : 10);
  return currentScore < previousScore;
}

/** Check if build-related metrics all pass (smoke/QA checked separately by orchestrator). */
function isBuildPassing(metrics: ValidationMetrics): boolean {
  return (
    metrics.tscErrorCount === 0 &&
    metrics.testFailCount === 0 &&
    metrics.buildPasses
  );
}

// ─── Fixer Loop ──────────────────────────────────────────────────────────────

export interface FixerLoopOpts {
  fixerPatience: number;
  verbose: boolean;
  projectDir: string;
  skipSmoke: boolean;
  skipQA: boolean;
  designPath?: string;
  manifestPath?: string;
}

export async function runFixerLoop(
  repoRoot: string,
  branch: string,
  tasks: Task[],
  initialMetrics: ValidationMetrics,
  provider: Provider,
  model: string,
  opts: FixerLoopOpts,
): Promise<FixerResult> {
  let patience = opts.fixerPatience;
  let previousMetrics = initialMetrics;
  let round = 0;

  // Ensure logs directory exists
  const logsDir = path.join(opts.projectDir, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  while (patience > 0) {
    round++;
    console.log(`\n  Fixer round ${round} (patience: ${patience})`);

    // Build error context for fixer brief
    const buildResult = runBuildValidation(repoRoot, { cleanInstall: false });
    const errorContext = buildResult.success
      ? "Build passes but other validation phases failed."
      : `Build failed at: ${buildResult.failedPhase}\n${buildResult.stderr || buildResult.error || ""}`;

    let diff = "";
    try {
      diff = git(["diff", "main...HEAD"], { cwd: repoRoot, verbose: opts.verbose });
    } catch {
      // May fail if main doesn't exist
    }

    const brief = buildFixerBrief(
      errorContext,
      diff,
      tasks,
      opts.projectDir,
      opts.designPath,
      opts.manifestPath,
      branch,
    );

    // Spawn fixer agent
    const logFile = path.join(logsDir, `fixer-round${round}.jsonl`);
    const logStream = fs.createWriteStream(logFile, { flags: "w" });

    const child = provider.spawn({
      prompt: brief,
      model,
      cwd: repoRoot,
      verbose: opts.verbose,
    });
    gateCleanupProcesses.add(child);

    // Wait for agent to finish
    const exitCode = await new Promise<number | null>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => logStream.write(chunk));
      child.stderr?.on("data", (chunk: Buffer) => logStream.write(`[stderr] ${chunk.toString()}\n`));
      child.on("close", (code) => {
        logStream.end();
        gateCleanupProcesses.delete(child);
        resolve(code);
      });
    });

    if (exitCode !== 0) {
      console.log(`  \x1b[31mFixer agent crashed (exit ${exitCode})\x1b[0m`);
      patience--;
      continue;
    }

    // Re-validate
    const newBuildResult = runBuildValidation(repoRoot, { cleanInstall: false });
    const currentMetrics: ValidationMetrics = {
      tscErrorCount: newBuildResult.tscErrorCount,
      testFailCount: newBuildResult.testFailCount,
      buildPasses: newBuildResult.success,
      smokeTestPasses: previousMetrics.smokeTestPasses, // Smoke re-run is expensive, keep previous
      qaFailures: previousMetrics.qaFailures,
    };

    if (isBuildPassing(currentMetrics)) {
      console.log("  \x1b[32mBuild validation passes — fixer converged\x1b[0m");
      return {
        rounds: round,
        converged: true,
        finalMetrics: currentMetrics,
      };
    }

    if (isProgress(currentMetrics, previousMetrics)) {
      console.log("  \x1b[33mProgress detected — patience holds\x1b[0m");
      previousMetrics = currentMetrics;
    } else {
      // Regression or no progress — rollback only if HEAD is a fixer commit
      console.log("  \x1b[31mNo progress — patience decrements\x1b[0m");
      try {
        const headMsg = git(["log", "-1", "--format=%s"], { cwd: repoRoot, verbose: opts.verbose });
        if (headMsg.startsWith("fix(integration):")) {
          console.log("  Rolling back fixer commit");
          git(["reset", "--hard", "HEAD~1"], { cwd: repoRoot, verbose: opts.verbose });
        }
      } catch {
        // git log/reset may fail — non-fatal
      }
      patience--;
    }
  }

  return {
    rounds: round,
    converged: false,
    finalMetrics: previousMetrics,
    error: "Fixer exhausted patience without converging",
  };
}
