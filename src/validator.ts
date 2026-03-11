import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import type {
  Task,
  ProjectType,
  SmokeTestResult,
  IntegrationGateResult,
  BuildValidationResult,
  ValidationMetrics,
  Provider,
  QAReport,
  FixerResult,
} from "./types.js";
import { runBuildValidation } from "./build-validation.js";
import { runFixerLoop, isCodeFixable } from "./fixer.js";
import { runQAPhase, isPlaywrightMCPAvailable } from "./qa.js";

// ─── Cleanup Set ─────────────────────────────────────────────────────────────

/** Module-level set of processes to kill on SIGINT. */
export const gateCleanupProcesses: Set<ChildProcess> = new Set();

// ─── Project Type Detection ──────────────────────────────────────────────────

export function detectProjectType(repoRoot: string): ProjectType {
  // Most specific first
  const nextConfigs = ["next.config.js", "next.config.mjs", "next.config.ts"];
  for (const cfg of nextConfigs) {
    if (fs.existsSync(path.join(repoRoot, cfg))) return "nextjs";
  }

  const viteConfigs = ["vite.config.js", "vite.config.mjs", "vite.config.ts"];
  for (const cfg of viteConfigs) {
    if (fs.existsSync(path.join(repoRoot, cfg))) return "vite";
  }

  // Check package.json for framework deps and fields
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return "generic";

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // API server detection
    const serverFrameworks = ["express", "fastify", "hono", "koa"];
    for (const fw of serverFrameworks) {
      if (allDeps[fw]) return "express";
    }

    // CLI tool
    if (pkg.bin) return "cli";

    // Library (has main/exports but no framework)
    if (pkg.main || pkg.exports) return "library";
  } catch {
    // Malformed package.json
  }

  return "generic";
}

// ─── Port Hashing ────────────────────────────────────────────────────────────

/** DJB2 hash → deterministic port in [10000, 60000). */
export function hashPort(branchName: string): number {
  let hash = 5381;
  for (let i = 0; i < branchName.length; i++) {
    hash = ((hash << 5) + hash + branchName.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 50000) + 10000;
}

// ─── Port Check ──────────────────────────────────────────────────────────────

function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection({ port, host });
    conn.setTimeout(1000);
    conn.on("connect", () => { conn.destroy(); resolve(true); });
    conn.on("error", () => { conn.destroy(); resolve(false); });
    conn.on("timeout", () => { conn.destroy(); resolve(false); });
  });
}

function isPortReady(port: number): Promise<boolean> {
  return Promise.all([
    tryConnect(port, "127.0.0.1"),
    tryConnect(port, "::1"),
  ]).then(([v4, v6]) => v4 || v6);
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortReady(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ─── Process Cleanup ─────────────────────────────────────────────────────────

function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid || proc.killed) {
      resolve();
      return;
    }
    proc.kill("SIGTERM");
    const forceKillTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, 5000);
    proc.on("close", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
  });
}

// ─── App Server Lifecycle ────────────────────────────────────────────────────

export function getStartCommand(
  projectType: ProjectType,
  port: number,
): { cmd: string; args: string[] } {
  switch (projectType) {
    case "nextjs":
      return { cmd: "npx", args: ["next", "start", "--hostname", "127.0.0.1", "-p", String(port)] };
    case "vite":
      return { cmd: "npx", args: ["vite", "preview", "--host", "127.0.0.1", "--port", String(port)] };
    case "express":
      return { cmd: "npm", args: ["start"] };
    default:
      return { cmd: "npm", args: ["start"] };
  }
}

/** Start app server and wait for port readiness. Caller is responsible for stopping. */
export async function startAppServer(
  repoRoot: string,
  projectType: ProjectType,
  opts: { branch: string; verbose?: boolean },
): Promise<{ process: ChildProcess; port: number; appUrl: string } | { error: string }> {
  const basePort = hashPort(opts.branch);
  let port = basePort;

  for (let attempt = 0; attempt < 5; attempt++) {
    port = basePort + attempt;
    const portInUse = await isPortReady(port);
    if (!portInUse) break;
    if (attempt === 4) {
      return { error: `All ports ${basePort}-${port} in use` };
    }
  }

  const startCmd = getStartCommand(projectType, port);
  if (opts.verbose) {
    console.log(`  Running: ${startCmd.cmd} ${startCmd.args.join(" ")}`);
  }

  const appProcess = nodeSpawn(startCmd.cmd, startCmd.args, {
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env, PORT: String(port) },
  });
  gateCleanupProcesses.add(appProcess);

  const MAX_STDERR_BYTES = 8192;
  let stderrBuf = "";
  appProcess.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBuf.length < MAX_STDERR_BYTES) {
      stderrBuf += chunk.toString().slice(0, MAX_STDERR_BYTES - stderrBuf.length);
    }
  });

  let exited = false;
  appProcess.on("close", () => { exited = true; });

  const ready = await waitForPort(port, 60_000);
  if (exited) {
    gateCleanupProcesses.delete(appProcess);
    return { error: `App process exited before port was ready${stderrBuf ? `\n${stderrBuf}` : ""}` };
  }
  if (!ready) {
    gateCleanupProcesses.delete(appProcess);
    await killProcess(appProcess);
    return { error: `Port ${port} not ready within 60s${stderrBuf ? `\n${stderrBuf}` : ""}` };
  }

  return { process: appProcess, port, appUrl: `http://127.0.0.1:${port}` };
}

