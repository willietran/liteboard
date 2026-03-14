# Session-Based Scheduling

**Status:** Draft
**Date:** 2026-03-13

## Problem

Each liteboard task currently gets its own agent spawn, worktree, plan review, and code review. For a manifest with 9 tasks, that's up to 9 agent spawns and 18 review gates (plan + code). Each task takes 10-15 minutes, and a significant portion of that time is overhead from review gates and agent startup — not implementation work.

Tasks within the same dependency layer are often related and would benefit from being implemented by a single agent with holistic context. Grouping them reduces review overhead while preserving quality through fewer but more comprehensive reviews.

## Solution

Introduce **sessions** as the scheduling unit. A session groups same-layer tasks that are assigned to one agent, one worktree, one plan review, and one code review. The orchestrator schedules, spawns, reviews, and merges at the session level. Tasks remain the inner unit — agents commit per task, progress tracks per task.

## Core Properties

- One session = one agent spawn, one worktree, one plan, one plan review, one code review, one squash merge
- Sessions within the same layer run in parallel (up to concurrency limit)
- Cross-session dependencies are derived from task-level dependencies
- A session is "ready" when all dependencies of all its constituent tasks are satisfied
- QA tasks remain their own sessions — they are validation gates, not implementation work
- Complexity budget: sessions cap at total complexity ~10-12 to manage context window usage

## Data Model

### New Types

```typescript
interface Session {
  // Identity
  id: string;            // "S1", "S2", etc. — sequential numbering
  tasks: Task[];         // ordered list of tasks in this session
  complexity: number;    // sum of task complexities
  focus: string;         // human-readable description from manifest

  // Runtime state (managed by orchestrator, not parsed from manifest)
  status: SessionStatus;
  process?: ChildProcess;
  worktreePath?: string;
  branchName?: string;        // "${featureBranch}-s${id}" e.g. "my-feature-s1"
  startedAt?: string;
  completedAt?: string;
  bytesReceived: number;
  turnCount: number;
  lastLine: string;
  stage: string;              // Free-form: "Exploring", "Planning", "Implementing T1", etc.
                              // Not validated against VALID_STAGE_MARKERS — stage markers
                              // from agent output are matched by prefix (e.g., "Implementing"
                              // matches regardless of task suffix)
  logPath?: string;
  provider?: string;
  attemptCount: number;
}

type SessionStatus = "queued" | "blocked" | "running" | "merging" | "done" | "failed" | "needs_human";
```

Runtime fields mirror the existing `Task` runtime fields but live on `Session` — the orchestrator manages these during execution. Individual `Task` objects within a session retain their own `status` field to track per-task completion within the session.

### Manifest Format

The manifest already includes per-task `Suggested Session` fields and a session-grouping hints table. No format changes needed:

- Each task has `**Suggested Session:** SN`
- The manifest has a `Session-Grouping Hints` table with session ID, tasks, focus, and estimated context

Sessions are numbered sequentially (S1, S2, S3...). If grouping changes cause splits, renumber — no sub-IDs.

Note: `Suggested Session` is present in manifests but not yet parsed by `parser.ts`. This feature adds parsing support for it.

### Example Session Table

From the triage-agent manifest, regrouped to split the original S1 (complexity 14) into two sessions:

| Session | Tasks | Layer | Total Complexity | Focus |
|---------|-------|-------|-----------------|-------|
| S1 | T1, T5 | 0 | 8 | Types/config + brief improvements |
| S2 | T2, T3 | 0 | 6 | Git cleanup + spawner resilience |
| S3 | T4 | 1 | 5 | Core triage module |
| S4 | T6 (QA) | 2 | 3 | QA gate |
| S5 | T7 | 3 | 5 | Triage orchestration |
| S6 | T8 | 4 | 5 | CLI integration |
| S7 | T9 (QA) | 5 | 3 | Final QA |

## Naming Conventions

### Worktree Paths and Branches

Currently, worktrees use `${featureBranch}-t${taskId}` for branch names and `getWorktreePath(slug, taskId)` for paths. All worktree functions (`getWorktreePath`, `createWorktree`, `cleanupWorktree`, `recreateWorktreeFromBranch`, `cleanupAllWorktrees`) take `taskId: number`.

For sessions, these functions change their identifier parameter from `taskId: number` to `sessionId: string`:

