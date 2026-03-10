# Liteboard — Task Manifest

> **Usage:** This manifest is the input for `docs/run.ts` (or the liteboard orchestrator). Each task is a self-contained work unit for a parallel agent. Tasks within the same dependency layer can execute concurrently.

**Design doc:** `docs/superpowers/specs/2026-03-10-liteboard-design.md`

**Session guide:** Not applicable — standalone manifest.

## Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 22+ |
| Language | TypeScript (strict mode) |
| Testing | Vitest |
| Process spawning | `node:child_process` (spawn, execFileSync) |
| Git operations | Direct git CLI via execFileSync |
| Package manager | npm |
| Build | tsc |

## Testing Strategy

- All `src/` modules except `dashboard.ts` require Vitest tests
- Tests use mocks/stubs for git commands and child processes (no real git repos in tests)
- Each test file mirrors its source module: `src/parser.ts` → `tests/parser.test.ts`
- Tests run via `npm test` (vitest)

## TDD Discipline

All orchestrator modules (parser, resolver, progress, memory, provider, worktree, spawner, merger, brief) follow RED → GREEN → REFACTOR. Dashboard is TDD-exempt (pure rendering). Skills and commands are markdown files — no TDD applicable.

---

## Phase 1: Foundation

### Task 1: Project Scaffolding

- **Creates:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, `src/`, `tests/`, `skills/`, `commands/`, `.gitignore`
- **Modifies:** (none)
- **Depends on:** None
- **Requirements:**
  - Initialize npm package with name `liteboard`, MIT license
  - Create LICENSE file with MIT license text
  - Set `"type": "module"` in package.json
  - Add bin entry: `"liteboard": "./dist/cli.js"`
  - Add dependencies: `typescript`, `vitest` (dev)
  - Add scripts: `build` (tsc), `test` (vitest), `dev` (tsx src/cli.ts)
  - Configure tsconfig.json for ES2022 target, strict mode, outDir `dist/`, module NodeNext, moduleResolution NodeNext
  - Configure vitest.config.ts with test include pattern `tests/**/*.test.ts`
  - Create directory structure: `src/`, `tests/`, `skills/`, `commands/`, `dist/` (gitignored)
  - Add `.gitignore` with `node_modules/`, `dist/`
  - Run `npm install` to generate lockfile
- **TDD Phase:** Exempt
- **Commit:** `task 1: project scaffolding`
- **Complexity Score:** 2
- **Suggested Session:** S1

### Task 2: Shared Types Module

- **Creates:** `src/types.ts`
- **Modifies:** (none)
- **Depends on:** Task 1
- **Requirements:**
  - Define `TaskStatus` union type: `"blocked" | "queued" | "running" | "done" | "failed"`
  - Define `Task` interface with all fields from design spec (id, title, creates, modifies, dependsOn, requirements, tddPhase, commitMessage, complexity, status, turnCount, lastLine, bytesReceived, startedAt, completedAt, process, worktreePath, logPath)
  - Define `ModelConfig` interface with per-stage provider+model pairs
  - Define `StreamEvent` discriminated union (message_start, text_delta, tool_use_start, tool_use_end, message_end, error)
  - Define `Provider` interface (name, spawn, parseStream, healthCheck)
  - Define `SpawnOpts` interface (prompt, model, cwd, verbose)
  - Define `CLIArgs` interface (projectPath, concurrency, model, branch, taskFilter, dryRun, verbose)
  - Export all types
- **TDD Phase:** Exempt (type-only module, verified by build)
- **Commit:** `task 2: shared types module`
- **Complexity Score:** 2
- **Suggested Session:** S1

---

## Phase 2: Core Modules (Parallelizable)

### Task 3: Brief Components

