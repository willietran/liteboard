# Autoboard — Refined Design

## Overview

Autoboard is a globally-installed open-source CLI tool (`npm i -g autoboard`)
that manages the full lifecycle of AI-driven software development — from
brainstorming a design doc to automatically building every task in parallel.
It runs entirely in the terminal using an Ink-based TUI, uses the user's
existing Claude Code subscription via headless `claude -p` calls, and owns
its entire workflow pipeline through versioned markdown command files the
user controls.

There are two phases: **Design** (conversational, human-heavy) and **Build**
(automated, fire-and-forget). The transition between them is explicit and
**reversible** — the user can pause mid-build, revise the design, and
regenerate remaining tasks.

**License:** MIT

---

## Core Principles

1. **Human owns the design.** The design doc is the source of truth. Time
   spent refining it is time saved in the build phase.
2. **Agents own the build.** Once design is locked and tasks are generated,
   the human watches — they don't drive.
3. **Shared memory bridges sessions.** No agent starts blind. Every task
   session is injected with a live snapshot of what's been built so far.
4. **Explore before planning.** Every agent understands existing patterns
   in the codebase before writing a single line.
5. **Workflow commands are yours.** Every review gate, planning step, and
   finish routine is a markdown file you own, version, and can modify.
6. **The subscription is enough.** No separate API key required. All agent
   calls go through `claude -p`, using the user's Claude Code subscription.
7. **Never touch main.** Autoboard never commits to or pushes to `main`.
   All work happens on the feature branch. The user merges via PR.
8. **No blind agreement.** Every review loop is a real debate. Agents
   critically evaluate feedback using `receiving-code-review` — no
   performative agreement.
9. **Open by default.** MIT-licensed. Command design attributed to
   Obra:Superpowers in the README.

---

## Entry Points

```bash
# Start a new project from scratch
autoboard new

# Start with an existing design doc
autoboard new --spec path/to/design.md

# Resume an in-progress run
autoboard resume path/to/repo

# List all Autoboard projects in a repo
autoboard list
```

---

## Repository Structure

### Autoboard Package

```
autoboard/
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── CHANGELOG.md
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── workflows/
│       ├── ci.yml                  ← vitest on PR
│       └── release.yml             ← npm publish on tag
├── src/
│   ├── cli.ts                      ← entry point, command routing
│   ├── tui/
│   │   ├── App.tsx                 ← root, phase switching
│   │   ├── DesignMode.tsx          ← conversation with markdown rendering
│   │   ├── BuildMode.tsx           ← kanban interface
│   │   ├── KanbanBoard.tsx
│   │   ├── SessionCard.tsx
│   │   ├── RunHeader.tsx
│   │   ├── LogPane.tsx             ← expandable log viewer
│   │   ├── MemoryPane.tsx          ← live memory.md reader
│   │   ├── ManifestReview.tsx      ← summary view + inline task editor
│   │   └── ModelConfigPanel.tsx
│   ├── orchestrator/
│   │   ├── index.ts                ← worker pool, event emitter
│   │   ├── parser.ts               ← manifest.md → Task[]
│   │   ├── worker.ts               ← claude -p spawning, stream parsing
│   │   ├── memory.ts               ← memory.md append, snapshot building
│   │   ├── brief.ts                ← task brief assembly at spawn time
│   │   └── worktree.ts             ← git worktree + branch management
│   ├── pipeline/
│   │   ├── brainstorm.ts           ← Design phase conversation loop
│   │   ├── generate-tasks.ts       ← /generate-tasks orchestration
│   │   ├── manifest.ts             ← manifest generation + architect review
│   │   └── briefs.ts               ← per-task brief generation
│   ├── commands/                   ← default workflow commands (markdown)
│   │   ├── brainstorm.md           ← modeled after superpowers:brainstorming
│   │   ├── write-plan.md           ← adapted from superpowers:writing-plans
│   │   ├── execute-plan.md         ← adapted from superpowers:executing-plans
│   │   ├── parallel-tasks.md
│   │   ├── code-reviewer.md        ← core critic prompt with quality standards
│   │   ├── process-review.md       ← invokes receiving-code-review skill
│   │   ├── finish-branch.md        ← verify, merge, write memory entry
│   │   ├── using-autoboard.md      ← agent orientation, auto-prepended
│   │   ├── task-manifest.md
│   │   ├── architect-review.md
│   │   ├── plan-review.md          ← dispatcher for code-reviewer.md
│   │   └── session-review.md       ← dispatcher for code-reviewer.md
│   └── config.ts                   ← global config, defaults
├── tests/
│   ├── orchestrator/
│   │   ├── parser.test.ts
│   │   ├── worker.test.ts
│   │   ├── memory.test.ts
│   │   └── worktree.test.ts
│   └── pipeline/
│       ├── manifest.test.ts
│       └── briefs.test.ts
└── package.json                    ← bin: { "autoboard": "src/cli.ts" }
```

