# Ollama Compatibility + Architect Agent — Task Manifest

**Design doc:** `docs/liteboard/ollama-compat/design.md`

## Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 22+ |
| Language | TypeScript (strict mode, ES2022, NodeNext) |
| Testing | Vitest |
| Package manager | npm |
| Build | tsc |

## Testing Strategy

- All new modules (`src/config.ts`) get full Vitest coverage
- All modified modules with existing tests (`src/provider.ts`, `src/brief.ts`) get updated/expanded tests
- `src/cli.ts` and `src/dashboard.ts` remain test-exempt per CLAUDE.md — testable logic is extracted into dedicated modules
- Config parsing/validation is extracted from `cli.ts` into `src/config.ts` specifically to be testable
- Mock `node:fs`, `node:child_process`, and `fetch` in tests — no real I/O

## TDD Discipline

| Task | TDD Phase | Rationale |
|------|-----------|-----------|
| T1: Types refactor | RED → GREEN | New `defaultModelConfig()` shape, type constraints |
| T2: Provider updates | RED → GREEN | New functions: `getProviderEnv()`, `checkOllamaHealth()`, `validateOllamaBaseUrl()`, updated `subagentModelHint()` |
| T3: Agent orientation commands | Exempt | Pure markdown, no testable logic |
| T4: Config parsing module | RED → GREEN | Pure logic: parsing, validation, fallback — ideal TDD candidate |
| T5: Brief split | RED → GREEN | `buildArchitectBrief()`, `buildImplementationBrief()`, Ollama model hint logic |
| T6: Dashboard indicator | Exempt | `dashboard.ts` exempt per CLAUDE.md |
| T7: Brainstorm skill update | Exempt | Markdown template, no logic |
| T9: Two-phase spawnTask | Exempt | `cli.ts` exempt per CLAUDE.md |

---

## Phase 1: Foundation

### Task 1: Refactor types for nested agent config

- **Creates:** `tests/types.test.ts`
- **Modifies:** `src/types.ts`
- **Depends on:** (none)
- **Requirements:**
  - Replace `AgentSlotConfig` with `SubagentConfig` (model only, no provider)
  - Add `AgentConfig` interface: `{ provider: string; model: string; subagents: Record<string, SubagentConfig> }`
  - Replace flat `ModelConfig` with nested structure: `{ architect: AgentConfig; implementation: AgentConfig; qa: AgentConfig }`
  - Add `OllamaConfig` interface: `{ baseUrl: string; fallback: boolean }`
  - Add `ProjectConfig` interface: `{ ollama?: OllamaConfig; agents: ModelConfig; concurrency: number; branch?: string }`
  - Add `ollama?: OllamaConfig` to `CLIArgs`
  - Add `env?: Record<string, string>` to `SpawnOpts`
  - Add `provider?: string` to `Task` (for dashboard indicator)
  - Update `Provider.subagentModelHint()` interface signature to accept `providerName: string` parameter
  - Update `defaultModelConfig()` to return the new nested structure with architect/implementation/qa and their subagents
  - Remove dead `AgentSlotConfig` type completely
  - Create `tests/types.test.ts`:
    - Test `defaultModelConfig()` returns correct nested structure with all 3 agent roles
    - Test each agent has correct subagents (architect: explore + planReview, implementation: codeReview, qa: qaFixer)
    - Test default providers are all "claude"
    - Test default models match expected values (opus for architect/implementation/qa, sonnet for explore/codeReview)
- **TDD Phase:** `RED → GREEN`
- **Commit:** `task 1: refactor types for nested agent config with architect role`
- **Complexity Score:** 4
- **Suggested Session:** S1

### Task 2: Provider env injection and Ollama helpers

- **Creates:** (none)
- **Modifies:** `src/provider.ts`
- **Depends on:** Task 1
- **Requirements:**
  - Update `ClaudeCodeProvider.spawn()` to merge `opts.env` into the child process environment (after stripping CLAUDECODE, before spawning)
  - Update `subagentModelHint()` signature to accept `providerName: string` parameter
    - For `"claude"`: existing behavior (opus/sonnet/haiku shorthand)
    - For `"ollama"`: return empty string `""`
  - Add exported `getProviderEnv(providerName: string, ollamaConfig?: OllamaConfig): Record<string, string> | undefined`
    - For `"ollama"`: returns `{ ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" }`
    - For `"claude"`: returns `undefined`
    - Uses `ollamaConfig.baseUrl` if provided, defaults to `"http://localhost:11434"`
  - Add exported `checkOllamaHealth(baseUrl: string): Promise<boolean>`
    - `fetch(baseUrl/api/tags)` with 5s `AbortSignal.timeout`
    - Returns `true` if response.ok, `false` on error/timeout
  - Add exported `validateOllamaBaseUrl(url: string): void`
    - Parse with `new URL(url)`, throw on invalid
    - Reject protocols other than `http:` and `https:`
    - Throw descriptive error: `"Invalid ollama.baseUrl: must be an http:// or https:// URL"`
