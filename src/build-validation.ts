import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type { BuildValidationResult } from "./types.js";
import { getErrorMessage, getErrorStderr } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const NPM_TIMEOUT_MS = 120_000;

// ─── Build Validation ────────────────────────────────────────────────────────

export interface BuildValidationOpts {
  cleanInstall: boolean;
  timeout?: number;
  verbose?: boolean;
}

/**
 * Runs the full build validation pipeline: install → tsc → build → test.
 * Returns a structured result — callers decide error handling.
 */
export function runBuildValidation(
  repoRoot: string,
  opts: BuildValidationOpts,
): BuildValidationResult {
  const timeout = opts.timeout ?? NPM_TIMEOUT_MS;

  // Skip validation entirely for non-npm projects
  const hasPkgJson = fs.existsSync(`${repoRoot}/package.json`);
  if (!hasPkgJson) {
    return {
      success: true,
      failedPhase: "none",
      tscErrorCount: 0,
      testFailCount: 0,
      testPassCount: 0,
    };
  }

  const log = opts.verbose ? (msg: string) => console.log(`  ${msg}`) : () => {};

  // Phase 1: Install dependencies
  log(opts.cleanInstall ? "Running npm ci..." : "Running npm install...");
  try {
    const installCmd = opts.cleanInstall ? "ci" : "install";
    execFileSync("npm", [installCmd], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
      timeout,
    });
  } catch (e: unknown) {
    const stderr = getErrorStderr(e);
    log(`\x1b[31mInstall failed\x1b[0m`);
    if (stderr) logStderrPreview(log, stderr);
    return {
      success: false,
      failedPhase: "install",
      error: getErrorMessage(e),
      stderr,
      tscErrorCount: 0,
      testFailCount: 0,
      testPassCount: 0,
    };
  }

  // Phase 2: Type check
  log("Running npx tsc --noEmit...");
  let tscErrorCount = 0;
  try {
    execFileSync("npx", ["tsc", "--noEmit"], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
      timeout,
    });
  } catch (e: unknown) {
    const stderr = getErrorStderr(e);
    tscErrorCount = (stderr.match(/error TS\d+/g) || []).length;
    log(`\x1b[31mTypecheck failed (${tscErrorCount || 1} error(s))\x1b[0m`);
    if (stderr) logStderrPreview(log, stderr);
    return {
      success: false,
      failedPhase: "typecheck",
      error: getErrorMessage(e),
      stderr,
      tscErrorCount: tscErrorCount || 1,
      testFailCount: 0,
      testPassCount: 0,
    };
  }

  // Phase 3: Build
  log("Running npm run build...");
  try {
    execFileSync("npm", ["run", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
      timeout,
    });
  } catch (e: unknown) {
    const stderr = getErrorStderr(e);
    log(`\x1b[31mBuild failed\x1b[0m`);
    if (stderr) logStderrPreview(log, stderr);
    return {
      success: false,
      failedPhase: "build",
      error: getErrorMessage(e),
      stderr,
      tscErrorCount: 0,
      testFailCount: 0,
      testPassCount: 0,
    };
  }

  // Phase 4: Test (only if a real test script is configured)
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(`${repoRoot}/package.json`, "utf-8"));
    hasTestScript = Boolean(
      pkg.scripts?.test &&
      pkg.scripts.test !== 'echo "Error: no test specified" && exit 1',
    );
  } catch {
    // Malformed package.json — skip test step
  }

  let testFailCount = 0;
  let testPassCount = 0;

  if (hasTestScript) {
    log("Running npm test...");
    try {
      const output = execFileSync("npm", ["test"], {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf-8",
        timeout,
      });
      // Best-effort parse test counts from output
      const counts = parseTestCounts(output);
      testPassCount = counts.passed;
      testFailCount = counts.failed;
    } catch (e: unknown) {
      const stderr = getErrorStderr(e);
      const stdout = (e as { stdout?: string }).stdout || "";
      const counts = parseTestCounts(stdout + "\n" + stderr);
      testFailCount = counts.failed || 1;
      testPassCount = counts.passed;
      log(`\x1b[31mTests failed (${testFailCount} failure(s), ${testPassCount} passed)\x1b[0m`);
      if (stderr) logStderrPreview(log, stderr);
      return {
        success: false,
        failedPhase: "test",
        error: getErrorMessage(e),
        stderr,
        tscErrorCount: 0,
        testFailCount,
        testPassCount,
      };
    }
  }

  return {
    success: true,
    failedPhase: "none",
    tscErrorCount: 0,
    testFailCount: 0,
    testPassCount,
  };
}

// ─── Stderr Preview ──────────────────────────────────────────────────────

const STDERR_PREVIEW_LINES = 20;

function logStderrPreview(log: (msg: string) => void, stderr: string): void {
  const allLines = stderr.split("\n");
  const preview = allLines.slice(0, STDERR_PREVIEW_LINES);
  for (const line of preview) {
    log(`  ${line}`);
  }
  if (allLines.length > STDERR_PREVIEW_LINES) {
    log(`  ... (${allLines.length - STDERR_PREVIEW_LINES} more lines)`);
  }
}

// ─── Test Output Parsing ─────────────────────────────────────────────────────

/**
 * Best-effort parse test pass/fail counts from test runner output.
 * Handles common patterns from vitest, jest, and mocha.
 */
function parseTestCounts(output: string): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  // Vitest/Jest: "Tests  3 failed | 12 passed"
  const vitestMatch = output.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
  if (vitestMatch) {
    failed = parseInt(vitestMatch[1], 10);
    passed = parseInt(vitestMatch[2], 10);
    return { passed, failed };
  }

  // Vitest/Jest: "12 passed" (no failures) / "X failed"
  const passOnlyMatch = output.match(/(\d+)\s+passed/);
  if (passOnlyMatch) {
    passed = parseInt(passOnlyMatch[1], 10);
  }
  const failMatch = output.match(/(\d+)\s+failed/);
  if (failMatch) {
    failed = parseInt(failMatch[1], 10);
  }
  if (passOnlyMatch || failMatch) {
    return { passed, failed };
  }

  // Mocha: "N passing" / "N failing"
  const mochaPass = output.match(/(\d+)\s+passing/);
  const mochaFail = output.match(/(\d+)\s+failing/);
  if (mochaPass) passed = parseInt(mochaPass[1], 10);
  if (mochaFail) failed = parseInt(mochaFail[1], 10);

  return { passed, failed };
}
