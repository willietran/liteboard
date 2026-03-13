# Ollama Compatibility + Architect Agent

## Overview

Add Ollama as an alternative LLM backend for liteboard agents, and introduce the **architect** agent role that separates planning from implementation — enabling cross-provider workflows (e.g., Claude Opus plans, Ollama implements).

### How Ollama Works with Claude Code

Ollama exposes an Anthropic-compatible API. Claude Code connects to it via environment variables:

```
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=""
```

The agent runtime is still Claude Code — tool use, file editing, the Agent tool all work identically. Only the LLM backend changes. This means liteboard doesn't need a new `Provider` implementation; it configures `ClaudeCodeProvider` with different env vars per spawn.

### Breaking Change: Config Schema

This design replaces the flat `"models"` config key with a nested `"agents"` key. This is an intentional hard break — liteboard is pre-1.0 and existing `config.json` files are per-project (easy to update). No migration shim is provided. Old `config.json` files using the flat `"models"` key will be ignored with a warning, and defaults will apply.

### Key Constraint: Subagent Provider Inheritance

Subagents spawned via Claude Code's Agent tool inherit the parent process's environment. This means:

- **Directly spawned agents** (architect, implementation, qa) — liteboard controls their env vars at spawn time. Different providers per role is straightforward.
- **Subagents** (explore, planReview, codeReview, qaFixer) — inherit their parent's provider. Cannot mix providers at the subagent level.

Additionally, the Agent tool's `model` parameter only accepts `"opus"`, `"sonnet"`, `"haiku"`. Ollama model names don't work there — Ollama subagents inherit the parent's model unless a valid Ollama model name is passed (which the Agent tool doesn't support).

This is an acceptable limitation. The config structure makes this hierarchy explicit so users don't accidentally try impossible combinations.

---

## Config Schema

### Current (flat, misleading)

```typescript
interface ModelConfig {
  implementation: AgentSlotConfig;  // directly spawned
  qa:             AgentSlotConfig;  // directly spawned
  explore:        AgentSlotConfig;  // subagent of implementation
  planReview:     AgentSlotConfig;  // subagent of implementation
  codeReview:     AgentSlotConfig;  // subagent of implementation
  qaFixer:        AgentSlotConfig;  // subagent of qa
}
```

The flat structure hides that subagents inherit their parent's provider, leading users to believe all 6 slots are independently configurable.

### New (nested, hierarchy is explicit)

```typescript
interface OllamaConfig {
  baseUrl: string;    // default: "http://localhost:11434"
  fallback: boolean;  // default: false — if true, fall back to Claude when Ollama is unreachable
}

interface SubagentConfig {
  model: string;      // model name (no provider — inherited from parent)
}

interface AgentConfig {
  provider: string;   // "claude" or "ollama"
  model: string;
  subagents: Record<string, SubagentConfig>;
}

interface ModelConfig {
  architect:      AgentConfig;  // directly spawned — plans the task
  implementation: AgentConfig;  // directly spawned — executes the plan
  qa:             AgentConfig;  // directly spawned — validates the work
}

interface ProjectConfig {
  ollama?: OllamaConfig;
  agents: ModelConfig;
  concurrency: number;
  branch?: string;
}

// CLIArgs gains an ollama field; models changes to new nested type
interface CLIArgs {
  projectPath: string;
  concurrency: number;
  models: ModelConfig;       // nested type (was flat)
  ollama?: OllamaConfig;     // NEW: loaded from config.json
  branch: string;
  taskFilter: number[] | null;
  dryRun: boolean;
  verbose: boolean;
  noTui: boolean;
}
```

### config.json examples

**Default (all Claude):**

```json
{
  "agents": {
    "architect": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "explore": { "model": "claude-sonnet-4-6" },
        "planReview": { "model": "claude-opus-4-6" }
      }
    },
    "implementation": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "codeReview": { "model": "claude-sonnet-4-6" }
      }
    },
    "qa": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "qaFixer": { "model": "claude-opus-4-6" }
      }
    }
  },
  "concurrency": 1
}
```

**Hybrid (Opus plans, Ollama implements):**

