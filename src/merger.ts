import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

// ─── Merge serialization lock ────────────────────────────────────────────────

let mergeLock: Promise<void> = Promise.resolve();

// ─── git helper ──────────────────────────────────────────────────────────────

function git(
  args: string[],
  opts?: { cwd?: string; verbose?: boolean },
): string {
  if (opts?.verbose) {
    console.error(
      `\x1b[90m$ git ${args.join(" ")}${opts?.cwd ? ` (cwd: ${opts.cwd})` : ""}\x1b[0m`,
    );
  }
  try {
    return execFileSync("git", args, {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() || "";
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || e.message}`);
  }
}

// ─── resetAndThrow helper ───────────────────────────────────────────────────

function resetAndThrow(
  taskId: number,
  label: string,
  error: any,
  verbose: boolean,
): never {
  try {
    git(["reset", "--hard", "HEAD"], { verbose });
  } catch {}
  throw new Error(
    `${label} failed for task ${taskId}: ${error.stderr?.toString?.() || error.message}`,
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
  const prev = mergeLock;
  let resolve!: () => void;
  mergeLock = new Promise<void>((r) => {
    resolve = r;
  });
  await prev;

  const taskBranch = `${featureBranch}-t${taskId}`;
  try {
    // Resolve repo root so npm commands run from the right directory
    const repoRoot = git(["rev-parse", "--show-toplevel"], { verbose });

    // Step 1: Trial merge — checkout feature branch and attempt squash merge
    git(["checkout", featureBranch], { verbose });

    // Remove ephemeral files from disk
    try {
      fs.unlinkSync(".memory-entry.md");
    } catch {}
    try {
      fs.unlinkSync(`.brief-t${taskId}.md`);
    } catch {}

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
          });
          git(["add", "package-lock.json"], { verbose });
        } else {
          // Other conflicts — abort, squash task branch, rebase, retry
          git(["merge", "--abort"], { verbose });

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
          git(["merge", "--abort"], { verbose });
        } catch {}
        try {
          git(["checkout", featureBranch], { verbose });
        } catch {}
        throw resolveErr;
      }
    }

    // Remove ephemeral files from staging before commit
    try {
      git(
        ["reset", "HEAD", "--", ".memory-entry.md", `.brief-t${taskId}.md`],
        { verbose },
      );
    } catch {}

    // Step 3: Validate — install deps (if needed) and run build
    // Skip validation entirely for non-npm projects (no package.json)
    const hasPkgJson = fs.existsSync(`${repoRoot}/package.json`);
    if (hasPkgJson) {
      try {
        execFileSync("npm", ["install"], {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (e: any) {
        resetAndThrow(taskId, "Dependency installation", e, verbose);
      }

      // Stage lockfile in case npm install updated it
      try {
        git(["add", "package-lock.json"], { verbose });
      } catch {}

      try {
        execFileSync("npm", ["run", "build"], {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (e: any) {
        resetAndThrow(taskId, "Build validation", e, verbose);
      }
    }

    // Step 4: Commit
    git(["commit", "-m", commitMessage], { verbose });
  } catch (e) {
    try {
      git(["merge", "--abort"], { verbose });
    } catch {}
    try {
      git(["checkout", featureBranch], { verbose });
    } catch {}
    throw e;
  } finally {
    resolve();
  }
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