### Project Folder (created in the user's repo)

```
docs/autoboard/
└── [topic-slug]/
    ├── design.md                   ← living design doc
    ├── manifest.md                 ← finalized task manifest
    ├── memory.md                   ← shared memory, append-only
    ├── architect-review.md         ← audit trail
    ├── session-config.json         ← model config, run state, task statuses
    ├── tasks/
    │   ├── t01.md                  ← per-task brief
    │   ├── t02.md
    │   └── ...
    └── logs/                       ← gitignored
        ├── .gitignore
        ├── t01.jsonl
        ├── t02.jsonl
        └── ...
```

### Workflow Command Overrides

Project-level overrides in `.autoboard/commands/` take precedence over
package defaults. No CLI management commands for MVP — users create/edit
files in that directory manually.

---

## Data Models

```ts
type TaskStatus =
  | "blocked"        // has unmet dependencies
  | "queued"         // dependencies met, file-conflict-free, awaiting worker
  | "running"        // claude process is live
  | "review_gate"    // agent in plan-review or session-review loop
  | "done"           // exited 0, squash merge complete
  | "interrupted"    // process was killed (Ctrl+C, crash) — auto-retried
  | "failed";        // non-zero exit or merge conflict — needs human

interface Task {
  id: string;               // e.g. "t11"
  title: string;
  complexity: number;       // 1–10
  tdd: boolean;
  requires: string[];       // task IDs this depends on
  creates: string[];        // files this task creates
  modifies: string[];       // files this task modifies
  commitMessage: string;
  explore: string[];        // merged hints from all sources
  status: TaskStatus;
  turnCount: number;
  lastLine: string;         // last agent output line, max 120 chars
  heldByConflict?: string;  // task ID causing file-level hold
  startedAt?: Date;
  completedAt?: Date;
  exitCode?: number;
  logPath?: string;
}

interface ModelConfig {
  brainstorm: string;           // default: "claude-opus-4-5"
  manifestGeneration: string;   // default: "claude-opus-4-5"
  architectReview: string;      // default: "claude-opus-4-5"
  implementation: string;       // default: "claude-opus-4-5"
  reviewGates: string;          // default: "claude-sonnet-4-5"
}

interface Project {
  id: string;
  topicSlug: string;
  repoPath: string;
  featureBranch: string;        // autoboard/[slug]
  phase: Phase;                 // "design" | "build" | "complete"
  models: ModelConfig;
  maxParallel: number;          // default: 1, max: 5
  tasks: Task[];
  createdAt: Date;
  lockedAt?: Date;
  completedAt?: Date;
}
```

No `phase` field on tasks — sequencing is purely dependency-driven via
`requires`. No artificial phase gates.

---

## Phase 1: Design

### Entry

On `autoboard new`:
1. Creates `docs/autoboard/[slug]/` directory structure
2. Opens Design mode TUI
3. Spawns first `claude -p` with `brainstorm.md` command (full agent session
   with file tool access)