```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "fallback": false
  },
  "agents": {
    "architect": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "explore": { "model": "claude-sonnet-4-6" },
        "planReview": { "model": "claude-opus-4-6" }
      }
    },
    "implementation": {
      "provider": "ollama",
      "model": "kimi-k2.5:cloud",
      "subagents": {
        "codeReview": { "model": "kimi-k2.5:cloud" }
      }
    },
    "qa": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "qaFixer": { "model": "claude-opus-4-6" }
      }
    }
  },
  "concurrency": 2
}
```

**All Ollama (cost-conscious):**

```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "fallback": true
  },
  "agents": {
    "architect": {
      "provider": "ollama",
      "model": "kimi-k2.5:cloud",
      "subagents": {
        "explore": { "model": "glm-4.7-flash" },
        "planReview": { "model": "kimi-k2.5:cloud" }
      }
    },
    "implementation": {
      "provider": "ollama",
      "model": "qwen3.5",
      "subagents": {
        "codeReview": { "model": "qwen3.5" }
      }
    },
    "qa": {
      "provider": "ollama",
      "model": "kimi-k2.5:cloud",
      "subagents": {
        "qaFixer": { "model": "kimi-k2.5:cloud" }
      }
    }
  },
  "concurrency": 1
}
```

---

## Architect Agent

### Two-Phase Task Execution

Currently, each task is a single agent spawn: explore → plan → implement → review → commit. The architect splits this into two sequential spawns in the same worktree:

```
Phase 1: Architect
  ├── Explores the codebase (via explore subagent)
  ├── Writes implementation plan to task-plan.md
  ├── Gets plan reviewed (via planReview subagent)
  └── Exits

Phase 2: Implementation
  ├── Reads task-plan.md
  ├── Implements the plan
  ├── Gets code reviewed (via codeReview subagent)
  ├── Commits
  └── Exits
```

### File-Based Handoff

The architect writes its plan to the artifacts directory (not the worktree, to avoid commit pollution):

```
<artifacts-dir>/t<N>-task-plan.md
```

The artifacts directory (`docs/liteboard/<slug>/artifacts/`) is accessible via absolute path from any worktree. The implementation agent's brief includes this absolute path and instructs it to read the plan. No IPC, no stdout parsing — the plan is just a file on disk.

This avoids the problem of `task-plan.md` being an untracked file in the worktree that would get included in commits.

### Orchestrator Changes (`cli.ts`)

The current `spawnTask()` uses an event-driven pattern: `spawnAgent()` returns a `ChildProcess`, and a `Promise` wraps the `close` event listener. The two-phase architect flow chains into this pattern by nesting the implementation spawn inside the architect's `close` handler:

```typescript
function spawnTask(task: Task): void {
  task.status = "running";
  task.startedAt = new Date().toISOString();

  const wp = createWorktree(slug, task.id, args.branch, args.verbose);
  task.worktreePath = wp;

  // Phase 1: Architect
  task.stage = "Exploring";
  const architectBrief = buildArchitectBrief(task, ...);
  const architectModel = args.models.architect.model;
  const architectEnv = getProviderEnv(args.models.architect.provider, args.ollama);
  const architectChild = spawnAgent(task, architectBrief, provider, architectModel, wp, ...);
  task.process = architectChild;

  const promise = new Promise<void>((resolve) => {
    architectChild.on("close", (architectCode) => {
      if (architectCode !== 0) {
        task.status = "failed";
        task.lastLine = `[ARCHITECT EXIT ${architectCode}]`;
        cleanup(task);
        resolve();
        return;
      }

      // Verify plan was written
      const planPath = path.join(artifactsDir(args.projectPath), `t${task.id}-task-plan.md`);
      if (!fs.existsSync(planPath)) {
        task.status = "failed";
        task.lastLine = "[ARCHITECT] No task plan produced";
        cleanup(task);
        resolve();
        return;
      }

      // Brief gap between phases — reset stage
      task.stage = "";

      // Phase 2: Implementation
      const implBrief = buildImplementationBrief(task, ...);
      const implModel = args.models.implementation.model;
      const implEnv = getProviderEnv(args.models.implementation.provider, args.ollama);
      const implChild = spawnAgent(task, implBrief, provider, implModel, wp, ...);
      task.process = implChild;  // Dashboard now tracks implementation process

      implChild.on("close", async (implCode) => {
        // ... existing merge/cleanup logic (unchanged)
        resolve();
      });
    });
  });

  activePromises.set(task.id, promise);
}
```