export async function stopAppServer(appProcess: ChildProcess): Promise<void> {
  gateCleanupProcesses.delete(appProcess);
  await killProcess(appProcess);
}

// ─── Smoke Test ──────────────────────────────────────────────────────────────

export async function runSmokeTest(
  repoRoot: string,
  projectType: ProjectType,
  appUrl?: string,
): Promise<SmokeTestResult> {
  if (projectType === "generic") {
    return { success: true, projectType, error: "Smoke test skipped for generic project type" };
  }

  if (projectType === "library") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
      const entryPoint = pkg.main || (typeof pkg.exports === "string" ? pkg.exports : undefined);
      if (entryPoint) {
        const entryPath = path.join(repoRoot, entryPoint);
        if (!fs.existsSync(entryPath)) {
          return { success: false, projectType, error: `Entry point not found: ${entryPoint}` };
        }
      }
    } catch (e) {
      return { success: false, projectType, error: `Failed to check library entry: ${(e as Error).message}` };
    }
    return { success: true, projectType };
  }

  if (projectType === "cli") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
      const binName = typeof pkg.bin === "string"
        ? pkg.bin
        : Object.values(pkg.bin as Record<string, string>)[0];
      if (!binName) {
        return { success: false, projectType, error: "No bin entry found" };
      }
      const binPath = path.join(repoRoot, binName);
      if (!fs.existsSync(binPath)) {
        return { success: false, projectType, error: `Bin file not found: ${binName}` };
      }
      return { success: true, projectType };
    } catch (e) {
      return { success: false, projectType, error: `CLI check failed: ${(e as Error).message}` };
    }
  }

  // Web apps: verify HTTP response (server already started by caller)
  if (!appUrl) {
    return { success: false, projectType, error: "No app URL — server not started" };
  }

  try {
    const response = await fetch(appUrl);
    if (!response.ok && response.status >= 500) {
      return { success: false, projectType, error: `HTTP check returned ${response.status}`, appUrl };
    }
  } catch (e) {
    return { success: false, projectType, error: `HTTP check failed: ${(e as Error).message}`, appUrl };
  }

  return { success: true, projectType, appUrl };
}

// ─── Metrics Extraction ─────────────────────────────────────────────────────

function extractMetrics(
  buildResult: BuildValidationResult,
  smokeResult?: SmokeTestResult,
  qaReport?: QAReport,
): ValidationMetrics {
  return {
    tscErrorCount: buildResult.tscErrorCount,
    testFailCount: buildResult.testFailCount,
    buildPasses: buildResult.success,
    smokeTestPasses: smokeResult?.success ?? true,
    qaFailures: qaReport?.totalFailed ?? 0,
  };
}

// ─── Integration Gate Orchestrator ───────────────────────────────────────────

export interface IntegrationGateOpts {
  branch: string;
  provider: Provider;
  model: string;
  skipSmoke: boolean;
  skipQA: boolean;
  noFixer: boolean;
  fixerPatience: number;
  verbose: boolean;
  projectDir: string;
  designPath?: string;
  manifestPath?: string;
}

