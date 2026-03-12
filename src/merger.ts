import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { git } from "./git.js";
import { createMutex } from "./mutex.js";
import { getErrorMessage, getErrorStderr } from "./errors.js";
import { runBuildValidation, NPM_TIMEOUT_MS } from "./build-validation.js";

// ─── Merge serialization lock ────────────────────────────────────────────────

const serialize = createMutex();

// ─── resetAndThrow helper ───────────────────────────────────────────────────

function resetAndThrow(
  taskId: number,
  label: string,
  error: unknown,
  verbose: boolean,
): never {
  try {
    git(["reset", "--hard", "HEAD"], { verbose });
  } catch (resetErr) {
    console.error(`[merger] git reset also failed for task ${taskId}: ${getErrorMessage(resetErr)}`);
  }
  throw new Error(
    `${label} failed for task ${taskId}: ${getErrorStderr(error) || getErrorMessage(error)}`,
  );
}

// ─── squashMerge ─────────────────────────────────────────────────────────────

export async function squashMerge(
  taskId: number,
  slug: string,
  featureBranch: string,
  commitMessage: string,
  verbose: boolean,
): Promise<void> {
  return serialize(async () => {
    const taskBranch = `${featureBranch}-t${taskId}`;
    try {
      // Guard: reset current HEAD if dirty (may be on any branch after a crash).
      // A prior failed merge may have left MERGE_HEAD, staged changes, or
      // an in-progress merge/rebase state on the current or a task branch.
      const status = git(["status", "--porcelain"], { verbose });
      if (status.length > 0) {
        console.error(`[merger] dirty index detected before merge for task ${taskId}, resetting`);
        try { git(["merge", "--abort"], { verbose }); } catch {}
        try { git(["reset", "--hard", "HEAD"], { verbose }); } catch {}
      }

      // Resolve repo root so npm commands run from the right directory
      const repoRoot = git(["rev-parse", "--show-toplevel"], { verbose });

      // Step 1: Trial merge — checkout feature branch and attempt squash merge
      git(["checkout", featureBranch], { verbose });

      // Defense-in-depth: clean up ephemeral files that agents may have committed
      // to the task branch despite being instructed to write to the artifacts directory.
      const ephemeralFiles = [".memory-entry.md", `.brief-t${taskId}.md`, ".qa-report.md"];
      for (const f of ephemeralFiles) {
        try { fs.unlinkSync(f); } catch {}
      }

      try {
        git(["merge", "--squash", "--no-commit", taskBranch], { verbose });
      } catch {
        // Step 2: Conflict resolution
        try {
          const conflictOutput = git(
            ["diff", "--name-only", "--diff-filter=U"],
            { verbose },
          );
          const conflictFiles = conflictOutput.split("\n").filter(Boolean);
          const pkgConflicts = conflictFiles.filter(
            (f) => f === "package.json" || f === "package-lock.json",
          );

          if (pkgConflicts.length === conflictFiles.length && conflictFiles.length > 0) {
            // All conflicts are package files — auto-resolve
            for (const f of pkgConflicts) {
              git(["checkout", "--theirs", f], { verbose });
              git(["add", f], { verbose });
            }
            execFileSync("npm", ["install"], {
              cwd: repoRoot,
              stdio: "pipe",
              encoding: "utf-8",
              timeout: NPM_TIMEOUT_MS,
            });
            git(["add", "package-lock.json"], { verbose });
          } else {
            // Other conflicts — abort, squash task branch, rebase, retry
            // --squash does not create MERGE_HEAD, so merge --abort won't work.
            // reset --hard restores the feature branch to its pre-merge state.
            git(["reset", "--hard", "HEAD"], { verbose });

            // Squash task branch to a single commit
            git(["checkout", taskBranch], { verbose });
            git(["reset", "--soft", featureBranch], { verbose });
            git(["commit", "-m", `squashed: ${commitMessage}`], { verbose });

            // Rebase onto feature branch
            try {
              git(["rebase", featureBranch], { verbose });
            } catch {
              git(["rebase", "--abort"], { verbose });
              throw new Error(
                `Rebase conflicts for task ${taskId} — marking failed`,
              );
            }

            // Retry trial merge
            git(["checkout", featureBranch], { verbose });
            git(["merge", "--squash", "--no-commit", taskBranch], { verbose });
          }
        } catch (resolveErr) {
          try {
            git(["reset", "--hard", "HEAD"], { verbose });
          } catch {}
          try {
            git(["checkout", featureBranch], { verbose });
          } catch {}
          throw resolveErr;
        }
      }

      // Remove ephemeral files from staging and disk before commit
      try {
        git(["reset", "HEAD", "--", ...ephemeralFiles], { verbose });
      } catch {}
      for (const f of ephemeralFiles) {
        try { fs.unlinkSync(f); } catch {}
      }

      // Step 3: Validate — install deps (if needed) and run build
      const buildResult = runBuildValidation(repoRoot, { cleanInstall: false, timeout: NPM_TIMEOUT_MS });

      // Stage lockfile in case npm install updated it
      if (fs.existsSync(`${repoRoot}/package.json`)) {
        try {
          git(["add", "package-lock.json"], { verbose });
        } catch {}
      }

      if (!buildResult.success) {
        const phaseLabels: Record<string, string> = {
          install: "Dependency installation",
          typecheck: "Type check",
          build: "Build validation",
          test: "Test suite",
        };
        const label = phaseLabels[buildResult.failedPhase] || buildResult.failedPhase;
        resetAndThrow(taskId, label, new Error(buildResult.stderr || buildResult.error || "unknown error"), verbose);
      }

      // Step 4: Commit
      git(["commit", "-m", commitMessage], { verbose });
    } catch (e) {
      // Recovery: ensure feature branch is clean for the next queued merge.
      // Note: resetAndThrow() already calls reset --hard for build failures,
      // but this outer catch also handles commit failures, checkout failures,
      // and other paths where reset hasn't run yet.
      try { git(["merge", "--abort"], { verbose }); } catch {}
      try { git(["checkout", featureBranch], { verbose }); } catch {}
      try { git(["reset", "--hard", "HEAD"], { verbose }); } catch {}
      throw e;
    }
  });
}

// ─── abortAndRecover (nuclear option) ────────────────────────────────────────

export function abortAndRecover(
  featureBranch: string,
  verbose: boolean,
): void {
  try {
    git(["merge", "--abort"], { verbose });
  } catch {}
  try {
    git(["checkout", featureBranch], { verbose });
  } catch {}
  try {
    git(["reset", "--hard", "HEAD"], { verbose });
  } catch {}
}