4. Renders conversation interface with markdown rendering

If `--spec` is provided, design doc content is pre-loaded as context.
Claude opens by asking clarifying questions rather than starting fresh.

### Brainstorm Agent

Modeled after `superpowers:brainstorming`. The agent:
- Asks questions one at a time to understand purpose, constraints, success criteria
- Prefers multiple choice questions when possible
- Proposes 2-3 approaches with trade-offs and a recommendation
- Writes/updates `design.md` when alignment is reached
- Conversation continues — agent edits the doc on further agreement

### Conversation Loop

Each user reply resumes the same `claude -p` session via `--resume sessionId`.
If a session dies or hits context limits, a new session starts with `design.md`
as context. The doc is the source of truth, not the conversation.

### Design Mode TUI

```
┌─────────────────────────────────────────────────────────────────────┐
│ AUTOBOARD  design  leona                            [?] help        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ Claude: Here's my thinking on the credential vault — AES-256-GCM    │
│ with a raw 256-bit key is the right call. No PBKDF2, no hardcoded   │
│ salt. Key comes from ENCRYPTION_KEY env var (hex-encoded, 64 chars).│
│                                                                      │
│ You: Good. Make sure it throws a descriptive error if the key is    │
│ missing or wrong length.                                            │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│ > _                                          [/generate-tasks] [tab]│
└─────────────────────────────────────────────────────────────────────┘
```

Full markdown rendering in the conversation panel (bold, code blocks, lists).

**Keyboard shortcuts:**
- `Tab` — autocomplete `/generate-tasks`
- `Ctrl+E` — open `design.md` in `$EDITOR`
- `Ctrl+C` — graceful exit (state saved; resume with `autoboard resume`)

### `/generate-tasks` — Phase Transition

When the user types `/generate-tasks`:

1. **Lock `design.md`** — SHA hash stored in `session-config.json`
2. Show spinner: `"Generating task manifest..."`
3. Run manifest pipeline silently
4. **Summary view** — task count, dependency graph overview, high-complexity
   callouts
5. **Drill-down** — user navigates individual tasks on demand
6. **Inline editing** — select a task, edit fields directly in TUI (title,
   complexity, dependencies, files, commit message). Split auto-merged
   tasks if desired.
7. User confirms → transition to Build mode

### Reversible Transition

The user can pause mid-build, revert to Design mode, edit `design.md`, and
re-run `/generate-tasks`. The new manifest pipeline receives context about
completed tasks and `memory.md`, generating only remaining work. New task
IDs start after the last completed task.

---

## Internal Manifest Pipeline

Runs silently between `/generate-tasks` and the user seeing results.

### Step 1: Manifest Generation

```
Model:  config.models.manifestGeneration
Input:  design.md + task-manifest.md command
Output: manifest-draft.md (internal, never shown to user)
```

Each task in the draft manifest includes:
- `id`, `title`, `complexity`, `tdd`
- `requires`, `creates`, `modifies`, `commitMessage`
- `explore` — hand-authored hints for explore agents

No `phase` field — tasks are a flat list with dependency edges.

### Step 2: Architect Review Loop

```
Critic:   config.models.architectReview + architect-review.md command
Author:   config.models.manifestGeneration
Max:      3 rounds — critic identifies issues → author revises
          Author uses receiving-code-review to critically evaluate feedback
Round 4:  Surface to human with diff + unresolved objections
Output:   manifest.md (final) + architect-review.md (audit trail)
```

**Critic evaluation criteria:**
- **Completeness** — every design doc requirement has a corresponding task
- **No DRY violations** — shared utilities extracted, no duplicated logic
- **Security** — very high standards; security-sensitive work has TDD,
  parameterized queries, input validation, no secrets in code
- **Claude Code navigability** — clear file/folder structure, descriptive
  naming, small focused modules, lightweight comments for non-obvious context