- `getWorktreePath(slug: string, sessionId: string): string`
- `createWorktree(slug: string, sessionId: string, featureBranch: string, verbose: boolean): string`
- `cleanupWorktree(slug: string, sessionId: string, featureBranch: string, verbose: boolean, preserveBranch?: boolean): void`
- `recreateWorktreeFromBranch(slug: string, sessionId: string, featureBranch: string, verbose: boolean): string`
- `cleanupAllWorktrees(slug: string, sessions: Session[], featureBranch: string, verbose: boolean): void` — iterates sessions instead of tasks. The current `opts.preserveFailedBranches` behavior is preserved: failed sessions' branches are kept for triage `resume_from_branch` recovery.

Naming:
- **Branch name:** `${featureBranch}-s${sessionId}` (e.g., `my-feature-s1`)
- **Worktree path:** derived from `getWorktreePath(slug, sessionId)`
- **Log files:** `s${sessionId}.jsonl` (e.g., `s1.jsonl`) instead of `t${taskId}.jsonl`

Single-task sessions use the same naming — there's no special case for sessions with one task.

### Plan File Path

- **Session plan:** `artifacts/s${sessionId}-session-plan.md` (e.g., `artifacts/s1-session-plan.md`)
- Replaces per-task `artifacts/t${taskId}-task-plan.md` for multi-task sessions
- Single-task sessions use the same session-level path for consistency

## Module Changes

### `types.ts`

Add `Session`, `SessionStatus` types with full runtime fields as specified in the data model above. No changes to existing `Task` type — tasks retain their `status` field for tracking per-task completion within a session.

### `parser.ts`

- Parse `Suggested Session` field from each task record via `parseSingleValue()`
- Parse the session-grouping hints table for `focus` values
- New exported function: `parseSessions(tasks: Task[], manifest: string): Session[]`
  - Groups tasks by their `Suggested Session` value
  - Populates `complexity` (sum of task complexities), `focus` (from hints table)
  - Validates: all tasks have a session assignment, no session spans multiple layers
  - Initializes runtime fields to defaults (`status: "queued"`, `bytesReceived: 0`, `attemptCount: 0`, etc.)
- Continue exporting `Task[]` from `parseManifest()` — sessions are built on top of parsed tasks

**Fallback behavior:**
- If a task has no `Suggested Session` field: assign it to an auto-generated session containing only that task
- If a task references a session not in the hints table: derive `focus` from the task title(s)
- If the hints table is missing entirely: create one session per task (no grouping — equivalent to current behavior)
- If a task's session assignment conflicts with its layer (two tasks in the same session are in different layers): validation error, abort with descriptive message
- If the hints table references a session not claimed by any task: ignore the orphaned entry (warn in verbose mode)

### `resolver.ts`

- New exported function: `resolveSessionDependencies(sessions: Session[]): Map<string, string[]>`
  - Lifts task-level dependencies to session-level: if any task in session B depends on any task in session A, then session B depends on session A
  - Returns a map of session ID → dependency session IDs
- New exported function: `getReadySessions(sessions: Session[], deps: Map<string, string[]>): Session[]`
  - A session is ready when: status is `"queued"` AND all dependency sessions have status `"done"`
  - Sessions with unmet dependencies have status `"blocked"` (set during status reconciliation in the main loop)
- File conflict detection between sessions: union all `creates`/`modifies` from all tasks in a session, then compare union sets between sessions. Two sessions conflict if their union sets overlap.
- Existing task-level functions remain for internal use but the orchestrator calls session-level functions

### `brief.ts`

Extract common brief infrastructure (reading command files, appending memory, design doc inlining, quality standards) into a shared `buildBriefSkeleton()` helper. Both existing per-task functions and new session functions compose on top of it. This avoids DRY violations.