export async function runIntegrationGate(
  repoRoot: string,
  tasks: Task[],
  opts: IntegrationGateOpts,
): Promise<IntegrationGateResult> {
  const phases: string[] = [];
  let appProcess: ChildProcess | undefined;

  try {
    // Phase 1: Clean Build Validation
    console.log("\n\x1b[1m[Integration Gate] Phase 1: Clean Build Validation\x1b[0m");
    const buildResult = runBuildValidation(repoRoot, { cleanInstall: true, verbose: opts.verbose });
    phases.push("build");

    if (buildResult.success) {
      console.log("  \x1b[32mBuild validation passed\x1b[0m");
    } else {
      console.log(`  \x1b[31mBuild validation failed at: ${buildResult.failedPhase}\x1b[0m`);
      if (buildResult.tscErrorCount > 0) {
        console.log(`  TypeScript errors: ${buildResult.tscErrorCount}`);
      }
    }

    // Phase 2: Smoke Test
    let smokeResult: SmokeTestResult | undefined;
    if (!opts.skipSmoke) {
      console.log("\n\x1b[1m[Integration Gate] Phase 2: Smoke Test\x1b[0m");
      const projectType = detectProjectType(repoRoot);
      console.log(`  Detected project type: ${projectType}`);

      // For web apps, start the server (kept alive for QA phase)
      const isWebApp = projectType === "nextjs" || projectType === "vite" || projectType === "express";
      let appUrl: string | undefined;

      if (isWebApp && buildResult.success) {
        console.log("  Starting app server...");
        const serverResult = await startAppServer(repoRoot, projectType, { branch: opts.branch, verbose: opts.verbose });
        if ("error" in serverResult) {
          console.log(`  \x1b[31mServer failed: ${serverResult.error}\x1b[0m`);
          smokeResult = { success: false, projectType, error: serverResult.error };
        } else {
          appProcess = serverResult.process;
          appUrl = serverResult.appUrl;
          console.log(`  Server ready at ${appUrl}, running HTTP check...`);
          smokeResult = await runSmokeTest(repoRoot, projectType, appUrl);
        }
      } else {
        // Non-web project types (library, cli, generic) — no server needed
        smokeResult = await runSmokeTest(repoRoot, projectType);
      }

      phases.push("smoke");

      if (smokeResult.success) {
        console.log("  \x1b[32mSmoke test passed\x1b[0m");
      } else {
        console.log(`  \x1b[31mSmoke test failed: ${smokeResult.error}\x1b[0m`);
      }
    }

    // Phase 3: Playwright QA (web apps only, if MCP available, server still running)
    let qaReport: QAReport | undefined;
    if (!opts.skipQA && smokeResult?.appUrl && appProcess && isPlaywrightMCPAvailable(repoRoot)) {
      console.log("\n\x1b[1m[Integration Gate] Phase 3: Playwright QA\x1b[0m");
      qaReport = await runQAPhase(repoRoot, tasks, opts.provider, opts.model, smokeResult.appUrl, {
        verbose: opts.verbose,
        projectDir: opts.projectDir,
      });
      phases.push("qa");

      if (qaReport.totalFailed === 0) {
        console.log(`  \x1b[32mQA passed: ${qaReport.totalPassed} features verified\x1b[0m`);
      } else {
        console.log(`  \x1b[31mQA: ${qaReport.totalFailed} failures, ${qaReport.totalPassed} passed\x1b[0m`);
      }
    } else if (!opts.skipQA) {
      if (!smokeResult?.appUrl || !appProcess) {
        console.log("\n  \x1b[33mSkipping QA: no running app server\x1b[0m");
      } else {
        console.log("\n  \x1b[33mSkipping QA: Playwright MCP not available\x1b[0m");
      }
    }

    // Stop app server after QA — no longer needed
    if (appProcess) {
      await stopAppServer(appProcess);
      appProcess = undefined;
    }

    // Check if any phase failed
    const anyFailed = !buildResult.success ||
      (smokeResult && !smokeResult.success) ||
      (qaReport && qaReport.totalFailed > 0);

    // Phase 4: Fixer Agent (if any failures and fixer is enabled)
    let fixerResult: FixerResult | undefined;
    if (anyFailed && !opts.noFixer) {
      const codeFixable = isCodeFixable(buildResult, smokeResult, qaReport);

      if (!codeFixable) {
        console.log("\n\x1b[33m[Integration Gate] Skipping fixer — failures are infrastructure-only (not code-fixable)\x1b[0m");
        if (smokeResult && !smokeResult.success) {
          console.log(`  Smoke test error: ${smokeResult.error}`);
        }
      } else {
        console.log("\n\x1b[1m[Integration Gate] Phase 4: Fixer Agent\x1b[0m");
        const initialMetrics = extractMetrics(buildResult, smokeResult, qaReport);
        const errorContext = { buildResult, smokeResult, qaReport };

        fixerResult = await runFixerLoop(repoRoot, opts.branch, tasks, initialMetrics, errorContext, opts.provider, opts.model, {
          fixerPatience: opts.fixerPatience,
          verbose: opts.verbose,
          projectDir: opts.projectDir,
          skipSmoke: opts.skipSmoke,
          skipQA: opts.skipQA,
          designPath: opts.designPath,
          manifestPath: opts.manifestPath,
        });
        phases.push("fixer");

        if (fixerResult.converged) {
          console.log(`  \x1b[32mFixer converged after ${fixerResult.rounds} round(s)\x1b[0m`);
        } else {
          console.log(`  \x1b[31mFixer did not converge after ${fixerResult.rounds} round(s)\x1b[0m`);
        }
      }
    }

    const finalSuccess = fixerResult
      ? fixerResult.converged
      : !anyFailed;

    return {
      finalSuccess,
      buildResult,
      smokeResult,
      qaReport,
      fixerResult,
      phases,
    };
  } finally {
    // Ensure app server is always cleaned up
    if (appProcess) {
      await stopAppServer(appProcess);
    }
  }
}
