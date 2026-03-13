# Liteboard Memory Log

## T7 - Update brainstorm skill config template - 2026-03-12T17:10:38.280Z

# T7 Memory Entry — Update brainstorm skill config template

## What was done
Replaced the default `config.json` template in `skills/brainstorm.md` from the flat `"models"` format (6 top-level slots) to the new nested `"agents"` format with `architect`, `implementation`, and `qa` roles, each containing `provider`, `model`, and `subagents`.

## Decisions
- Used the design doc's default all-Claude config (lines 103-129) as the source of truth for the template, not the current `defaultModelConfig()` in `src/types.ts` (which is still flat and will be updated by Task 1).
- Code reviewer flagged a blocking issue about the template not matching the current `defaultModelConfig()` runtime output. Pushed back: Task 7 has no dependencies and runs in parallel with Task 1 on the same feature branch. The design doc is authoritative for the target format.

## For next agent
- The brainstorm skill template now emits the nested `"agents"` format. Once Task 1 merges, `defaultModelConfig()` will match this template exactly.
- No other files were touched.


## T3 - Agent orientation commands for architect/implementation split - 2026-03-12T17:13:48.779Z

# Task 3 Memory Entry — Agent Orientation Split

## What Was Done

Split the monolithic `commands/agent-orientation.md` (6-phase workflow) into two role-specific orientation files:

1. **Created `commands/architect-orientation.md`** — 3-phase workflow (Explore → Plan → Plan Review) for the architect agent that produces implementation plans but does not write code.

2. **Modified `commands/agent-orientation.md`** — Narrowed to 3-phase workflow (Implement → Verify → Code Review & Commit) for the implementation agent that receives a pre-written plan.

## Key Decisions

- **Renamed "Plan Execution Discipline" to "Planning Discipline"** in the architect orientation. The architect produces plans, not executes them — the section content was adapted accordingly (explore-first, reference specific files/functions, include verification commands, TDD structure for TDD tasks).

- **Added "Before You Start" section** to agent-orientation.md instructing the implementation agent to read the task plan from the brief-provided path before beginning work.

- **Added "Plan Output" section** to architect-orientation.md specifying what the plan file should contain (summary, steps with paths, verification commands, unresolved items).

- **Removed "and line numbers"** from architect planning discipline per code review feedback — line numbers are brittle in a multi-agent codebase where files change between architect and implementation phases.

- **Both files reference "the path provided in the brief"** for plan location — the actual path injection is Task 5's responsibility (`buildArchitectBrief()` / `buildImplementationBrief()`).

## What the Next Agent Should Know

- Task 5 ("Brief split for architect and implementation agents") depends on these files. It needs to:
  - Create `buildArchitectBrief()` that reads `commands/architect-orientation.md` and injects the plan output path
  - Modify `buildBrief()` → `buildImplementationBrief()` that reads the updated `commands/agent-orientation.md` and injects the plan read path
  - Update sub-agent model hints: architect gets explore + planReview, implementation gets codeReview only
  - Remove plan-review.md injection from the implementation brief (it belongs in the architect brief only)


## T1 - Refactor types for nested agent config - 2026-03-12T17:17:52.916Z

## T1 - Refactor types for nested agent config

### What was done
- Replaced flat `AgentSlotConfig` + 6-slot `ModelConfig` with nested structure: `SubagentConfig`, `AgentConfig`, `ModelConfig` (3 roles: architect, implementation, qa)
- Added `OllamaConfig`, `ProjectConfig` interfaces
- Added `ollama?: OllamaConfig` to `CLIArgs`, `env?: Record<string, string>` to `SpawnOpts`, `provider?: string` to `Task`
- Updated `Provider.subagentModelHint()` signature to accept `providerName: string`
- Updated `defaultModelConfig()` to return nested structure with correct defaults
- Updated consumer files minimally: `brief.ts` (model access paths), `provider.ts` (signature), `cli.ts` (config merge + --model flag)
- Created `tests/types.test.ts` with 16 tests (TDD RED -> GREEN)