- **TDD Phase:** `RED → GREEN`
- **Commit:** `task 2: add env injection and Ollama provider helpers`
- **Complexity Score:** 5
- **Suggested Session:** S1

### Task 3: Agent orientation commands for architect/implementation split

- **Creates:** `commands/architect-orientation.md`
- **Modifies:** `commands/agent-orientation.md`
- **Depends on:** (none)
- **Requirements:**
  - Create `commands/architect-orientation.md` for the architect agent role:
    - Describe the architect's purpose: explore the codebase, produce a detailed implementation plan, get it reviewed
    - Define a 3-phase workflow: Explore → Plan → Plan Review
    - Include stage markers: `[STAGE: Exploring]`, `[STAGE: Planning]`, `[STAGE: Plan Review]`
    - Instruct the architect to write the plan to the artifacts path provided in the brief
    - Include subagent spawning instructions for explore and planReview subagents
    - Include plan execution discipline and quality standards references
  - Modify `commands/agent-orientation.md` to be implementation-specific:
    - Remove the Explore and Plan phases (phases 1-3) — the implementation agent receives a pre-written plan
    - Update the "Mandatory Workflow" to: Implement → Verify → Code Review & Commit
    - Add instruction to read the task plan from the path provided in the brief before starting implementation
    - Keep stage markers: `[STAGE: Implementing]`, `[STAGE: Verifying]`, `[STAGE: Code Review]`, `[STAGE: Committing]`
    - Keep subagent spawning instructions for codeReview subagent only
    - Keep plan execution discipline, quality standards, and rules sections
- **TDD Phase:** Exempt
- **Commit:** `task 3: split agent orientation into architect and implementation commands`
- **Complexity Score:** 2
- **Suggested Session:** S1

---

## Phase 2: Logic

### Task 4: Config parsing and validation module

- **Creates:** `src/config.ts`, `tests/config.test.ts`
- **Modifies:** `src/cli.ts`
- **Depends on:** Task 1, Task 2
- **Requirements:**
  - Create `src/config.ts` with pure, testable config logic extracted from `cli.ts`:
    - `parseProjectConfig(configPath: string): ProjectConfig` — reads and parses config.json
      - If file contains `"models"` key (old format): log deprecation warning, return defaults
      - If file contains `"agents"` key (new format): deep-merge with defaults
      - Merge priority: defaults ← config.json ← CLI overrides (CLI overrides happen in cli.ts, not here)
    - `validateConfig(config: ProjectConfig): void` — throws on invalid combinations:
      - Unknown provider names (not "claude" or "ollama")
      - `provider: "ollama"` on any agent without an `ollama` section in the config
      - Missing required subagents: architect needs `explore` + `planReview`, implementation needs `codeReview`, qa needs `qaFixer`
    - `applyOllamaFallback(config: ProjectConfig): void` — when Ollama is unreachable and fallback is true:
      - Rewrites all Ollama agent slots to Claude defaults
      - Rewrites their subagent models to Claude defaults
      - Logs a warning per affected agent role
    - `hasOllamaProvider(config: ProjectConfig): boolean` — checks if any agent uses provider "ollama"
  - Update `src/cli.ts`:
    - Replace inline config loading (lines 232-255) with `parseProjectConfig()` call
    - Add Ollama health check in `checkPrereqs()` (make it async):
      - If `hasOllamaProvider(config)`: call `validateOllamaBaseUrl()`, then `checkOllamaHealth()`
      - On health check failure: call `applyOllamaFallback()` if `fallback: true`, else `die()`
      - Update call site in `main()`: `await checkPrereqs(args)` (was synchronous)
    - Initialize `args.ollama` from parsed config
  - Create `tests/config.test.ts` with comprehensive coverage:
    - Happy path: valid new-format config.json
    - Old format deprecation warning
    - All validation error cases
    - Fallback logic (Ollama → Claude defaults)
    - Deep merge behavior (config.json overrides defaults selectively)
    - Edge cases: missing config.json, empty config.json, partial config
