import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { git } from "./git.js";
import { createMutex } from "./mutex.js";
import { getErrorMessage, getErrorStderr } from "./errors.js";
import { runBuildValidation, NPM_TIMEOUT_MS } from "./build-validation.js";
import type { Session } from "./types.js";

// ─── Merge serialization lock ────────────────────────────────────────────────

const serialize = createMutex();

// ─── resetAndThrow helper ───────────────────────────────────────────────────

function resetAndThrow(error: unknown, verbose: boolean): never {
  try {
    git(["reset", "--hard", "HEAD"], { verbose });
  } catch (resetErr) {
    console.error(`[merger] git reset also failed: ${getErrorMessage(resetErr)}`);
  }
  throw new Error(getErrorStderr(error) || getErrorMessage(error));
}

// ─── commitViaFile helper ─────────────────────────────────────────────────────

function commitViaFile(sessionId: string, message: string, verbose: boolean): void {
  const msgFile = path.join(tmpdir(), `commit-msg-s${sessionId}.txt`);
  fs.writeFileSync(msgFile, message);
  try {
    git(["commit", "-F", msgFile], { verbose });
  } finally {
    try { fs.unlinkSync(msgFile); } catch {}
  }
}

// ─── buildCommitMessage ───────────────────────────────────────────────────────

function buildCommitMessage(session: Session): string {
  if (session.tasks.length === 1) {
    return session.tasks[0].commitMessage;
  }
  const lines = session.tasks.map(t => `- task ${t.id}: ${t.commitMessage}`).join("\n");
  return `session S${session.id}: ${session.focus}\n\n${lines}`;
}

// ─── squashMerge ─────────────────────────────────────────────────────────────

export async function squashMerge(
  session: Session,
  featureBranch: string,
  verbose: boolean,
): Promise<void> {
  return serialize(async () => {
    const sessionBranch = session.branchName ?? `${featureBranch}-s${session.id}`;
    const commitMessage = buildCommitMessage(session);
    const ephemeralFiles = [".memory-entry.md", `.brief-s${session.id}.md`, ".qa-report.md"];

    try {
      // Guard: reset current HEAD if dirty (may be on any branch after a crash).
      // A prior failed merge may have left MERGE_HEAD, staged changes, or
      // an in-progress merge/rebase state on the current or a session branch.
      const status = git(["status", "--porcelain"], { verbose });
      if (status.length > 0) {
        console.error(`[merger] dirty index detected before merge for session ${session.id}, resetting`);
        try { git(["merge", "--abort"], { verbose }); } catch {}
        try { git(["reset", "--hard", "HEAD"], { verbose }); } catch {}
      }

      // Resolve repo root so npm commands run from the right directory
      const repoRoot = git(["rev-parse", "--show-toplevel"], { verbose });

      // Step 1: Trial merge — checkout feature branch and attempt squash merge
      git(["checkout", featureBranch], { verbose });

      // Defense-in-depth: clean up ephemeral files that agents may have committed
      // to the session branch despite being instructed to write to the artifacts directory.
      for (const f of ephemeralFiles) {
        try { fs.unlinkSync(f); } catch {}
      }

      try {
        git(["merge", "--squash", "--no-commit", sessionBranch], { verbose });
      } catch {
        // Step 2: Conflict resolution
        try {
          // All conflicts fail the merge — triage decides recovery strategy.
          // Abort, squash session branch, rebase, retry.
          // --squash does not create MERGE_HEAD, so merge --abort won't work.
          // reset --hard restores the feature branch to its pre-merge state.
          git(["reset", "--hard", "HEAD"], { verbose });

          // Squash session branch to a single commit
          git(["checkout", sessionBranch], { verbose });
          git(["reset", "--soft", featureBranch], { verbose });
          commitViaFile(session.id, `squashed: ${commitMessage}`, verbose);

          // Rebase onto feature branch
          try {
            git(["rebase", featureBranch], { verbose });
          } catch {
            git(["rebase", "--abort"], { verbose });
            throw new Error(
              `Rebase conflicts for session ${session.id} — marking failed`,
            );
          }

          // Retry trial merge
          git(["checkout", featureBranch], { verbose });
          git(["merge", "--squash", "--no-commit", sessionBranch], { verbose });
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
        resetAndThrow(
          new Error(`${label} failed for session ${session.id}: ${buildResult.stderr || buildResult.error || "unknown error"}`),
          verbose,
        );
      }

      // Step 4: Commit
      commitViaFile(session.id, commitMessage, verbose);
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