### Key decisions
- Consumer file updates were minimal to keep build passing. Full rewrites happen in later tasks (T2: provider, T4: config parsing, T5: brief split)
- `brief.ts` hardcodes `"claude"` as providerName in `subagentModelHint` calls — T5 will make this provider-aware
- `cli.ts` config.json merge was rewritten for nested `"agents"` key with deprecation warning on old `"models"` key — T4 will extract this to `src/config.ts`
- `task.provider` field added but not set anywhere yet — T9 wires it up during spawnTask
- `ProjectConfig` added but not consumed yet — T4 will use it

### What the next agent should know
- `AgentSlotConfig` is fully removed, zero references remain
- All 249 tests pass, tsc clean, build clean
- The `spawner.test.ts` mock provider (`makeMockProvider`) is missing `subagentModelHint` method — it was missing before this task too and doesn't cause issues since tests/ are excluded from tsc


## T6 - Dashboard provider indicator - 2026-03-12T17:24:42.673Z

# T6 Memory Entry — Dashboard provider indicator

## What was done
Added a provider indicator tag (`[C]`/`[O]`) to the dashboard's running and failed task lines in `src/dashboard.ts`:
- `[C]` (cyan) for Claude provider or undefined/missing (backward compat)
- `[O]` (yellow) for Ollama provider
- Adjusted truncation widths by 4 chars to account for the tag in both running (`cols - 55` → `cols - 59`) and failed (`cols - 40` → `cols - 44`) task lines
- Added a `providerTag(task)` helper function placed after `truncate()` to avoid duplicating the conditional logic

## Decisions
- Unknown providers (anything other than "ollama") silently default to `[C]`. This is acceptable since only "claude" and "ollama" are valid providers in the system, enforced by config validation (Task 4). If the provider set ever expands, this fallback should be revisited.
- Title truncation width (35 chars) was not reduced — the `last` field absorbs the width compression from the provider tag.

## For next agent
- `task.provider` is set by Task 9 (`spawnTask`) during architect and implementation phase spawning. Until T9 merges, all tasks will render with `[C]` (undefined fallback).
- No test file was created — `dashboard.ts` is TDD-exempt per CLAUDE.md.


## T2 - Provider env injection and Ollama helpers - 2026-03-12T17:27:31.093Z

# T2 Memory Entry — Provider env injection and Ollama helpers

## What was done
- Updated `ClaudeCodeProvider.spawn()` to merge `opts.env` into the child process environment, with defense-in-depth deletion of CLAUDECODE after merge
- Updated `subagentModelHint()` to return `""` for non-claude providers (Ollama subagents inherit parent model)
- Added `getProviderEnv()` — returns `{ ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" }` for Ollama, `undefined` for Claude
- Added `checkOllamaHealth()` — fetches `${baseUrl}/api/tags` with 5s timeout, returns boolean
- Added `validateOllamaBaseUrl()` — validates URL is parseable and uses http/https protocol
- All functions exported from `src/provider.ts`
- 23 new tests added (TDD RED -> GREEN), total 274/274 passing

## Key decisions
- Defense-in-depth: CLAUDECODE is deleted after `Object.assign(env, opts.env)` to prevent re-insertion via opts.env. Test verifies this.
- `checkOllamaHealth` normalizes trailing slashes from baseUrl before appending `/api/tags`
- `getProviderEnv` uses `??` (not `||`) for baseUrl default — empty string baseUrl would not fall back to default, but `validateOllamaBaseUrl` is a precondition that rejects empty strings
- Code reviewer flagged brief.ts and spawner.ts integration as BLOCKING — pushed back: Task 5 updates brief.ts call sites, Task 9 wires spawner.ts env passthrough. T2's scope is `src/provider.ts` only per manifest.

## What the next agent should know
- `getProviderEnv()`, `checkOllamaHealth()`, `validateOllamaBaseUrl()` are exported but not yet called from any other module — downstream tasks wire them in:
  - Task 4 (Config): calls `validateOllamaBaseUrl()` and `checkOllamaHealth()` during config validation
  - Task 5 (Brief): calls `subagentModelHint()` with actual provider name instead of hardcoded `"claude"`
  - Task 9 (spawnTask): calls `getProviderEnv()` and passes env to `spawnAgent()`
- `subagentModelHint()` now returns `""` for non-claude providers — callers in `brief.ts` still hardcode `"claude"` (Task 5 fixes this)


## T5 - Split brief into architect and implementation briefs - 2026-03-12T17:42:52.989Z

# T5 Memory Entry — Split brief into architect and implementation with Ollama hint handling

