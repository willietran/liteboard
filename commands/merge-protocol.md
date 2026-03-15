# Merge Protocol

This document describes what the liteboard orchestrator does after a session agent exits successfully. You do not perform these steps -- the orchestrator handles them automatically.

## What Happens After You Exit

When you exit 0, the liteboard orchestrator:

1. Checks out the feature branch
2. Runs `git merge --squash --no-commit` of your session branch
3. If conflict: squashes your branch, rebases onto the feature branch, and retries the merge
4. Runs build validation: `npm install` -> `npx tsc --noEmit` -> `npm run build` -> `npm test`
5. Commits with your session's combined commit message
6. Cleans up your worktree and session branch

## What This Means For You

- **Commit your work to your session branch** -- the orchestrator handles the merge to the feature branch.
- **Ensure your code builds and tests pass BEFORE exiting.** The orchestrator runs build validation after merging, and merge failures are expensive.
- **If merge validation fails**, the orchestrator may retry your session with a fresh worktree rebased on the latest feature branch.
- **Write clean, focused commits** that merge cleanly. Avoid unnecessary formatting changes or unrelated modifications that increase merge conflict risk.

## When You Exit Non-Zero

If you exit with a non-zero code, the orchestrator:

1. Logs your failure output for debugging
2. Cleans up your worktree and session branch
3. Marks your session as failed
4. Blocks any downstream sessions that depend on yours

Sessions that do not depend on yours continue running unaffected. The orchestrator may retry your session depending on the failure type and retry policy.