- **Debuggability** — code structured for easy debugging, clear error
  messages, traceable data flow
- **Performance** — efficient algorithms, no unnecessary work
- **TDD enforced** — all orchestrator and pipeline modules require tests
- **Dependency correctness** — all file-level and data-flow dependencies
  captured in `requires`
- **Commit hygiene** — each task produces one focused commit
- **Explore coverage** — tasks touching existing patterns have explore hints

### Step 3: Task Brief Generation

```
Model:  config.models.reviewGates (distillation only)
Input:  manifest.md + design.md (per-task excerpt extraction)
Output: tasks/t01.md ... tasks/tNN.md

Note: Memory snapshot and git log are placeholders — injected fresh
      at spawn time, not generation time.
```

### Step 4: Task Graph Resolution

- Parse all `requires`, `creates`, `modifies` from manifest
- Set initial statuses: `blocked` | `queued`
- **Auto-merge:** adjacent tasks with complexity ≤ 3 and direct sequential
  dependency merged into a single card, provided combined complexity ≤ 6.
  User can split during manifest review via inline editor.
- Write resolved graph to `session-config.json`

---

## Explore Hints

Explore hints tell the agent which areas of the codebase to investigate
before writing a plan. Three sources, merged at brief generation time:

### 1. Auto-inferred from manifest metadata

`briefs.ts` applies pattern rules to `creates`, `modifies`, and `requires`
fields:

| Pattern | Auto-generated hint |
|---|---|
| `creates` in `src/app/dashboard/` | Explore existing dashboard pages for layout, auth patterns |
| `creates` in `src/app/api/` | Explore existing API routes for validation, error handling |
| `creates` in `src/inngest/functions/` | Explore Inngest functions for retry, event naming |
| `creates` in `src/lib/` | Explore lib modules for export conventions |
| `creates` in `tests/` | Explore test files for mock patterns |
| `modifies` any file | Explore the file being modified first |
| `requires` task T | Explore files created/modified by T |

### 2. Memory-derived

The memory snapshot captures gotchas and conventions from completed tasks.
Surfaces automatically in the brief's memory section.

### 3. Hand-authored in the manifest (`explore` field)

The architect review loop populates hints that inference cannot provide —
design doc section references, component patterns, external API guides.

Duplicates across sources are deduplicated at brief generation time.

---

## Phase 2: Build

### Worker Spawning

```ts
function spawnTask(task: Task, project: Project): ChildProcess {
  const brief = buildBrief(task, project);
  // buildBrief assembles:
  //   using-autoboard.md (prepended)
  //   + static tasks/tNN.md
  //   + fresh memory.md snapshot
  //   + git log --oneline -10 autoboard/[slug]

  return spawn("claude", [
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--model", project.models.implementation,
    "-p", brief,
  ], {
    cwd: worktreePath,
    env: { ...process.env },
  });
}
```

No `--max-turns` — agents run until done. `--dangerously-skip-permissions`
for MVP, configurable in future versions.

### Task Lifecycle

1. Agent spawns in worktree with brief (using-autoboard.md prepended)
2. Agent enters plan mode — explores codebase, writes implementation plan
3. **Plan review loop** — spawns plan-review subagent, back-and-forth
   max 3 rounds. Agent uses `receiving-code-review`. On agreement,
   exits plan mode.
4. Agent implements per `execute-plan.md`
5. **Session review loop** — spawns session-review subagent, same protocol
   (max 3 rounds, `receiving-code-review`)
6. Agent runs `finish-branch.md` — verifies build/tests, squash merges
   to feature branch, writes memory entry to `memory.md`
7. Orchestrator detects completion, serializes memory write via lock,
   unlocks dependents, spawns next

### Review Protocol (all three review points)

Every review gate follows the same protocol:
- Reviewer and author go back and forth
- Author uses `receiving-code-review` — critically evaluates feedback,
  pushes back on incorrect or unnecessary suggestions