- New exported function: `buildSessionArchitectBrief(session: Session, manifest: string, memory: string): string`
  - Uses `buildBriefSkeleton()` for common sections
  - Includes all tasks in the session with their full requirements and explore targets
  - Instructs the agent to produce one plan covering all tasks
  - Includes scoped manifest excerpt (session's tasks + their dependency tasks)
- New exported function: `buildSessionImplementationBrief(session: Session, manifest: string, memory: string): string`
  - Uses `buildBriefSkeleton()` for common sections
  - Lists all tasks in order with their requirements
  - Instructs the agent to implement tasks sequentially, commit after each task
  - Uses per-task commit messages from the manifest
  - References session plan at `artifacts/s${sessionId}-session-plan.md`
- Existing per-task brief functions can be refactored to use `buildBriefSkeleton()` as well, but are not required to change in this feature

### `spawner.ts`

- `spawnAgent()` accepts a session instead of a task
  - State maps (`outputBuffers`, `stallStates`) keyed by session ID (string) instead of task ID (number)
  - Log files written to `s${sessionId}.jsonl`
  - `session.lastLine`, `session.stage`, `session.turnCount`, `session.bytesReceived` updated during stream parsing (same fields, now on Session)
- `getRecentOutput(sessionId)`, `getStallInfo(sessionId)`, `extendStallTimeout(sessionId)` accept string session ID
- Cleanup on process close removes entries from maps by session ID

### `merger.ts`

Function signature changes from task-based to session-based:

- `squashMerge(session: Session, slug: string, featureBranch: string, verbose: boolean): void`
  - Branch name read from `session.branchName` (set during worktree creation)
  - Commit message built from session tasks (see format below)
- `commitViaFile(message: string, cwd: string): void` — simplified, drops `taskId` (was only used for temp file naming — use session ID or random suffix instead)
- `resetAndThrow(error: Error, repoDir: string): never` — simplified, drops `taskId` and `label` (error context provided by caller)

One squash merge per session into the feature branch. Combined commit message format:
```
session S1: types, config, and brief improvements

- task 1: add triage types, config parsing, and needs_human status handling
- task 5: add tool constraints and scoped manifest excerpts to briefs
```
For single-task sessions, the commit message is just the task's commit message (no session wrapper)

### `cli.ts`

- Main loop iterates sessions, not tasks
- `parseSessions()` called after `parseManifest()` to build session list
- `resolveSessionDependencies()` replaces task-level dependency resolution for scheduling
- Concurrency limit applies to running sessions
- Session lifecycle: blocked → queued → running (spawn agent) → architect phase → plan review → implementation phase → code review → merging → done
- The `session.status` field tracks the coarse state (`"running"`, `"merging"`, etc.). The `session.stage` field (a free-form string) tracks the fine-grained phase within `"running"` — e.g., `"Exploring"`, `"Planning"`, `"Implementing T1"`, `"Implementing T5"`. The dashboard uses `stage` for display; the main loop uses `status` for scheduling decisions.
- Status reconciliation each loop iteration: sessions with unmet deps are set to `"blocked"`, sessions with all deps met are set to `"queued"`
- For sessions where all tasks have complexity ≤ 2: skip architect phase (direct implementation)
- For sessions with any task complexity > 2: architect phase produces a plan covering all tasks
- `--tasks` filter: if specified, filter sessions to only include those containing at least one of the specified task IDs. Tasks not in the filter are removed from their sessions. Sessions that become empty after filtering are dropped.

### `progress.ts`

- Track session status alongside task status in `progress.md`
- New session status table added above the existing task table:
  ```
  ## Sessions
  | Session | Status | Tasks |
  |---------|--------|-------|
  | S1 | done | T1, T5 |
  | S2 | running | T2, T3 |
  ```
- `writeProgress()` and `readProgress()` updated to read/write session status
  - `readProgress()` returns both `Map<string, SessionStatus>` (sessions) and existing `Map<number, string>` (tasks)
- Resume detection works at session level: if a session was `"running"` when interrupted, re-queue it
- Task-level status still tracked — the orchestrator scans the session's worktree git log to determine which tasks within a session have been committed (by matching commit messages to per-task commit message patterns from the manifest)
- `"merging"` sessions are re-queued on resume (same as current task behavior)

### `dashboard.ts`

- Render sessions as the primary grouping in TUI mode
- Each session shows its status with constituent tasks nested underneath
- Task-level progress visible within each session (e.g., "S1: running [T1 done, T5 in progress]")
- `"merging"` sessions shown as running with a `[MERGING]` label
- `"needs_human"` sessions shown with `[NEEDS HUMAN]` label in yellow
- **Pipe mode** (`--no-tui`): sessions rendered as flat lines with task count, same format as current task lines but prefixed with session ID

### `memory.ts`

- `appendMemoryEntry()` takes a session ID instead of task ID
- Memory entry header format changes from `## T${taskId} - ${title}` to `## S${sessionId} - ${focus}`
- The memory snapshot reader in `brief.ts` must update its regex pattern from `## T\d+` to `## [TS]\w+` to match both legacy task entries and new session entries
- One memory entry per session — the agent produces a single memory summary covering all tasks in the session

## Agent Experience

### Architect Phase

The architect agent receives a brief containing all session tasks. It produces one plan covering all tasks. The plan is reviewed by a plan-review subagent (orchestrator-managed, not visible to the architect agent).

Brief content:
- Session metadata (ID, focus, complexity)
- All task requirements with explore targets
- Scoped manifest excerpt
- Memory context
- Instruction: "Plan the implementation for all tasks in this session. Produce one unified plan."

Plan saved to `artifacts/s${sessionId}-session-plan.md`.

### Implementation Phase

The implementation agent receives a brief with the approved plan and all task requirements. It implements tasks sequentially, committing after each.

Brief content:
- Approved plan from architect phase (referenced at `artifacts/s${sessionId}-session-plan.md`)
- All task requirements in order
- Memory context
- Instruction: "Implement each task in order. Follow TDD discipline per task. Commit after each task using the specified commit message."

### Review Gates

Review gates are orchestrator-managed, spawned as separate subagents between phases:
- **Plan review:** After architect phase, before implementation. Reviews the plan for all tasks in the session.
- **Code review:** After implementation phase, before merge. Reviews all code changes across all tasks in the session.

The implementation agent does not see or manage the review process.

## Per-Task Completion Detection

When a session's agent exits (success or failure), the orchestrator needs to know which tasks within the session were completed. This is determined by scanning the session worktree's git log:

1. After agent exit, run `git log --oneline ${featureBranch}..${sessionBranch}` in the worktree
2. Match commit messages against the per-task commit message patterns from the manifest (e.g., `task 1: add triage types...`)
3. Tasks with matching commits are marked `"done"` on the task object
4. Tasks without matching commits remain in their current status

This enables `resume_from_branch` to skip completed tasks — the implementation brief for a resumed session lists which tasks are already committed and instructs the agent to skip them.

## Triage Integration

Triage operates at the session level. The `DecisionContext` is extended with session information:

```typescript
interface DecisionContext {
  trigger: { ... };
  task: { ... };           // kept for backward compat — populated with the failing task's info
  session: {               // NEW — session-level context
    id: string;
    totalTasks: number;
    completedTasks: number; // determined by git log scan
    remainingTasks: string[]; // task titles not yet committed
    complexity: number;
  };
  state: { ... };
  history: DecisionRecord[];
  actions: { ... };
}
```

Session-scoped triage actions:

- `resume_from_branch`: resumes the session from where it left off — the agent's brief indicates which tasks are already committed and should be skipped
- `retry_from_scratch`: wipes the session worktree and re-queues all tasks in the session
- `skip_and_continue`: marks the entire session as done (including incomplete tasks)
- `escalate`: marks the session as `needs_human`, writes escalation file to `artifacts/s${sessionId}-escalation.md`
- `retry_merge_only`, `reuse_plan`, `extend_timeout`, `mark_done`: work the same way, scoped to the session

## Constraints

### Session Grouping Rules (enforced by task-manifest skill)

1. Sessions can only contain tasks from the same dependency layer
2. Total complexity per session should not exceed ~10-12
3. QA tasks are always their own session
4. Tasks within a session should be thematically related (touching related modules or serving a common purpose)
5. Sessions are numbered sequentially (S1, S2, S3...)

### Backward Compatibility

- Single-task sessions behave identically to the current per-task model
- The manifest format is backward compatible — `Suggested Session` already exists in generated manifests
- A manifest without session hints defaults to one session per task (no grouping)
- `--tasks` filter works by filtering sessions to those containing specified task IDs

## What Doesn't Change

- **Manifest task format** — tasks retain all existing fields
- **QA gates** — remain their own sessions, still block downstream
- **Dependency graph** — still task-level in the manifest; resolver lifts to session deps
- **Review gate quality** — same depth, fewer total gates
- **Worktree lifecycle** — same create/cleanup pattern, keyed by session
- **TDD discipline** — per-task within sessions
- **Security model** — no new attack surface; session IDs are internal identifiers derived from the manifest
