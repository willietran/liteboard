# Liteboard

AI-driven development orchestrator — from brainstorm to built feature branch. Spawns parallel Claude Code agents in git worktrees, manages dependencies, merges results, and renders a live terminal dashboard.

## Project Structure

```
liteboard/
├── src/                    # Orchestrator source (TypeScript)
│   ├── cli.ts              # Entry point, argument parsing, main loop
│   ├── types.ts            # Shared interfaces (Task, Provider, StreamEvent, etc.)
│   ├── parser.ts           # Manifest markdown → Task[]
│   ├── resolver.ts         # Topological sort, dependency resolution, file conflict detection
│   ├── worktree.ts         # Git worktree create/cleanup, branch management
│   ├── spawner.ts          # Agent process spawning, stream parsing, stall detection
│   ├── merger.ts           # Trial merge, conflict resolution, build validation
│   ├── memory.ts           # memory.md append (mutex-serialized), snapshot building
│   ├── dashboard.ts        # Terminal UI rendering (ANSI, no framework)
│   ├── provider.ts         # Provider abstraction + Claude Code provider
│   ├── brief.ts            # Assembles agent prompt from commands/ + memory + task metadata
│   ├── progress.ts         # progress.md read/write, resume detection
│   └── setup.ts            # `liteboard setup` — installs skills to ~/.claude/commands/
│
├── commands/               # Brief components (injected into agent prompts, NOT user-invocable)
│   ├── agent-orientation.md
│   ├── code-reviewer.md
│   ├── plan-review.md
│   ├── qa-agent.md
│   ├── session-review.md
│   └── receiving-code-review.md
│
├── skills/                 # Claude Code skills (user-invocable slash commands)
│   ├── brainstorm.md       # /liteboard:brainstorm
│   ├── task-manifest.md    # /liteboard:task-manifest
│   └── run.md              # /liteboard:run
│
├── tests/                  # Vitest test files (mirrors src/)
├── docs/                   # Design docs, manifests, reference scripts
└── dist/                   # Compiled JS (gitignored)
```

## Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 22+ |
| Language | TypeScript (strict mode, ES2022, NodeNext) |
| Testing | Vitest |
| Process spawning | `node:child_process` (spawn, execFileSync) |
| Git operations | Direct git CLI via execFileSync |
| Package manager | npm |
| Build | tsc |

## Key Commands

```bash
npm run build        # Compile TypeScript to dist/
npm test             # Run vitest (all tests)
npm run dev          # Run CLI via tsx (dev mode)
npx vitest run       # Run tests once (no watch)
npx tsc --noEmit     # Type-check without emitting
```

## Testing Standards

Tests are the safety net that lets agents work fast without breaking things. Minimal "happy path only" testing is unacceptable — it creates a false sense of security and lets regressions slip through.

### Coverage expectations

- All `src/` modules except `dashboard.ts` and `cli.ts` have Vitest tests
- Test files mirror source: `src/parser.ts` → `tests/parser.test.ts`
- **Every public function must have tests for:** the happy path, edge cases, error conditions, and boundary values
- **Every bug fix must include a regression test** that would have caught the bug. Fix the bug AND prove it stays fixed.
- **Every new code path must be tested.** If you add an `if` branch, both sides need coverage. If you add a new task type, test that it flows through parsing, brief building, and any type-specific logic.

### What "thorough" means

