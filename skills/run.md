---
name: run
description: Launch the liteboard orchestrator and enter supervisor mode. Monitors progress, retries failures, and reports status until all tasks complete.
---

# Liteboard Run

You are launching the liteboard orchestrator and entering supervisor mode. Your job is to monitor the build, handle failures, and report progress to the user.

## Step 1: Resolve Project

Resolve the project path from the argument:
- If a slug is provided: `docs/liteboard/<slug>/`
- If a full path is provided: use it directly

Verify `manifest.md` exists in the project directory. If not, tell the user to run `/liteboard:task-manifest` first.

## Step 2: Launch Orchestrator

Launch the orchestrator via the Bash tool with `run_in_background: true`:

```
liteboard run <project-path> --concurrency=<N> --verbose
```

Default concurrency is 1. Ask the user if they want to increase it.

## Step 3: Supervisor Loop

After launching, enter the supervisor loop. Your goal is to stay cheap — read small files, tail logs only on failure.

### Each Check-In Cycle

1. **Read `progress.md`** via the Read tool (~50 lines, cheap) — it has a **Sessions table** and a **Tasks table**
2. **Evaluate changes** since last check:

#### On Session Completed
- Tail last 20 lines of the session log via Bash: `tail -20 <projectDir>/logs/s<N>.jsonl`
- Confirm: Did review subagents run? Did tests pass? Was merge clean?
- Report to user: "S<N> done (tasks T1, T2, T3). X/Y sessions complete."

#### On Session Failed
- Read failure summary from progress.md Sessions table first (cheap)
- If more detail needed: `tail -50 <projectDir>/logs/s<N>.jsonl`
- Diagnose the failure category:
  - **Merge conflict**: Check if retriable after blocking sessions complete
  - **Build error**: Check if it's a dependency issue or code error
  - **Agent stall**: Likely API throttling or session limit
  - **Agent crash**: Check stderr in log
- If retriable: note for retry (max 2 retries per session, 3 total attempts)
- If unrecoverable: flag to user with summary and recommendation

#### On All Sessions Done
- Final summary: total sessions done, total failed, tasks completed, elapsed time
- Show the feature branch name
- Prompt user: "Ready to create a PR? I can run `/commit` to set that up."
- Exit supervisor loop

#### On Nothing New
- Brief status line: "X/Y sessions done, S<N>+S<M> running (Z min), no issues"

### Cross-Session Breakage Detection
If a session fails that other sessions depend on, flag the cascade:
> "S3 failed. This blocks S5 and S6 which depend on it. Consider fixing S3 first."

3. **Adaptive Wait** — sleep via Bash tool (`sleep <seconds>`):
   - Session completed or failed in last check → wait **5 minutes** (300s)
   - Steady state, sessions running normally → wait **15 minutes** (900s)
   - Long-running sessions, no changes for 2+ checks → wait **25 minutes** (1500s)

### What the Supervisor Does
- Reads progress.md Sessions and Tasks tables (cheap) to track status
- Tails session logs on failure for diagnosis (last 50 lines max)
- Reports progress to user periodically
- Detects cross-session breakage cascades
- Tracks retry counts per session

### What the Supervisor Does NOT Do
- Read full agent logs (too expensive for context)
- Evaluate code quality (that's the review subagents' job inside each session)
- Deeply analyze what agents are building
- Intervene in running sessions that aren't failing
- Make code changes directly

## Retry Protocol

When retrying a failed session:
1. Note the failure reason
2. Wait for the current orchestrator run to finish or reach a stable state
3. Suggest to the user: "S<N> failed due to <reason>. Want me to retry it? I'll run `liteboard run <project> --tasks=<T1>,<T2>` (listing the task IDs in that session)"
4. On user approval, launch a new orchestrator run with `--tasks=<N>` (sessions are rebuilt from filtered tasks automatically)
5. Re-enter supervisor loop for the retry

## Error Recovery

If the orchestrator process itself crashes:
1. Read the last few lines of any active log files
2. Check git status for any in-progress merges
3. Report the situation to the user
4. Suggest: "The orchestrator crashed. Want me to restart? Any in-progress work is safe in worktrees."