- **TDD Phase:** `RED → GREEN`
- **Commit:** `task 4: extract config parsing and validation into src/config.ts`
- **Complexity Score:** 4
- **Suggested Session:** S2

### Task 5: Split brief into architect and implementation briefs

- **Creates:** (none)
- **Modifies:** `src/brief.ts`, `tests/brief.test.ts`
- **Depends on:** Task 1, Task 2, Task 3
- **Requirements:**
  - Extract a shared `formatSubagentHints()` helper function to avoid tripling the Ollama-conditional logic:
    - Takes an array of `{ name: string; model: string }` entries plus `providerName` and `provider`
    - For each entry: calls `provider.subagentModelHint(model, providerName)`
    - If hint is non-empty: emits `- <Name> sub-agents: model: "<hint>"`
    - If hint is empty (Ollama): emits `- <Name> sub-agents: (inherits parent model — do not specify a model parameter)`
    - Used by `buildArchitectBrief()`, `buildImplementationBrief()`, and `buildQABrief()`
  - Rename existing `buildBrief()` to `buildImplementationBrief()` and refactor:
    - Remove exploration and planning phases (phases 1-3) from the workflow
    - Use `commands/agent-orientation.md` (which now only has implement/verify/review phases)
    - Add instruction to read the task plan from `<artifactsDir>/t<N>-task-plan.md`
    - Sub-agent models section via `formatSubagentHints()`: only codeReview hint
  - Create `buildArchitectBrief()`:
    - Use `commands/architect-orientation.md` for orientation
    - Include explore hints, design doc path, manifest path, memory snapshot
    - Sub-agent models section via `formatSubagentHints()`: explore + planReview hints
    - Include task context (title, creates, modifies, requirements)
    - Instruct to write plan to `<artifactsDir>/t<N>-task-plan.md`
    - Include plan-review workflow (existing `plan-review.md` command)
    - Do NOT include implementation, verification, code review, or commit phases
  - Update `buildQABrief()`:
    - Sub-agent models section via `formatSubagentHints()`: qaFixer hint
  - All three brief functions accept the new nested `ModelConfig` and `Provider`
    - Extract the parent agent's provider name to pass to `formatSubagentHints()`
  - Update `tests/brief.test.ts`:
    - Add stub for `architect-orientation.md` in STUB_COMMANDS
    - Add tests for `buildArchitectBrief()`: includes plan-review but not code-review, writes plan path, includes explore hints
    - Update existing `buildBrief()` tests to use `buildImplementationBrief()` name
    - Add tests for Ollama model hint omission (empty hint → descriptive text, not `model: ""`)
    - Add tests for `buildImplementationBrief()`: includes code-review but not plan-review, reads plan path
    - Test that architect brief includes correct artifacts dir path
    - Test that implementation brief includes correct plan read instruction
- **TDD Phase:** `RED → GREEN`
- **Commit:** `task 5: split brief into architect and implementation with Ollama hint handling`
- **Complexity Score:** 5
- **Suggested Session:** S2

### Task 6: Dashboard provider indicator

- **Creates:** (none)
- **Modifies:** `src/dashboard.ts`
- **Depends on:** Task 1
- **Requirements:**
  - In `renderStatus()`, for running tasks, add a provider tag after the task ID:
    - `[C]` for `task.provider === "claude"` (or undefined/missing — backward compat)
    - `[O]` for `task.provider === "ollama"`
  - Example: `T1 [C] Implementing  turns 5 | 2:30 | 45KB  reading file...`
  - Use `CYAN` color for `[C]`, `YELLOW` color for `[O]` to visually distinguish providers
  - Adjust truncation widths to account for the 4-char provider tag `[X] `
  - Also add provider tag to the failed task lines for post-mortem debugging
- **TDD Phase:** Exempt
- **Commit:** `task 6: add provider indicator to dashboard task lines`
- **Complexity Score:** 2
- **Suggested Session:** S2

### Task 7: Update brainstorm skill config template

- **Creates:** (none)
- **Modifies:** `skills/brainstorm.md`
- **Depends on:** (none)
- **Requirements:**
  - Replace the default `config.json` template (currently flat `"models"` format) with the new nested `"agents"` format
  - Use the default all-Claude config from the design doc
  - Ensure the template matches `defaultModelConfig()` output exactly
- **TDD Phase:** Exempt
- **Commit:** `task 7: update brainstorm skill default config to nested agents format`
- **Complexity Score:** 1
- **Suggested Session:** S2