- Max 3 rounds → escalate to human
- Applies to: **manifest review**, **plan review**, **session review**

### Review Gate Quality Standards (code-reviewer.md)

- **No DRY violations** — no duplicated implementations
- **Claude Code navigability** — clear structure, descriptive naming,
  small focused modules, lightweight comments for non-obvious context
- **Debuggability** — clear error messages, traceable data flow
- **High performance** — efficient algorithms, appropriate caching
- **Very high security** — parameterized queries, input validation,
  no secrets in code, principle of least privilege
- **TDD enforced** — tests before implementation where applicable

### Dependency + Conflict Resolution

```ts
function getSpawnableNext(tasks: Task[], maxParallel: number): Task[] {
  const running = tasks.filter(t => t.status === "running");

  const unblocked = tasks
    .filter(t => t.status === "blocked")
    .filter(t => t.requires.every(
      dep => tasks.find(d => d.id === dep)?.status === "done"
    ))
    .map(t => ({ ...t, status: "queued" as TaskStatus }));

  const allQueued = [
    ...tasks.filter(t => t.status === "queued"),
    ...unblocked,
  ];

  return allQueued
    .filter(candidate => !running.some(r => hasFileConflict(candidate, r)))
    .slice(0, maxParallel - running.length);
}

function hasFileConflict(a: Task, b: Task): boolean {
  const filesA = [...a.creates, ...a.modifies];
  const filesB = [...b.creates, ...b.modifies];
  return filesA.some(f => filesB.includes(f));
}
```

**Package.json conflict auto-resolution:** If squash merge conflicts on
`package.json` or lockfile, auto-resolve by combining both additions and
running `npm install` on the merged branch.

### Kanban Mode TUI

```
┌─────────────────────────────────────────────────────────────────────┐
│ AUTOBOARD  autoboard/leona  12/40  ▓▓▓▓▓░░░░░  [P]ause  [S]tart   │
├──────────┬───────────┬───────────┬──────────┬───────────────────────┤
│ QUEUED   │  RUNNING  │  REVIEW   │  FAILED  │  DONE                 │
│  (3)     │           │   GATE    │          │                       │
│          │  [T09] ●  │           │          │  [T01] ✓              │
│          │  [T11] ●  │           │          │  [T02] ✓              │
│          │           │           │          │  [T03] ✓              │
│          │           │           │          │  ...12 more           │
│                                             BLOCKED (28)            │
├─────────────────────────────────────────────────────────────────────┤
│ T11 · AST-Based SQL Validator · ●●●●●○○○○○ · Turn 47 · 4m 32s      │
│ "Writing test for multi-statement injection bypass..."              │
│                          [L] view log  [↑↓] navigate  [R] retry    │
└─────────────────────────────────────────────────────────────────────┘
```

- Active columns up front: RUNNING, REVIEW GATE, FAILED
- Collapsed counts for QUEUED and BLOCKED
- Scrollable DONE list
- Lock icon on tasks held by file conflict

**Keyboard shortcuts:**
- `↑↓` — navigate cards
- `L` — open full `.jsonl` log for selected card
- `R` — retry a failed task
- `S` — skip a task (mark done manually)
- `P` — pause (no new workers; running ones finish)
- `M` — open `memory.md` in read-only live pane
- `C` — open model config panel

---

## Branching Strategy

### Hard Rule: Never Touch Main

Autoboard **never** commits to or pushes to `main`. The feature branch
is the only branch autoboard writes to. The user merges to `main` via PR.

### Branch Naming

```
main
└── autoboard/[slug]              ← feature branch, created at Build start
    ├── autoboard/[slug]/t08      ← per-task branch, in worktree
    ├── autoboard/[slug]/t09
    └── autoboard/[slug]/t11
```

### Task Branch Lifecycle