| Lazy testing (don't do this) | Thorough testing (do this) |
|------------------------------|---------------------------|
| One test for the happy path | Happy path + empty input + malformed input + boundary values |
| Test that a function "doesn't throw" | Test the specific return value, side effects, and state changes |
| Skip error paths ("they're obvious") | Test every `catch` block and every error message |
| Mock everything and test nothing | Mock external dependencies, test actual logic |
| "It works in the happy case, ship it" | "What happens with 0 tasks? 1 task? 50 tasks? Circular deps? Missing fields?" |

### When modifying existing code

- **Run the full test suite before AND after changes.** Not just the file you changed — the full suite. Regressions often surface in other modules.
- **If you change a function's behavior, update its tests first** (TDD). If existing tests still pass after a behavioral change, the tests are too weak — strengthen them.
- **Never delete or weaken a test to make your code pass.** If a test fails, either your code is wrong or the test caught a legitimate behavioral change that needs explicit acknowledgment.

### Conventions

- Tests mock `node:fs` and `node:child_process` — no real git repos in tests
- Use `vi.mock()` at module level, `vi.mocked()` for type-safe access
- Use `vi.useFakeTimers()` for time-dependent tests (stall detection)
- Import source modules with `.js` extension (NodeNext resolution)

## Design Doc

Full design specification: `docs/superpowers/specs/2026-03-10-liteboard-design.md`

---

## Git Conventions

- **Never commit to or push to `main`.** All work happens on feature branches.
- Feature branch: `autoboard/mini-mvp` (default)
- Per-task branches: `autoboard/mini-mvp/tN` (created by worktree manager, ephemeral)
- Squash merges only — one commit per task on the feature branch.

---

## Architectural Philosophy

Liteboard is a **thin orchestration layer** — it manages tasks, dependencies, worktrees, and merges. It does NOT implement domain logic programmatically.

**Push complexity to the agents, not the orchestrator.** If something can be decided by an agent reading the filesystem at runtime, it should not be hardcoded in TypeScript. Examples:

| Wrong (orchestrator does it) | Right (agent does it) |
|------------------------------|----------------------|
| Detect project type (Next.js, Vite, Express) in TS code | Agent reads config files and adapts |
| Orchestrator runs build validation with programmatic phases | Agent runs `npm ci && tsc && npm test` and interprets results |
| Custom dashboard renderer per feature (gate dashboard, QA dashboard) | All tasks render through the same task dashboard |
| CLI flags to control agent behavior (`--skip-smoke`, `--no-fixer`) | Agent brief instructions control behavior |
| Parsing custom markers (`[GATE:PASS]`, `[GATE:FAIL]`) | Standard `[STAGE: ...]` markers for all task types |

**The litmus test:** If a new feature requires a new orchestrator module, new CLI flags, new dashboard renderer, or new marker protocol — stop. It probably belongs in a brief (`commands/*.md`) and a task type, not in TypeScript. The orchestrator should be **feature-agnostic**: it spawns agents, tracks progress, and merges results. The agents are smart enough to handle the rest.

### Agent Tool Restrictions

Only agents that **build and test code** (implementation agents, QA agents) may use the Bash tool. All other agents have structural tool restrictions via their agent definitions (`agents/` directory).

| Agent Role | Definition | Bash | Why |
|------------|-----------|------|-----|
| Implementation agent | Top-level (`claude -p`) | Yes | Runs tests, builds, installs deps |
| QA agent | Top-level (`claude -p`) | Yes | Runs the application, validates behavior |
| Architect agent | Top-level (`claude -p`) | No | Plans only (prompt-level restriction) |
| Explore subagent | `agents/code-explorer.md` | No | Reads code and docs only |
| Plan reviewer | `agents/plan-reviewer.md` | No | Reviews plan text only |
| Code reviewer | `agents/code-reviewer.md` | No | Reviews diffs and existing files only |

`node_modules` is gitignored and absent in worktrees. Runtime API verification (`node -e`, `python3 -c`) always fails — use documentation tools instead.

---

## Non-Negotiable Standards

Every change to this codebase must satisfy all of the following. If a change introduces a regression in any area, it must be fixed before merging. If you spot an existing violation, flag it immediately.

### 1. Claude Code Friendliness

The codebase must be easily navigable and debuggable by Claude Code. **Every line of unused code, every dead import, every leftover debug artifact is poison.** It misleads future agents, bloats context windows, and creates false leads during debugging. Clean up is not optional — it is part of the task.

- **Zero dead code.** If you tried something and it didn't work, delete it completely. No commented-out blocks, no unused functions, no orphaned imports, no `// TODO: remove` markers. If code isn't actively called, it doesn't exist. This applies especially during debugging — when you fix a bug, remove every failed attempt before committing.
- **Zero DRY violations.** If logic exists in one place, it must not be duplicated elsewhere. Extract shared logic into `src/lib/` or colocated helpers. If you find duplicated code during any task, refactor it immediately.
- **Single source of truth for every concept.** Types live in `src/types.ts`. Constants and shared config live in dedicated modules. Never define ad-hoc types inline when a shared type exists.
- **Consistent module structure.** Each module exports from a clear entry point. Related files are colocated. Barrel exports keep imports clean.
- **Predictable naming.** Files, functions, and variables must be named so their purpose is obvious without reading the implementation. Helper functions describe their action (`parseManifest`, `createWorktree`, `squashMerge`).
- **Small, focused files.** No file should try to do too many things. If a file grows beyond a single clear responsibility, split it.
- **Leave the codebase cleaner than you found it.** If you touch a file and notice mess — stale comments, unused variables, poor organization — fix it. Don't punt cleanup to a future task. The cost of cleaning up now is always lower than the cost of a future agent being misled by dead code.

### 2. Security

Autoboard spawns subprocesses with `--dangerously-skip-permissions` and manages git operations. Security mistakes can corrupt repos or run arbitrary code.

- **No shell injection.** All subprocess calls must use `execFileSync`/`spawn` with argument arrays — never string interpolation into shell commands.
- **Validate all manifest input.** Task fields parsed from markdown are untrusted. Sanitize file paths, task IDs, and branch names before passing to git commands.
- **Never commit to or push to `main`.** Enforced in worktree manager. All git operations target the feature branch only.
- **Worktree cleanup on all exit paths.** Success, failure, or interrupt — all worktrees must be removed. Orphaned worktrees/branches are a bug.
- **Atomic file writes.** Use write-to-temp-then-rename for state files to prevent corruption on crash.
- **When you encounter a potential security issue — even a minor one — flag it explicitly.** Do not silently work around security problems.

### 3. Performance

The orchestrator must not be the bottleneck — agent spawning and git operations should be fast.

- **Minimize git operations.** Batch where possible. Don't run redundant status checks.
- **No N+1 patterns.** If iterating tasks, don't shell out to git per-task when a single command suffices.
- **Non-blocking I/O for agent streams.** Stream parsing must not block the event loop. Use line-buffered processing.
- **Serialize only what must be serialized.** Merges are serialized (correctness requirement). Everything else runs concurrently up to the concurrency limit.
- **Keep the main loop responsive.** The 2-second polling interval and 1-second render interval must not be blocked by synchronous operations.

### 4. Scalability

The architecture must handle task manifests with 50+ tasks without degradation.

- **O(n) or O(n log n) algorithms only.** Dependency resolution, conflict detection, and task scheduling must not be quadratic or worse as task count grows.
- **Stateless between loop iterations.** The main loop re-derives state from task statuses each iteration. No stale caches that could drift.
- **File conflict detection scales with task count.** Use Sets for O(1) lookups, not array scans.
- **Worktree paths are deterministic.** Based on task ID only — no random suffixes that could leak on crash.

### 5. Mandatory Review Gates

Two review gates are BLOCKING PREREQUISITES in every development session. Skipping either is a non-negotiable violation — equivalent to shipping without tests.

**Gate 1 — Plan Review (before implementation):**
- **When:** Implementation plan is written
- **Action:** Use the **Agent tool** to spawn an independent review subagent that evaluates the plan for completeness, correctness, DRY, security, testability, and dependency awareness
- **Then:** Critically evaluate the feedback — do NOT blindly agree. Push back on wrong suggestions with technical reasoning. Accept valid improvements.
- **Then:** Update the plan with accepted changes before writing any code
- **NEVER start implementation without completing this gate**

**Gate 2 — Code Review (before final commit):**
- **When:** Implementation complete, build and tests passing
- **Action:** Use the **Agent tool** to spawn an independent review subagent that examines code changes for correctness, security, DRY, test coverage, performance, code quality, and navigability
- **Then:** Critically evaluate the feedback — do NOT performatively agree. Verify each suggestion technically. Push back with evidence when wrong. Accept and fix valid issues.
- **Then:** Implement fixes, re-run build + tests
- **NEVER finalize a commit without completing this gate**

**Receiving review feedback — critical thinking protocol:**

| Thought that means STOP | Reality |
|------------------------|---------|
| "The reviewer said X, so I'll just do X" | Verify X is correct first. Reviewers can be wrong. |
| "I'll accept all suggestions to be safe" | Accepting wrong suggestions makes code worse, not better. |
| "This suggestion seems off but I'll do it anyway" | If it seems off, investigate. Trust your analysis. |
| "The plan looks good, I'll skip review" | Run the review subagent. Every time. No exceptions. |
| "All tests pass, time to commit" | Run the code review subagent first. |

These gates apply to ALL development — whether working interactively, via `scripts/run.ts` agents, or in any other context. The Agent tool subagent dispatching is the mechanism for headless (`claude -p`) mode where slash commands are unavailable.