---

## Phase 3: QA Gate

### Task 8: QA — Validate Phase 1-2 integration

- **Creates:** (none)
- **Modifies:** (none)
- **Depends on:** Task 2, Task 4, Task 5, Task 6, Task 7
- **Requirements:**
  - Verify `defaultModelConfig()` returns correct nested structure with architect/implementation/qa and their subagents
  - Verify `getProviderEnv("ollama")` returns correct env vars with baseUrl from OllamaConfig
  - Verify `getProviderEnv("claude")` returns undefined
  - Verify `subagentModelHint()` returns shorthand for Claude, empty string for Ollama
  - Verify `validateOllamaBaseUrl()` rejects non-http URLs and accepts valid ones
  - Verify `parseProjectConfig()` handles new format, old format deprecation, and defaults
  - Verify `validateConfig()` catches all invalid combinations
  - Verify `buildArchitectBrief()` includes plan-review, explore hints, plan write path; excludes implementation phases
  - Verify `buildImplementationBrief()` includes plan read path, code-review; excludes exploration/planning phases
  - Verify Ollama model hints produce descriptive text, not `model: ""`
  - Verify dashboard provider indicator renders `[C]`/`[O]` correctly
  - Run full test suite: `npx tsc --noEmit && npm run build && npm test`
  - Verify no dead code: old `AgentSlotConfig` type removed, no unused imports
- **Type:** QA
- **TDD Phase:** Exempt
- **Commit:** `qa: validate phase 1-2 integration for ollama compat`
- **Complexity Score:** 3
- **Suggested Session:** S3

---

## Phase 4: Orchestrator Integration

### Task 9: Two-phase spawnTask with architect→implementation flow

- **Creates:** (none)
- **Modifies:** `src/cli.ts`, `src/spawner.ts`
- **Depends on:** Task 4, Task 5, Task 8
- **Requirements:**
  - Refactor `spawnTask()` for two-phase execution:
    - Phase 1 (Architect): spawn architect agent with `buildArchitectBrief()`, architect model, and architect provider env
    - Architect `close` handler: check exit code, verify `<artifactsDir>/t<N>-task-plan.md` exists
    - On architect failure: set `task.status = "failed"`, set distinct error messages:
      - Non-zero exit: `[ARCHITECT EXIT <code>]`
      - Missing plan: `[ARCHITECT] No task plan produced`
    - Reset `task.stage = ""` between phases (handoff indicator)
    - Phase 2 (Implementation): spawn implementation agent with `buildImplementationBrief()`, implementation model, and implementation provider env
    - Reassign `task.process` from architect child to implementation child (stall detection + dashboard track current phase)
    - Implementation `close` handler: existing merge/cleanup logic (unchanged)
    - Wrap entire two-phase sequence in a single Promise for `activePromises`
  - Set `task.provider` to the current phase's provider name for dashboard rendering:
    - During architect phase: `task.provider = args.models.architect.provider`
    - During implementation phase: `task.provider = args.models.implementation.provider`
  - QA tasks: no architect phase — spawn directly with `buildQABrief()`, qa model, qa provider env
    - Set `task.provider = args.models.qa.provider`
  - Update `--model` flag handling: override `models.implementation.model` (new path through nested structure)
  - Pass `args.ollama` to `getProviderEnv()` calls
  - Pass env vars to `spawnAgent()` for Ollama support:
    - Add an `env?: Record<string, string>` parameter to `spawnAgent()` in `src/spawner.ts`
    - `spawnAgent()` passes env through to `provider.spawn()` via `SpawnOpts.env` (added in T1, wired in T2)
    - In `spawnTask()`, call `getProviderEnv(providerName, args.ollama)` and pass result to `spawnAgent()`
  - Handle architect/implementation log file separation:
    - Architect phase: `spawnAgent()` writes log to `t<N>.jsonl` as normal
    - Before spawning implementation phase: rename architect log to `t<N>-architect.jsonl`
    - Implementation phase: `spawnAgent()` writes fresh log to `t<N>.jsonl`
    - This preserves both logs for debugging without changing `spawnAgent()` internals (it always writes to `t<N>.jsonl` with `flags: "w"`)
  - Ensure SIGINT handler kills the correct child process (whichever phase is active)
- **TDD Phase:** Exempt
- **Commit:** `task 9: implement two-phase architect-then-implementation task spawning`
- **Complexity Score:** 5
- **Suggested Session:** S3