```bash
# At Build start — only time main is read
git checkout -b autoboard/leona main

# At task spawn — worktree + task branch
git worktree add /tmp/autoboard-[runId]-t11 autoboard/leona

# On task completion — agent runs finish-branch.md:
git rebase autoboard/leona
git checkout autoboard/leona
git merge --squash autoboard/leona/t11
git commit -m "[task commitMessage]"
git push

# Cleanup
git worktree remove --force /tmp/autoboard-[runId]-t11
git branch -D autoboard/leona/t11
```

### Merge Conflict Handling

If `git rebase` produces conflicts:

```
FAILED  T09 — Merge conflict during rebase

Conflicting file: src/lib/connection-validator.ts

[O] Open conflict in $EDITOR and resolve manually
[R] Retry T09 from scratch on updated feature branch
[S] Skip T09 (mark done manually)
```

**Package.json/lockfile conflicts** are auto-resolved: combine additions
from both tasks and run `npm install`.

---

## Shared Memory

### `memory.md` Structure

Append-only. The agent writes its own memory entry as part of
`finish-branch.md`. The orchestrator serializes access via a lock to
prevent concurrent writes.

```markdown
# Autoboard Memory — Leona

## T08 · Credential Vault · 2026-03-09T14:52:00Z
**Created:** `src/lib/credential-vault.ts`, `tests/lib/credential-vault.test.ts`
**Exports:** `encrypt(plaintext)`, `decrypt(encrypted, iv, authTag)`
**Env var added:** `ENCRYPTION_KEY` (64-char hex)
**Gotcha:** Uses raw 256-bit key. No PBKDF2. Throws on module load if key
  is missing or wrong length.
```

---

## Graceful Shutdown & Recovery

### Ctrl+C — Graceful Shutdown

1. Orchestrator stops spawning new tasks
2. Running tasks get a few seconds to wrap up
3. Running tasks marked `"interrupted"` (distinct from `"failed"`)
4. State written to `session-config.json`
5. Clean exit

### On `autoboard resume`

1. Load `session-config.json`
2. `"interrupted"` tasks → auto-retry (new session with design.md + memory.md)
3. `"running"` tasks with no live process (unexpected crash) → mark
   `"interrupted"` → auto-retry
4. `"failed"` tasks stay failed — `R` to retry, `S` to skip
5. Re-run dependency + conflict resolution
6. Spawn next available tasks

### Mid-Build Design Revision

1. User hits `P` to pause → running tasks finish (or Ctrl+C to interrupt)
2. Phase reverts to `"design"`, `design.md` unlocked
3. User brainstorms changes with Claude
4. User types `/generate-tasks` again
5. Manifest pipeline runs with context: completed tasks, memory.md,
   generate only remaining work
6. New task IDs start after last completed task
7. Back to Build mode

---

## Build Completion

When all tasks are done:
1. Show summary banner: tasks completed, time elapsed, failures/retries
2. Auto-prompt: "Create a PR for `autoboard/[slug]` → `main`? [Y/n]"
3. On yes: generate PR via `gh pr create` with summary as description
4. On no: inform user their feature branch is ready

---

## Model Configuration

Each pipeline stage has an independently configurable model:

```ts
const defaults: ModelConfig = {
  brainstorm:           "claude-opus-4-5",
  manifestGeneration:   "claude-opus-4-5",
  architectReview:      "claude-opus-4-5",
  implementation:       "claude-opus-4-5",
  reviewGates:          "claude-sonnet-4-5",
};
```

Override via:
- `C` key in Build mode TUI
- `session-config.json` directly
- CLI flag: `autoboard new --implementation claude-sonnet-4-5`

Model changes mid-run affect future spawns only.

---

## Tech Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript strict |
| TUI framework | Ink 5 + @inkjs/ui |
| Markdown rendering | Terminal markdown renderer |
| Client state | Zustand |
| Process spawning | `node:child_process` + `execa` |
| Markdown parsing | `unified` + `remark-parse` |
| Git operations | `execa` wrapping git CLI |
| Testing | Vitest |