Key integration details:
- **`task.process`** is reassigned from architect to implementation child — dashboard and stall detection always track the current phase's process
- **`activePromises`** wraps the entire two-phase sequence in one Promise — the task isn't "done" until implementation completes
- **Concurrency tracking** is unchanged — one Promise per task, regardless of phases
- **Stage reset** to `""` between phases gives the dashboard a brief visual indicator of the handoff
- **Failure paths**: architect crash (non-zero exit), missing plan file, and implementation crash are all handled with distinct error messages

### New Brief Functions (`brief.ts`)

The current `buildBrief()` becomes `buildImplementationBrief()` and a new `buildArchitectBrief()` is added:

**`buildArchitectBrief()`** includes:
- Agent orientation (adapted for architect role)
- Sub-agent models section (explore + planReview hints)
- Task context (design doc, manifest, memory)
- Explore hints
- Instruction: "Write your implementation plan to `<artifacts-dir>/t<N>-task-plan.md`"
- Plan review workflow (existing `plan-review.md` command)

**`buildImplementationBrief()`** includes:
- Agent orientation (adapted for implementer role)
- Sub-agent models section (codeReview hint only)
- Instruction: "Read `<artifacts-dir>/t<N>-task-plan.md` and implement it exactly"
- Task details (creates, modifies, requirements)
- Code review workflow (existing `session-review.md` command)
- Commit rules

The architect brief does NOT include implementation phases. The implementation brief does NOT include exploration/planning phases. Clean separation.

### Task Stages

New stage flow with architect:

```
"Exploring" → "Planning" → "Plan Review" → "Implementing" → "Verifying" → "Code Review" → "Committing" → "Merging"
 ╰──────────── architect ──────────────╯   ╰──────────────── implementation ──────────────────────────────╯
```

No new `TaskStage` values needed — the existing stages already cover both phases. Between the architect exit and implementation spawn, `task.stage` is reset to `""` momentarily, giving the dashboard a visual indicator of the handoff.

### Dashboard Provider Indicator

The dashboard should show which provider is running each task. Add a short provider tag to the task status line:

```
T1 [C] Implementing   ████░░░░░░  45%    ← Claude
T2 [O] Code Review    ██████████  98%    ← Ollama
T3 [C] QA Testing     ██░░░░░░░░  15%    ← Claude
```

This aids debugging when tasks on different providers behave differently. The tag is derived from `args.models.<role>.provider` — `[C]` for claude, `[O]` for ollama.

---

## Provider Environment Injection

### `SpawnOpts` Change

Add an optional `env` field to `SpawnOpts`:

```typescript
interface SpawnOpts {
  prompt: string;
  model: string;
  cwd: string;
  verbose: boolean;
  env?: Record<string, string>;  // NEW: additional env vars to inject
}
```

### `ClaudeCodeProvider.spawn()` Change

```typescript
spawn(opts: SpawnOpts): ChildProcess {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Inject provider-specific env vars
  if (opts.env) {
    Object.assign(env, opts.env);
  }

  return spawn("claude", args, { cwd: opts.cwd, env, stdio: [...] });
}
```

### `getProviderEnv()` Helper

New function in `provider.ts`:

```typescript
function getProviderEnv(
  providerName: string,
  ollamaConfig?: OllamaConfig,
): Record<string, string> | undefined {
  if (providerName === "ollama") {
    const baseUrl = ollamaConfig?.baseUrl ?? "http://localhost:11434";
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
    };
  }
  return undefined; // Claude uses default env
}
```

### `baseUrl` Validation

On config load, validate `ollama.baseUrl`:
- Must be a valid URL (parse with `new URL()`)
- Protocol must be `http:` or `https:` (reject `file:`, `ftp:`, etc.)
- If validation fails: `die("Invalid ollama.baseUrl: must be an http:// or https:// URL")`

This prevents accidental misconfiguration. No localhost-only enforcement — remote Ollama servers (e.g., GPU box on LAN) are a valid use case.

---

## Ollama Health Check + Fallback

### Startup Validation

In `checkPrereqs()`, if any agent slot uses `provider: "ollama"`:

1. Verify the `claude` CLI is on PATH (existing check)
2. HTTP GET to `<baseUrl>/api/tags` — if unreachable:
   - If `ollama.fallback` is `true`: log a loud warning, rewrite all Ollama slots to use Claude defaults
   - If `ollama.fallback` is `false` (default): `die("Ollama is not reachable at <baseUrl>. Start Ollama or set fallback: true in config.json.")`

### Health Check Implementation

```typescript
async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),  // 5s timeout — don't block startup
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

### Fallback Behavior

When `fallback: true` and Ollama is unreachable:

```typescript
function applyOllamaFallback(config: ProjectConfig): void {
  const defaults = defaultModelConfig();
  for (const [role, agent] of Object.entries(config.agents)) {
    if (agent.provider === "ollama") {
      log(`\x1b[33mWarning: Ollama unreachable. Falling back to Claude for ${role}.\x1b[0m`);
      agent.provider = "claude";
      agent.model = defaults[role as keyof ModelConfig].model;
      for (const [subName, sub] of Object.entries(agent.subagents)) {
        sub.model = defaults[role as keyof ModelConfig].subagents?.[subName]?.model ?? "claude-sonnet-4-6";
      }
    }
  }
}
```

---

## `subagentModelHint()` Changes

The current `subagentModelHint()` translates full model IDs to Agent tool shorthand (`"opus"`, `"sonnet"`, `"haiku"`). For Ollama, subagents inherit the parent's environment, so the hint behavior changes:

**Claude agents**: Continue using shorthand (`"opus"`, `"sonnet"`, `"haiku"`).

**Ollama agents**: Subagents inherit the parent's model by default. The Agent tool doesn't accept Ollama model names. The brief should omit the `model:` parameter for subagent instructions, or note that subagents use the same model.

Implementation: `subagentModelHint()` becomes provider-aware:

```typescript
subagentModelHint(fullModel: string, providerName: string): string {
  if (providerName === "claude") {
    if (fullModel.includes("opus")) return "opus";
    if (fullModel.includes("haiku")) return "haiku";
    return "sonnet";
  }
  // Ollama: subagents inherit parent model, no shorthand available.
  return "";
}
```

In `buildBrief()`, when hint is empty, **omit the `model:` parameter entirely** for that subagent line. Instead of writing `model: ""`, write a descriptive note:

```
- Explore sub-agents: (inherits parent model — do not specify a model parameter)
```

This ensures the agent doesn't pass an invalid empty string to the Agent tool's `model` parameter. The subagent will inherit the parent's model automatically.

---

## Config Loading + Validation

### Priority Order

1. `defaultModelConfig()` — hardcoded Claude defaults (always applied first)
2. `config.json` `agents` section — overrides defaults per-slot
3. CLI `--model=<MODEL>` — overrides `implementation.model` only

### Validation Rules

On config load, reject with clear errors:

| Invalid combination | Error message |
|---|---|
| Old flat `"models"` key in config.json | "Warning: config.json uses deprecated flat 'models' key. Ignoring — using defaults. Update to the new 'agents' format." (warning, not error) |
| `provider: "ollama"` without `ollama` section | "Agent 'implementation' uses provider 'ollama' but no 'ollama' config section found." |
| Unknown provider name | "Unknown provider 'foo'. Supported: claude, ollama." |
| Missing required subagents | "Agent 'architect' is missing required subagent 'explore'." |

Note: validation for subagent provider mismatch is implicit — subagents don't have a `provider` field. This is enforced by the schema itself.

### Default Config Generation

`defaultModelConfig()` returns the new nested structure:

```typescript
function defaultModelConfig(): ModelConfig {
  return {
    architect: {
      provider: "claude",
      model: "claude-opus-4-6",
      subagents: {
        explore: { model: "claude-sonnet-4-6" },
        planReview: { model: "claude-opus-4-6" },
      },
    },
    implementation: {
      provider: "claude",
      model: "claude-opus-4-6",
      subagents: {
        codeReview: { model: "claude-sonnet-4-6" },
      },
    },
    qa: {
      provider: "claude",
      model: "claude-opus-4-6",
      subagents: {
        qaFixer: { model: "claude-opus-4-6" },
      },
    },
  };
}
```

---

## Changes by File

### `src/types.ts`
- Replace `AgentSlotConfig` and flat `ModelConfig` with `OllamaConfig`, `SubagentConfig`, `AgentConfig`, `ModelConfig`
- Update `CLIArgs` to add `ollama?: OllamaConfig` field
- Update `defaultModelConfig()` to return nested structure
- Add `env?: Record<string, string>` to `SpawnOpts`

### `src/provider.ts`
- Update `ClaudeCodeProvider.spawn()` to inject `opts.env` into process env
- Update `subagentModelHint()` signature to accept `providerName`
- Add `getProviderEnv(providerName, ollamaConfig?)` helper function
- Add `checkOllamaHealth(baseUrl)` function
- Add `validateOllamaBaseUrl(url)` validation function

### `src/cli.ts`
- Rewrite config.json loading for new nested `"agents"` schema (warn on old `"models"` key)
- Update `CLIArgs` initialization with new `ModelConfig` + `ollama` field
- Update `spawnTask()` for two-phase architect→implementation flow (nested close handlers)
- Add Ollama health check + fallback logic to `checkPrereqs()` (now async)
- Pass provider-specific env to spawn calls via `getProviderEnv()`
- Update `--model` flag to override `implementation.model` (same behavior, new path)

### `src/brief.ts`
- Split `buildBrief()` into `buildArchitectBrief()` and `buildImplementationBrief()`
- `buildArchitectBrief()`: explore + plan + plan review phases, writes to artifacts dir
- `buildImplementationBrief()`: reads plan from artifacts dir, implement + code review + commit
- Update sub-agent model hint injection: omit model line for Ollama agents (empty hint)
- Keep `buildQABrief()` largely unchanged (add qaFixer model hint logic)

### `src/dashboard.ts`
- Add provider indicator (`[C]`/`[O]`) to task status line rendering

### `commands/` (new/modified)
- `commands/architect-orientation.md` — new, architect-specific orientation
- `commands/agent-orientation.md` — modify to be implementation-specific (remove planning phases)

### `skills/brainstorm.md`
- Update default config.json template to use new nested schema

### `tests/`
- `tests/types.test.ts` — test `defaultModelConfig()` returns correct nested structure
- `tests/provider.test.ts` — test env injection, `subagentModelHint()` with provider param, `getProviderEnv()`, `checkOllamaHealth()`, `validateOllamaBaseUrl()`
- `tests/brief.test.ts` — test `buildArchitectBrief()`, `buildImplementationBrief()`, Ollama model hint omission
- `tests/cli.test.ts` — test config loading with new schema, old schema warning, validation errors, fallback logic

---

## Quality & Testing Strategy

### Testable Logic (TDD candidates)
- Config parsing and validation (new schema → `ModelConfig`)
- `getProviderEnv()` — deterministic mapping from provider name to env vars
- `subagentModelHint()` with provider parameter
- `defaultModelConfig()` structure
- `buildArchitectBrief()` and `buildImplementationBrief()` output
- Ollama health check (mock `fetch`)
- Fallback logic (Ollama unreachable → Claude defaults)

### Security Boundaries
- Env vars are set per-spawn, not globally — one agent's Ollama config doesn't leak to another
- `ANTHROPIC_API_KEY` is set to empty string for Ollama — no credential exposure risk
- `baseUrl` is validated on config load: must parse as valid URL, protocol must be `http:` or `https:`
- Remote Ollama servers are allowed (no localhost restriction) — users connecting to LAN GPU boxes is a valid use case
- All existing security measures (no shell injection, arg arrays, branch protection) remain unchanged

### Performance Considerations
- Two spawns per task (architect + implementation) adds latency — but planning quality improves implementation success rate, likely net positive
- Ollama health check is a single HTTP request at startup — negligible
- No new per-task overhead beyond the sequential spawn

### Algorithmic Complexity
- Config parsing: O(1) — fixed number of agent slots
- Env var injection: O(1) per spawn
- Health check: O(1) — single HTTP request
- No changes to dependency resolution, merge logic, or dashboard rendering

---

## Out of Scope

- **Domain-specific agents** (frontend/backend) — per-task model overrides are a separate feature
- **New provider runtimes** — no `OllamaProvider` class; it's all `ClaudeCodeProvider` with different env vars
- **Ollama model management** — liteboard doesn't pull/manage Ollama models; users do that via `ollama pull`
- **Authentication for cloud Ollama models** — Ollama handles API keys for cloud models internally