---

## Phase 5: Final QA

### Task 10: QA — Full integration validation

- **Creates:** (none)
- **Modifies:** (none)
- **Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9
- **Requirements:**
  - Run full build pipeline: `npx tsc --noEmit && npm run build && npm test`
  - Verify end-to-end config flow: default config → config.json load → CLI override → merged ModelConfig
  - Verify architect brief and implementation brief are correctly assembled with all sections
  - Verify two-phase spawn flow: architect spawns, writes plan to artifacts dir, implementation reads it
  - Verify Ollama env vars are injected only for Ollama provider slots, not Claude slots
  - Verify health check: mock unreachable Ollama, confirm fallback behavior
  - Verify health check: mock unreachable Ollama with fallback=false, confirm die()
  - Verify dashboard renders [C]/[O] indicators correctly
  - Verify old flat config.json triggers deprecation warning
  - Verify `architect-orientation.md` has explore/plan/plan-review phases only
  - Verify `agent-orientation.md` has implement/verify/code-review/commit phases only
  - Verify no dead code: no orphaned imports, no unused types, no commented-out blocks
  - Verify brainstorm skill template matches defaultModelConfig() output
  - Check for security: no shell injection in env var handling, baseUrl validation works
- **Type:** QA
- **TDD Phase:** Exempt
- **Commit:** `qa: full integration validation for ollama compat + architect agent`
- **Complexity Score:** 3
- **Suggested Session:** S3

---

## Task Dependency Graph

```
T1 (Types) ──────────┬──→ T2 (Provider) ──┬──→ T4 (Config) ──────┬──→ T8 (QA Gate) ──→ T9 (spawnTask+spawner) ──→ T10 (Final QA)
                      │                    │                      │         ↑                                            ↑
T3 (Commands) ────────┼────────────────────┼──→ T5 (Brief) ───────┤         │                                            │
                      │                    ↑                      │         │                                            │
                      ├──→ T6 (Dashboard) ─┼──────────────────────┘         │                                            │
                      │                    │                                │                                            │
T7 (Brainstorm) ──────┼────────────────────┼────────────────────────────────┘                                            │
                      │                    │                                                                             │
                      └────────────────────┴─────────────────────────────────────────────────────────────────────────────→↑
```

Note: T5 (Brief) depends on T1, T2, and T3. The arrow from T2→T5 reflects that T5 uses `subagentModelHint()` with the updated signature from T2.

## Execution Layers

| Layer | Tasks | Max Parallelism |
|-------|-------|-----------------|
| 0 | T1, T3, T7 | 3 |
| 1 | T2, T6 | 2 |
| 2 | T4, T5 | 2 |
| 3 | T8 (QA Gate) | 1 |
| 4 | T9 | 1 |
| 5 | T10 (Final QA) | 1 |

**Total: 10 tasks, 6 layers**

## TDD Tasks Summary

| Task | Phase | Key TDD Targets |
|------|-------|-----------------|
| T1 | RED → GREEN | `defaultModelConfig()` shape, type assertions |
| T2 | RED → GREEN | `getProviderEnv()`, `checkOllamaHealth()`, `validateOllamaBaseUrl()`, `subagentModelHint()` with provider |
| T4 | RED → GREEN | `parseProjectConfig()`, `validateConfig()`, `applyOllamaFallback()`, `hasOllamaProvider()` |
| T5 | RED → GREEN | `buildArchitectBrief()`, `buildImplementationBrief()`, Ollama hint handling |

## Security Checklist

- [ ] `getProviderEnv()` sets env vars per-spawn, not globally
- [ ] `ANTHROPIC_API_KEY` set to empty string for Ollama — no credential leak
- [ ] `validateOllamaBaseUrl()` rejects non-http/https protocols
- [ ] No shell injection: all subprocess calls use argument arrays (existing pattern preserved)
- [ ] Architect plan file written to artifacts dir (gitignored), not the worktree
- [ ] `baseUrl` validated before use in `fetch()` and env injection

## Session-Grouping Hints

| Session | Tasks | Focus | Est. Context |
|---------|-------|-------|--------------|
| S1 | T1, T2, T3 | Foundation: types, provider, commands | Light — isolated modules |
| S2 | T4, T5, T6, T7 | Logic: config parsing, brief split, dashboard, brainstorm | Medium — interconnected logic |
| S3 | T8, T9, T10 | Integration: QA gate, spawnTask orchestration, final QA | Heavy — cli.ts changes, end-to-end |