---

## TDD Requirements

All `src/orchestrator/` and `src/pipeline/` modules require tests before
implementation (RED → GREEN → REFACTOR). TUI components are TDD-exempt —
verify with `npm run build`.

### `parser.test.ts`
- Parses all task fields from a sample manifest (no `phase` field)
- No-dependency tasks → `"queued"`, dependency tasks → `"blocked"`
- Auto-merge: complexity ≤ 3 + direct sequential dependency, combined ≤ 6
- Malformed manifest handled gracefully

### `worker.test.ts`
- Review gate detection → `status = "review_gate"`, next message → `"running"`
- Turn count increments on assistant messages
- `lastLine` strips markdown, truncates to 120 chars
- Exit 0 → triggers merge + memory + dependency unlock
- Exit non-zero → marks failed, does NOT unlock dependents
- Rebase runs before squash merge (verify call order)

### `memory.test.ts`
- Concurrent appends are serialized (lock, no corruption)
- Snapshot includes all tasks completed at snapshot time
- Entry format validates: timestamp, task id, created files, gotchas
- Memory injected at spawn time, not generation time

### `worktree.test.ts`
- Setup creates worktree + task branch at correct path
- Rebase before squash merge (verify order)
- Squash merge uses exact task `commitMessage`
- Cleanup on both success and failure
- Package.json/lockfile conflict auto-resolution

### `manifest.test.ts`
- Architect review loop terminates at max 3 rounds
- Author uses receiving-code-review to evaluate feedback
- Round 4 surfaces diff + unresolved objections to human
- `architect-review.md` written with audit trail
- `manifest.md` marked immutable after pipeline
- All tasks have non-empty `explore` field if touching existing patterns

### `briefs.test.ts`
- `using-autoboard.md` always prepended
- Memory snapshot injected at spawn time
- Git log injected at spawn time
- Relevant design doc section extracted (not full doc)
- Explore hint inference rules applied correctly
- Hand-authored `explore` entries preserved verbatim
- Duplicate hints deduplicated

---

## Workflow Commands (adapted from Obra:Superpowers)

| File | Type | Invoked By | Purpose |
|---|---|---|---|
| `brainstorm.md` | Skill | Design phase entry | Modeled after superpowers:brainstorming |
| `task-manifest.md` | Skill | /generate-tasks pipeline | Generate task manifest from design doc |
| `architect-review.md` | Skill | /generate-tasks pipeline | Critic review with quality standards |
| `write-plan.md` | Skill | Agent in plan mode | Adapted from superpowers:writing-plans |
| `execute-plan.md` | Skill | Agent after plan approval | Adapted from superpowers:executing-plans |
| `parallel-tasks.md` | Skill | Agent (optional) | Sub-agent parallelism within a task |
| `code-reviewer.md` | Skill | Dispatchers | Core critic prompt with quality standards |
| `process-review.md` | Skill | Agent after review | Invokes receiving-code-review skill |
| `finish-branch.md` | Skill | Agent (final step) | Verify, merge, write memory entry |
| `using-autoboard.md` | Skill | Auto-prepended to briefs | Agent orientation and toolkit guide |
| `plan-review.md` | Dispatcher | Agent (pre-exit-plan) | Dispatches code-reviewer.md for plan |
| `session-review.md` | Dispatcher | Agent (pre-finish) | Dispatches code-reviewer.md for session |

---

## Out of Scope (Post-MVP)

- Authentication or cloud sync
- Web UI alternative to TUI
- Support for non-Claude models
- Notification integrations (Slack, email on failure)
- Multiple concurrent projects in same session
- CLI commands for workflow command management (`autoboard commands list/edit/reset`)
- Configurable permission modes (replace `--dangerously-skip-permissions`)
- Signed release binaries / standalone executables