- **Creates:** `commands/agent-orientation.md`, `commands/code-reviewer.md`, `commands/plan-review.md`, `commands/session-review.md`, `commands/receiving-code-review.md`
- **Modifies:** (none)
- **Depends on:** Task 1
- **Requirements:**
  - `agent-orientation.md`: Write the spawned agent orientation document per design spec. Include: what liteboard is, mandatory 5-phase workflow (Explore → Plan → Plan Review → Implement → Code Review → Commit), Agent tool usage for explore/review subagents, rules (don't touch unrelated files, exact commit message, write .memory-entry.md), plan execution discipline (follow plan step by step, run every verification, stop when blocked, mark phases complete)
  - `code-reviewer.md`: Write the core review prompt. Evaluation criteria: correctness, security (OWASP top-10), DRY, test coverage, performance, code quality, navigability. Require specific, actionable, line-level feedback. Flag blocking issues vs nice-to-haves.
  - `plan-review.md`: Instructions for spawning an independent plan review subagent via Agent tool. Send plan + design doc + manifest to reviewer with code-reviewer.md criteria. Max 3 rounds.
  - `session-review.md`: Same pattern for post-implementation code review. Send diff + plan to reviewer subagent. Max 3 rounds.
  - `receiving-code-review.md`: Adapted from Obra:Superpowers receiving-code-review (MIT). Include: READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT pattern. Forbidden responses (no "You're absolutely right!", no performative agreement). Push back with technical reasoning. Implement one item at a time, test each. Credit Obra:Superpowers in a comment at top.
- **TDD Phase:** Exempt (markdown files)
- **Commit:** `task 3: brief components for agent prompts`
- **Complexity Score:** 3
- **Suggested Session:** S2

### Task 4: Manifest Parser

- **Creates:** `src/parser.ts`, `tests/parser.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Parse markdown manifest into `Task[]` array
  - Extract task fields: id, title, creates, modifies, dependsOn, requirements, tddPhase, commitMessage, complexity
  - Parse `### Task N: <title>` headers to split sections
  - Parse `**Creates:**`, `**Modifies:**` as comma-separated file lists (strip backticks)
  - Parse `**Depends on:**` as `Task N` references → number array
  - Parse `**Requirements:**` as bullet list (including sub-bullets)
  - Parse `**TDD Phase:**`, `**Commit:**`, `**Complexity Score:**` as single-value fields
  - Set initial statuses: no-dependency tasks → `"queued"`, tasks with dependencies → `"blocked"`
  - Handle malformed manifest gracefully (missing fields get defaults, log warnings)
  - Export `parseManifest(manifestPath: string): Task[]`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 4: manifest parser with tests`
- **Complexity Score:** 4 (3 + 1 TDD)
- **Suggested Session:** S2

### Task 5: Dependency Resolver

- **Creates:** `src/resolver.ts`, `tests/resolver.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Implement topological sort via Kahn's algorithm, producing execution layers
  - Each layer contains task IDs that can execute in parallel
  - Detect circular dependencies and throw descriptive error
  - Implement file conflict detection: two tasks conflict if their creates/modifies sets overlap (both create same file, both modify same file, one creates + one modifies same file)
  - Conflicting tasks treated as implicit ordering constraint (lower ID first)
  - Export `topologicalSort(tasks: Task[]): Layer[]` where `Layer = { layerIndex: number; taskIds: number[] }`
  - Export `hasFileConflict(a: Task, b: Task): boolean`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 5: dependency resolver with tests`
- **Complexity Score:** 4 (3 + 1 TDD)
- **Suggested Session:** S2

### Task 6: Progress Manager

- **Creates:** `src/progress.ts`, `tests/progress.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Write progress.md as a markdown table: `| Task | Title | Status | Completed At | Failure Summary |`
  - Atomic write: write to temp file, then rename (prevents partial reads)
  - Read progress.md and return map of completed task IDs to timestamps
  - Detect completed tasks from git log as fallback: match `[task N]` prefix or exact commitMessage in log output
  - Extract failure summary for failed tasks (short string for supervisor consumption)
  - Export `writeProgress(tasks: Task[], projectDir: string): void`
  - Export `readProgress(projectDir: string): Map<number, string>`
  - Export `detectCompletedFromGitLog(branch: string, tasks: Task[], verbose: boolean): Set<number>`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 6: progress manager with tests`
- **Complexity Score:** 4 (3 + 1 TDD)
- **Suggested Session:** S2

### Task 7: Memory Manager

- **Creates:** `src/memory.ts`, `tests/memory.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Append memory entries to memory.md with mutex serialization
  - Entry format: `## T<id> - <title> - <ISO timestamp>` followed by body content
  - Initialize memory.md with header if it doesn't exist
  - Atomic write: temp file + rename
  - Build memory snapshot for brief injection: read memory.md, return content string
  - Mutex implementation: use a promise-chain lock to serialize concurrent appends (same pattern as run.ts mergeLock)
  - Memory append happens AFTER successful squash merge (not after agent exit) — caller is responsible for ordering
  - Export `appendMemoryEntry(projectDir: string, taskId: number, title: string, body: string): Promise<void>`
  - Export `readMemorySnapshot(projectDir: string): string`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 7: memory manager with tests`
- **Complexity Score:** 4 (3 + 1 TDD)
- **Suggested Session:** S2

### Task 8: Provider Abstraction + Claude Code Provider

- **Creates:** `src/provider.ts`, `tests/provider.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Implement `Provider` interface from types.ts
  - Implement `ClaudeCodeProvider` class:
    - `name`: `"claude"`
    - `spawn(opts)`: spawns `claude -p <prompt> --dangerously-skip-permissions --output-format stream-json --verbose --model <model>` in the given cwd. Returns ChildProcess. Strips CLAUDECODE env var from child env (allows nested sessions).
    - `parseStream(chunk)`: parses newline-delimited JSON from Claude's stream-json format. Maps to normalized StreamEvent types. Handle: `message_start` → `{ type: "message_start", turnIndex }`, `content_block_delta` with `text_delta` → `{ type: "text_delta", text }`, `content_block_start` with `tool_use` → `{ type: "tool_use_start", toolName }`, message completion → `{ type: "message_end" }`. Buffer partial lines across chunks.
    - `healthCheck()`: runs `which claude` and returns true/false
  - Export `createProvider(name: string): Provider` factory function
  - Export `ClaudeCodeProvider` class
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 8: provider abstraction with Claude Code provider and tests`
- **Complexity Score:** 4 (3 + 1 TDD)
- **Suggested Session:** S3

### Task 9: Worktree Manager

- **Creates:** `src/worktree.ts`, `tests/worktree.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Wrap git commands via `execFileSync("git", [...])` helper with optional verbose logging
  - `setupFeatureBranch(branch, verbose)`: create or checkout feature branch from HEAD. Never reference main directly.
  - `createWorktree(slug, taskId, featureBranch, verbose)`: create worktree at `/tmp/liteboard-<slug>-t<taskId>` with task branch `<featureBranch>-t<taskId>`. Clean up stale worktree if path exists. Always create from latest feature branch HEAD.
  - `cleanupWorktree(slug, taskId, featureBranch, verbose)`: remove worktree and delete task branch. Always runs (success/failure/crash).
  - `cleanupAllWorktrees(tasks, featureBranch, verbose)`: cleanup all task worktrees.
  - `cleanupStaleWorktrees(slug, verbose)`: on startup, list worktrees matching `/tmp/liteboard-<slug>-*`, remove orphans.
  - `getWorktreePath(slug, taskId)`: return `/tmp/liteboard-<slug>-t<taskId>`
  - Export all functions
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 9: worktree manager with tests`
- **Complexity Score:** 5 (4 + 1 TDD)
- **Suggested Session:** S3

### Task 10: Merger

- **Creates:** `src/merger.ts`, `tests/merger.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Implement the full merge protocol from design spec:
    - Step 1: Trial merge — `git checkout <feature>`, `git merge --squash --no-commit <task-branch>`
    - Step 2: Conflict resolution — package.json/lockfile: accept both, run npm install, stage. Other files: abort, squash task branch to single commit, rebase onto feature branch, retry trial merge. If rebase conflicts: abort immediately, mark failed.
    - Step 3: Validate — run `npm run build` on merge result pre-commit. Pass → commit. Fail → abort, mark failed with build error.
    - Step 4: Commit — `git commit -m "<exact task commit message>"`
  - Merge serialization: mutex (promise-chain lock). One merge at a time. Timeout after 60s → kill, abort, mark failed.
  - Nuclear option helper: `git merge --abort`, checkout feature branch, `git reset --hard HEAD`
  - Export `squashMerge(taskId, slug, featureBranch, commitMessage, verbose): Promise<void>`
  - Export `abortAndRecover(featureBranch, verbose): void`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 10: merger with trial merge protocol and tests`
- **Complexity Score:** 6 (5 + 1 TDD)
- **Suggested Session:** S3

### Task 11: Agent Spawner

- **Creates:** `src/spawner.ts`, `tests/spawner.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2, Task 8
- **Requirements:**
  - Spawn agent process using Provider interface
  - Write brief to temp file in worktree (`.brief-t<id>.md`) to avoid arg length issues
  - Create log file at `<projectDir>/logs/t<id>.jsonl`, pipe raw stdout to it
  - Parse stdout stream via provider.parseStream(), update task fields:
    - `turnCount`: increment on `message_start` events
    - `lastLine`: last non-empty text line, stripped of markdown chars (`#*\`_~`), truncated to 120 chars
    - On `tool_use_start`: set lastLine to `[using <toolName>]`
  - Capture stderr to log file with `[stderr]` prefix
  - Stall detection (runs on 15-second interval per agent):
    - Startup timeout: 2 minutes with zero bytes → kill (SIGTERM), mark failed
    - Mid-task stall: 5 minutes with no new bytes → kill, mark failed
    - Write failure reason to task.lastLine for supervisor
  - Return ChildProcess from spawn
  - Export `spawnAgent(task, brief, provider, model, wp, projectDir, verbose): ChildProcess`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 11: agent spawner with stall detection and tests`
- **Complexity Score:** 6 (5 + 1 TDD)
- **Suggested Session:** S4

### Task 12: Dashboard

- **Creates:** `src/dashboard.ts`
- **Modifies:** (none)
- **Depends on:** Task 2
- **Requirements:**
  - Render live terminal dashboard using ANSI escape codes (no framework)
  - Use cursor-home + clear-line approach for flicker-free updates (same pattern as run.ts)
  - Show: progress bar (filled/empty blocks), done/total count, failed count
  - Show running tasks with: task ID, title (truncated), turn count, elapsed time (M:SS), KB received, last line (truncated)
  - Show queued/blocked/done/failed task ID lists (collapsed counts)
  - Show log hint: `Logs: <projectDir>/logs/t<N>.jsonl`
  - Hide/show cursor on start/end
  - Export `renderStatus(tasks: Task[], projectDir: string): void`
  - Export `HIDE_CURSOR`, `SHOW_CURSOR` constants for lifecycle management
- **TDD Phase:** Exempt (pure rendering, tested manually)
- **Commit:** `task 12: terminal dashboard`
- **Complexity Score:** 3
- **Suggested Session:** S4

---

## Phase 3: Assembly

### Task 13: Brief Builder

- **Creates:** `src/brief.ts`, `tests/brief.test.ts`
- **Modifies:** (none)
- **Depends on:** Task 2, Task 3, Task 6, Task 7
- **Requirements:**
  - Assemble the full prompt string sent to each spawned agent
  - Read commands/*.md files from the package's commands/ directory (resolve via `__dirname` or import.meta.url)
  - Build brief in this order:
    1. agent-orientation.md content (always prepended)
    2. Task context: "I'm implementing Task N: <title> for the <slug> project."
    3. Design doc path + manifest path (agent reads them)
    4. Memory snapshot (from memory.ts readMemorySnapshot, injected at spawn time)
    5. Explore hints: auto-inferred from creates/modifies/dependsOn (same pattern as run.ts buildBrief)
    6. Task details: creates, modifies, requirements
    7. Workflow phases with embedded plan-review.md, session-review.md, receiving-code-review.md, code-reviewer.md content
    8. Commit message, worktree context, rules
  - Export `buildBrief(task, allTasks, projectDir, designPath, manifestPath, featureBranch): string`
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR`
- **Commit:** `task 13: brief builder with tests`
- **Complexity Score:** 4 (3 + 1 TDD)
- **Suggested Session:** S4

---

## Phase 4: Integration

### Task 14: CLI Entry Point + Main Loop

- **Creates:** `src/cli.ts`
- **Modifies:** `package.json`
- **Depends on:** Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11, Task 12, Task 13
- **Requirements:**
  - Parse CLI arguments: `liteboard run <project-path-or-slug> [options]`
  - Options: `--concurrency=N` (1-5, default 1), `--model=<model>`, `--branch=<name>`, `--tasks=<1,2,3>`, `--dry-run`, `--verbose`
  - Resolve project path: if slug, look in `docs/liteboard/<slug>/`. If path, use directly.
  - Read config.json from project dir if exists, merge with CLI overrides
  - Startup checks: verify git repo, verify claude CLI, warn about concurrent claude processes
  - Startup cleanup: cleanupStaleWorktrees, read progress + git log for resume detection
  - Setup feature branch via worktree.setupFeatureBranch
  - Dry-run mode: parse manifest, show dependency layers, exit
  - Main loop:
    - Track active agent promises
    - Unblock tasks whose deps are all done
    - Spawn queued tasks up to concurrency limit (skip file conflicts with running tasks)
    - On agent close (exit 0): read .memory-entry.md from worktree, squashMerge, appendMemoryEntry (after merge), mark done, writeProgress, cleanupWorktree
    - On agent close (non-zero): mark failed, writeProgress, cleanupWorktree
    - Check for stuck state (no running, no queued, some blocked)
    - Render dashboard every 1s via setInterval
    - Write progress on each loop iteration
  - Graceful shutdown: SIGINT handler, stop spawning, wait for running tasks (10s timeout), cleanup worktrees, show cursor
  - Gitignore management: ensure `<projectDir>/logs/.gitignore` exists with `*`, ensure `.brief-t*.md` and `.memory-entry.md` in repo .gitignore
  - Final summary: done/failed counts, branch ready message
  - Add shebang `#!/usr/bin/env node` for bin entry
- **TDD Phase:** Exempt (integration module, verified by end-to-end usage)
- **Commit:** `task 14: CLI entry point and main orchestration loop`
- **Complexity Score:** 5
- **Suggested Session:** S5

---

## Phase 5: Skills

### Task 15: Brainstorm Skill

- **Creates:** `skills/brainstorm.md`
- **Modifies:** (none)
- **Depends on:** Task 1
- **Requirements:**
  - Write skill frontmatter: `name: brainstorm`, description for Claude Code skill discovery
  - Adapt from Obra:Superpowers brainstorming skill (MIT). Credit Obra:Superpowers at top.
  - Include HARD-GATE: no implementation until design is approved
  - Include anti-pattern section: "This Is Too Simple To Need A Design"
  - Checklist: explore project context, ask clarifying questions (one at a time, multiple choice preferred), propose 2-3 approaches with trade-offs, present design in sections with approval checkpoints, write design doc
  - Design doc output path: `docs/liteboard/<auto-slug>/design.md`
  - Create project folder structure on first write (design.md, config.json with defaults, logs/.gitignore)
  - Auto-generate slug from topic
  - Spec review loop: dispatch spec-document-reviewer subagent after writing, loop up to 5 iterations
  - Include spec-document-reviewer prompt template inline (adapted from superpowers)
  - Terminal state: prompt user to run `/liteboard:task-manifest`
  - Key principles: one question at a time, multiple choice preferred, YAGNI ruthlessly, explore alternatives, incremental validation
  - Do NOT include visual companion (v2)
- **TDD Phase:** Exempt (markdown skill file)
- **Commit:** `task 15: brainstorm skill`
- **Complexity Score:** 3
- **Suggested Session:** S5

### Task 16: Task-Manifest Skill

- **Creates:** `skills/task-manifest.md`
- **Modifies:** (none)
- **Depends on:** Task 1
- **Requirements:**
  - Write skill frontmatter: `name: task-manifest`, description for Claude Code skill discovery
  - Adapt from Willie Tran's task-manifest command
  - Input: `DESIGN_DOC` path (required). Resolve from `docs/liteboard/<slug>/design.md` if slug provided.
  - Output: `docs/liteboard/<slug>/manifest.md`
  - Task extraction model: parse design doc sections, detect work units, generate normalized task records
  - Task record fields: taskId, title, creates, modifies, dependsOn, requirements, tddPhase, commitMessage, complexityScore
  - Dependency inference: honor explicit deps, infer from file/data-flow coupling, topologically valid ordering
  - TDD inference: backend/service/pipeline tasks default TDD, UI tasks exempt
  - Complexity scoring rubric (1-5 scale + 1 for TDD)
  - Architect review loop: dispatch critic subagent (max 3 rounds) evaluating completeness, security, DRY, dependency correctness, explore coverage. Write audit trail to `docs/liteboard/<slug>/architect-review.md`
  - Required output sections: title, design doc reference, tech stack, testing strategy, TDD discipline, phase sections with task entries, dependency graph, TDD tasks table, security checklist
  - Terminal state: show summary (task count, layers, high-complexity callouts), prompt user to run `/liteboard:run`
- **TDD Phase:** Exempt (markdown skill file)
- **Commit:** `task 16: task-manifest skill`
- **Complexity Score:** 3
- **Suggested Session:** S5

### Task 17: Run Skill

- **Creates:** `skills/run.md`
- **Modifies:** (none)
- **Depends on:** Task 14
- **Requirements:**
  - Write skill frontmatter: `name: run`, description for Claude Code skill discovery
  - Skill tells Claude to:
    1. Resolve project path from argument (slug → `docs/liteboard/<slug>/`, or direct path)
    2. Verify manifest.md exists in project dir
    3. Launch orchestrator via Bash tool with `run_in_background: true`: `liteboard run <project-path> --concurrency=<N> --verbose`
    4. Enter supervisor loop
  - Supervisor loop instructions (baked into skill):
    - Read `progress.md` via Read tool (~50 lines, cheap)
    - On task completed: tail last 20 lines of log, confirm reviews ran + tests passed + merge clean, report to user
    - On task failed: read failure summary from progress.md, if more detail needed tail last 50 lines of log, diagnose (merge conflict? build error? stall?), retry if retriable (max 2 retries per task), flag to user if unrecoverable
    - On all done: final summary, prompt user for PR creation
    - On nothing new: brief status line
    - Adaptive wait: 5 min after completion/failure, 15 min steady state, 25 min long-running no changes
    - Sleep via Bash tool (`sleep <N>`)
  - Supervisor does NOT: read full logs, evaluate code quality, deeply analyze agent work, intervene in running tasks
  - Cross-task breakage detection: if a task fails that other tasks depend on, flag the cascade
- **TDD Phase:** Exempt (markdown skill file)
- **Commit:** `task 17: run skill with baked-in supervisor`
- **Complexity Score:** 3
- **Suggested Session:** S5

---

## Phase 6: Distribution

### Task 18: Build Pipeline + Setup Command

- **Creates:** `src/setup.ts`, `README.md`
- **Modifies:** `package.json`, `tsconfig.json`
- **Depends on:** Task 14, Task 15, Task 16, Task 17
- **Requirements:**
  - Add `prepublishOnly` script to package.json: `npm run build`
  - Verify `bin` entries in package.json: `"liteboard": "./dist/cli.js"`
  - Create `src/setup.ts`: `liteboard setup` command that:
    - Detects Claude Code plugin directory (e.g., `~/.claude/plugins/` or similar)
    - Copies or symlinks `skills/` directory to the plugin location
    - Prints success message with installed skill names
    - Handles case where Claude Code is not installed (clear error message)
  - Add `"liteboard-setup": "./dist/setup.js"` to bin (or handle as subcommand of liteboard)
  - Verify `npm run build` produces working dist/ output
  - Verify `node dist/cli.js --help` works
  - Write README.md with: overview, installation (`npm i -g liteboard && liteboard setup`), usage workflow (/liteboard:brainstorm → /liteboard:task-manifest → /liteboard:run), attribution to Obra:Superpowers
- **TDD Phase:** Exempt (integration/distribution)
- **Commit:** `task 18: build pipeline, setup command, and README`
- **Complexity Score:** 3
- **Suggested Session:** S6

---

## Task Dependency Graph

```
Task 1 (scaffolding)
├── Task 2 (types)
│   ├── Task 4 (parser) ─────────────────────┐
│   ├── Task 5 (resolver) ───────────────────┤
│   ├── Task 6 (progress) ──────┬────────────┤
│   ├── Task 7 (memory) ───────┬┤────────────┤
│   ├── Task 8 (provider) ──┬──┘│            │
│   │   └── Task 11 (spawner)│   │            │
│   ├── Task 9 (worktree) ──┘   │            │
│   ├── Task 10 (merger) ───────┘            │
│   ├── Task 12 (dashboard) ─────────────────┤
│   └── Task 13 (brief) ────────────────────┤
│       (depends on 2, 3, 6, 7)              │
├── Task 3 (brief components) ───────────────┤
├── Task 15 (brainstorm skill) ──────────────┤
├── Task 16 (task-manifest skill) ───────────┤
│                                             │
└─────────────────────────── Task 14 (CLI) ◄──┘
                                │
                                ├── Task 17 (run skill)
                                │
                                └── Task 18 (distribution)
```

**Execution Layers:**
- Layer 0: Task 1
- Layer 1: Task 2, Task 3, Task 15, Task 16
- Layer 2: Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 12
- Layer 3: Task 11, Task 13
- Layer 4: Task 14
- Layer 5: Task 17
- Layer 6: Task 18

**Max parallelism at Layer 2: 8 tasks**

---

## TDD Tasks

| Task | Module | TDD Phase |
|------|--------|-----------|
| Task 4 | parser.ts | RED → GREEN → REFACTOR |
| Task 5 | resolver.ts | RED → GREEN → REFACTOR |
| Task 6 | progress.ts | RED → GREEN → REFACTOR |
| Task 7 | memory.ts | RED → GREEN → REFACTOR |
| Task 8 | provider.ts | RED → GREEN → REFACTOR |
| Task 9 | worktree.ts | RED → GREEN → REFACTOR |
| Task 10 | merger.ts | RED → GREEN → REFACTOR |
| Task 11 | spawner.ts | RED → GREEN → REFACTOR |
| Task 13 | brief.ts | RED → GREEN → REFACTOR |

**TDD-exempt:** Task 1 (scaffolding), Task 2 (types), Task 3 (commands), Task 12 (dashboard), Task 14 (CLI), Tasks 15-18 (skills, distribution)

---

## Security Checklist

| Risk | Mitigation | Task |
|------|-----------|------|
| Command injection via manifest fields | Parser sanitizes all fields; commitMessage passed as single git arg, not shell-interpolated | Task 4, Task 10 |
| Worktree path traversal | Worktree paths are hardcoded to `/tmp/liteboard-*` pattern, validated before use | Task 9 |
| CLAUDECODE env var leak to child | Spawner strips CLAUDECODE from child env | Task 11 |
| Memory.md concurrent corruption | Mutex serialization on all writes, atomic write (temp + rename) | Task 7 |
| Progress.md partial read | Atomic write (temp + rename) | Task 6 |
| Orphaned worktrees on crash | Startup cleanup scans for stale worktrees | Task 9, Task 14 |
| Secrets in agent briefs | Brief builder reads only design doc path and manifest path, not their content; agent reads files itself | Task 13 |
| `--dangerously-skip-permissions` | V1 limitation, documented as out-of-scope for configurable permissions | Task 8 |
| Package.json merge conflicts | Auto-resolution: accept both sides, run npm install | Task 10 |
| Feature branch never pushes to main | Enforced by worktree manager: never references main, only feature branch | Task 9 |

---

## Session-Grouping Hints

| Session | Tasks | Total Score | Context Estimate |
|---------|-------|-------------|------------------|
| S1 | T1 (2), T2 (2) | 4 | 20-35% |
| S2 | T3 (3), T4 (4), T5 (4), T6 (4), T7 (4) | 19 | >50% (High-load exception — 5 independent tasks, optimal for parallel agents) |
| S3 | T8 (4), T9 (5), T10 (6) | 15 | >50% (High-load exception — complex git modules) |
| S4 | T11 (6), T12 (3), T13 (4) | 13 | >50% (High-load exception — spawner is complex) |
| S5 | T14 (5), T15 (3), T16 (3), T17 (3) | 14 | >50% (High-load exception — CLI integrates all modules) |
| S6 | T18 (3) | 3 | 20-35% |

**Note:** S2-S5 exceed the 10-point session cap because tasks within each session are designed for parallel agent execution via liteboard's orchestrator. Each individual agent handles one task within its own context budget. The session groupings here represent orchestrator batches, not single-agent sessions.

**High-load exceptions: 4** (S2, S3, S4, S5)
**Assumptions: 0**
**Open risks: 0**