## What was done
- Extracted `formatSubagentHints()` shared helper in `src/brief.ts` that handles Ollama's empty-hint case: non-empty hint → `model: "<hint>"`, empty hint → `(inherits parent model — do not specify a model parameter)`
- Extracted `appendSubagentModelsSection()`, `appendMemorySnapshot()`, `appendTaskDetails()` private helpers to DRY up the three brief builders
- Created `buildArchitectBrief()`: uses `architect-orientation.md`, explore+planReview sub-agent hints, explore hints, plan-review workflow with code-reviewer.md criteria, plan-write instruction to `<artifactsDir>/t<N>-task-plan.md`
- Renamed `buildBrief()` internals to `buildImplementationBrief()`: removed explore/plan phases, added plan-read instruction from `<artifactsDir>/t<N>-task-plan.md`, codeReview hint only, phases renumbered to 1-3
- Kept `buildBrief()` as backward-compatible dispatcher (non-QA → `buildImplementationBrief`, QA → `buildQABrief`) so `cli.ts` continues working unchanged
- Updated `buildQABrief()` to use shared helpers, removed redundant `slug` parameter
- All three brief functions use `models.<role>.provider` for providerName (not hardcoded `"claude"`)

## Key decisions
- `buildBrief()` retained as dispatcher rather than being removed — cli.ts imports it, and Task 9 will wire up the architect/implementation split in the spawner
- Architect brief includes `code-reviewer.md` and `receiving-code-review.md` because `plan-review.md` explicitly references them for evaluation criteria and feedback processing
- Added "Do NOT commit" rule to architect brief as defense-in-depth (architect-orientation.md already says "no code", but explicit is safer)
- Explore hints removed from implementation brief — the implementation agent reads the pre-written plan, doesn't explore

## For next agent
- `buildArchitectBrief()` is exported but has no call site yet — Task 9 (two-phase spawnTask) will call it during the architect phase
- `buildBrief()` still works identically to before for non-QA tasks (delegates to `buildImplementationBrief`), so cli.ts needs no changes until Task 9
- The plan artifact path convention is `<artifactsDir>/t<N>-task-plan.md` — the architect writes it, the implementation agent reads it
- 56 brief tests, 299 total tests all passing


## T4 - Config parsing and validation module - 2026-03-12T17:45:08.965Z

# T4 Memory Entry — Config parsing and validation module

## What was done
- Created `src/config.ts` with four exported functions extracted from `cli.ts`:
  - `parseProjectConfig(configPath)` — reads config.json, deep-merges `agents` with `defaultModelConfig()` defaults. Handles missing files, invalid JSON, non-object JSON (null/array), old `"models"` format (deprecation warning, skips agent merge but still extracts concurrency/branch/ollama).
  - `validateConfig(config)` — throws on unknown provider names, ollama provider without ollama section, and missing required subagents. Required subagents are derived from `defaultModelConfig()` (single source of truth).
  - `applyOllamaFallback(config)` — mutates config in-place, rewriting ollama agents to claude defaults with per-role warning.
  - `hasOllamaProvider(config)` — predicate checking if any agent uses ollama provider.
- Updated `src/cli.ts`:
  - Replaced 45-line inline config loading block with `parseProjectConfig()` call
  - Reordered `main()`: config parsing now runs before `checkPrereqs()` so ollama health check has the config
  - Made `checkPrereqs()` async with ollama health check: validates base URL, checks health, applies fallback or dies
  - Removed unused `ModelConfig` type import
- Created `tests/config.test.ts` with 34 tests (TDD RED → GREEN)

## Key decisions
- `REQUIRED_SUBAGENTS` is derived from `defaultModelConfig()` at module level rather than hardcoded — keeps required subagents in sync with defaults automatically.
- `DEFAULT_SUBAGENT_MODEL` constant ("claude-sonnet-4-6") used for subagents not found in defaults during fallback.
- `log()` function duplicated from cli.ts as a one-liner — consistent with other modules (parser.ts, merger.ts) that use console.error directly.
- Code review caught a regression: `JSON.parse("null")` returns null, and `"models" in null` throws. Added object-type guard after JSON.parse to handle null, arrays, and other non-object JSON values.
- `applyOllamaFallback` mutates in-place — no reassignment needed in cli.ts (same object reference).

## What the next agent should know
- `parseProjectConfig()` returns a `ProjectConfig` with defaults-merged agents. CLI overrides (--model, --concurrency, --branch) are applied in `cli.ts` after parsing, not inside `parseProjectConfig`.
- `validateConfig()` is called after CLI overrides are applied, so it validates the final merged config.
- `checkPrereqs()` is now async — `main()` calls `await checkPrereqs(args)`.
- The concurrency value from config.json is not clamped to [1,5] like the CLI flag is — pre-existing gap, flagged but not in scope for T4.
- Task 9 (spawnTask) will wire `getProviderEnv()` calls using `args.ollama` which is now populated from config.


## T9 - Two-phase spawnTask with architect→implementation flow - 2026-03-12T18:03:43.310Z

# T9 Memory Entry — Two-phase spawnTask with architect→implementation flow

## What was done
- Added `env?: Record<string, string>` parameter to `spawnAgent()` in `src/spawner.ts`, passing it through to `provider.spawn()` via `SpawnOpts.env` for Ollama provider env injection
- Refactored `spawnTask()` in `src/cli.ts` for two-phase task execution:
  - Extracted `handleFinalClose` helper (shared close handler for merge/cleanup logic) to avoid duplicating the ~40-line handler between QA and implementation phases
  - QA tasks: single-phase spawn with `buildBrief()` (dispatches to `buildQABrief`), qa model, qa provider env
  - Non-QA tasks: two-phase architect→implementation flow:
    - Phase 1: Spawn architect agent with `buildArchitectBrief()`, architect model, architect env
    - Architect close handler: check exit code, verify plan file exists at `artifactsDir/t<N>-task-plan.md`
    - On failure: distinct error messages (`[ARCHITECT EXIT <code>]`, `[ARCHITECT] No task plan produced`)
    - Between phases: reset `task.stage`, `task.lastLine`, `task.bytesReceived`, `task.turnCount` for proper stall detection
    - Rename architect log (`t<N>.jsonl` → `t<N>-architect.jsonl`) and brief (`t<N>-brief.md` → `t<N>-architect-brief.md`) for debugging
    - Phase 2: Spawn implementation agent with `buildImplementationBrief()`, implementation model, implementation env
    - Reassign `task.process` so dashboard + stall detection track the active phase
  - Set `task.provider` per phase for dashboard `[C]`/`[O]` indicator (T6)
  - All env vars obtained via `getProviderEnv(providerName, args.ollama)` (T2)
  - Entire two-phase sequence wrapped in single Promise for `activePromises`
- Updated `tests/spawner.test.ts`: added `subagentModelHint` to mock provider, added env passthrough test, updated existing opts test
- 334/334 tests passing, tsc clean, build clean

## Key decisions
- `handleFinalClose` extracted as a closure inside `spawnTask` rather than a module-level function — it captures `task`, `slug`, `args`, `filteredTasks`, `activePromises`, etc. from the enclosing scope. The `resolve` callback is passed explicitly.
- Architect failure paths (non-zero exit, missing plan) do manual cleanup (writeProgress, updateStatuses, activePromises.delete, resolve) rather than going through `handleFinalClose` — they're structurally different exit points that don't involve merge logic.
- `bytesReceived` and `turnCount` reset between phases to ensure implementation agent gets proper startup stall detection (2-min timeout). Without this, the carried-over non-zero `bytesReceived` from architect would skip startup timeout and use mid-task timeout (5-min) instead.
- Architect brief file renamed between phases to prevent the implementation's `spawnAgent` from overwriting it — preserves both briefs for debugging.
- Silent try/catch on file renames is intentional — these are best-effort debugging artifacts, not correctness-critical.

## What the next agent should know
- `spawnAgent()` now accepts an optional `env` parameter as its last argument. All existing call sites in cli.ts pass it; the spawner tests cover both `undefined` and explicit env.
- `buildBrief()` is still used for QA tasks (it dispatches to `buildQABrief` internally). `buildArchitectBrief()` and `buildImplementationBrief()` are called directly for the two-phase flow.
- SIGINT handler needs no changes — it kills `task.process`, which is reassigned between phases to always track the active child.
- The `getWorktreePath` import from worktree.ts is unused in cli.ts — pre-existing, not introduced by T9.


