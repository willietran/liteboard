# Liteboard v2: Agent-Driven Orchestration

## Context

Liteboard v1 is ~2400 lines of TypeScript that micromanages agent workflows: building detailed briefs, managing two-phase architect → implementation handoffs, parsing agent output streams for stage markers, running a separate triage LLM on failures, and serializing memory writes. Most of this internal complexity duplicates what Claude Code agents can do natively — explore, plan, review, and recover from errors — if given the right instructions.

**Goal:** Redesign liteboard's internals so agents do the heavy lifting while the orchestrator handles only what agents genuinely can't: dashboard rendering, multi-provider process spawning, feature branch safety, and progress/resume tracking. The user-facing experience stays the same (dashboard, "set and forget", multi-provider). The codebase shrinks from ~2400 lines to ~500-600.

**Additional goal:** Auto-generate the task manifest from a design doc if no manifest exists, eliminating the manual `/liteboard:task-manifest` step.

---

## Architecture

### Agent Roles

```
Orchestrator (TypeScript CLI, ~500-600 lines)
│
├── Manifest Agent  (if no manifest found)
│   ├── Reads design doc, generates task manifest
│   └── Spawns Plan Review sub-agent for quality gate
│
├── Session Agent  (one per session, sequential)
│   ├── Explores codebase (spawns Explore sub-agents)
│   ├── Writes session plan
│   ├── Spawns Plan Review sub-agent
│   ├── Implements task-by-task (TDD where specified)
│   ├── Spawns Code Review sub-agent
│   ├── Commits, writes memory entry
│   └── Exits 0 on success
│
└── QA Agent  (after all sessions merge)
    ├── Validates integrated feature branch end-to-end
    ├── Spawns Fixer sub-agent if issues found
    └── Reports results
```

**Key design decision:** Architect and implementation merge into a single Session Agent. The agent manages its own workflow phases (explore → plan → implement → review → commit) following CLAUDE.md rules. This eliminates the orchestrator's phase handoff complexity and avoids "lost in translation" between separate architect and implementation agents.

**Context window tradeoff:** A single session agent shares context across planning and implementation (~80-120K tokens for typical sessions). For Opus 200K+ context, this is fine. If a future session hits context pressure, the plan file acts as a checkpoint — a fresh agent could read it and continue implementation.

### What the Orchestrator Does (code)

| Responsibility | Why it must be code |
|---|---|
| **Dashboard rendering** | Agents can't render ANSI terminal UIs |
| **Process spawning with env injection** | Agent tool can't set `ANTHROPIC_BASE_URL` for multi-provider |
| **Progress tracking + resume** | Must survive crashes — file-based state |
| **Feature branch safety net** | If merge fails, reset branch to clean state deterministically |
| **Main loop** | Spawn sessions, watch exit codes, trigger merges, render dashboard |

### What Agents Do (instructions in CLAUDE.md + commands/)

| Responsibility | Why agents handle it |
|---|---|
| **Read and interpret manifest** | Agents read markdown natively |
| **Dependency resolution** | Agent reads `dependsOn`, executes in order |
| **Explore codebase** | Spawns Explore sub-agents via Agent tool |
| **Plan and plan review** | Agent writes plan, spawns review sub-agent |
| **Implementation + TDD** | This IS the agent's core job |
| **Code review** | Spawns independent Code Review sub-agent |
| **Build validation before merge** | Agent runs npm install, tsc, npm test before exiting — ensures session branch is clean |
| **In-session failure recovery** | Agent retries failing tests, adapts implementation — LLMs reason about failures natively |
| **Memory/knowledge sharing** | Agent writes memory entries to shared file |
| **Worktree creation/cleanup** | 3 git commands — agent can do this |

### Orchestrator Modules (~700-800 lines)

| Module | Lines | Purpose |
|---|---|---|
| `cli.ts` | ~150 | Arg parsing, main loop, spawn sessions, watch completion, retry on failure |
| `dashboard.ts` | ~300 | ANSI terminal rendering (keep existing, simplify) |
| `spawn.ts` | ~80 | Spawn `claude -p` with multi-provider env injection, lightweight stream parsing (stage, bytes, last line for dashboard), stall detection (startup + mid-task timeouts) |
| `merge-gate.ts` | ~50 | Mutex-serialized merge gate: when agent exits 0, orchestrator runs squash merge to feature branch (prevents concurrent merge corruption). Resets branch on failure. |
| `worktree.ts` | ~50 | Create/cleanup worktrees (orchestrator-managed for crash recovery on SIGINT) |
| `progress.ts` | ~50 | Write/read progress.md, resume detection |

**Removed modules:** `brief.ts`, `provider.ts`, `triage.ts`, `memory.ts`, `resolver.ts`, `build-validation.ts`, `config.ts` (absorbed into cli.ts or delegated to agents).

**Key spec review findings incorporated:**
- **Merge serialization stays in code** — agents commit to session branches, orchestrator gates the squash merge to feature branch with a mutex. Prevents concurrent corruption.
- **Stall detection stays in code** — agents can't detect their own stalls (frozen process). Orchestrator monitors bytes/second with startup (2min) and mid-task (5min) timeouts.
- **Stream parsing stays (lightweight)** — dashboard needs stage, turn count, bytes received. Without it, dashboard degrades to "running/done" — unacceptable UX regression.
- **Worktree lifecycle stays in code** — orchestrator must clean up on crash/SIGINT. Agents create branches; orchestrator creates/destroys worktree checkouts.
- **Post-exit retry in code** — when agent exits non-zero, orchestrator retries once with error context, then skips. Simple heuristic replaces 600-line triage system.

### Agent Instructions (commands/ + CLAUDE.md)

Engineering discipline moves from code-built briefs to agent-loaded instructions:

| File | Purpose |
|---|---|
| `commands/session-agent.md` | Full workflow: explore → plan → review → implement → code review → commit |
| `commands/manifest-agent.md` | Generate task manifest from design doc with plan review gate |
| `commands/merge-protocol.md` | Step-by-step merge instructions (squash merge, conflict resolution, build validation) |
| `commands/qa-agent.md` | End-to-end validation workflow (keep existing, adapt) |
| `commands/plan-review.md` | Plan review criteria (keep existing) |
| `commands/code-reviewer.md` | Code review criteria (keep existing) |
| `commands/quality-standards.md` | Engineering standards (keep existing) |

### Config

```json
{
  "agents": {
    "session":  { "provider": "claude", "model": "claude-opus-4-6" },
    "manifest": { "provider": "claude", "model": "claude-opus-4-6" },
    "qa":       { "provider": "claude", "model": "claude-sonnet-4-6" }
  },
  "subagents": {
    "explore":    { "model": "sonnet" },
    "planReview": { "model": "opus" },
    "codeReview": { "model": "sonnet" }
  },
  "concurrency": 1
}
```

### UX Flow

```
$ liteboard run switchpad/ --spec docs/shadow-sandbox-design.md

Step 0: No manifest found. Generating from spec...
  → Manifest Agent reads spec, generates 13 tasks
  → Plan Review sub-agent validates manifest
  → Manifest written to docs/plans/manifest.md ✓

┌─ Liteboard ─────────────────────────────────────────────────┐
│ ■■■■■■■■░░░░░░░░░░░░  4/13 tasks  31%                      │
│                                                             │
│ S1 ✓ Bootstrap monorepo                          [done 2m]  │
│ S2 ✓ Shared domain model                        [done 4m]  │
│ S3 ✓ Database + persistence                     [done 6m]  │
│ S4 ▶ SDK event contract          [Implementing]   3m 12s   │
│ S5 ○ Ingestion endpoints                       [queued]    │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘

...hours later...

All 13 tasks + QA complete. Branch feat/shadow-sandbox ready.
  13 commits | 47 files | 2,891 lines | all tests pass
```

### Input Flexibility

| What you provide | What liteboard does first |
|---|---|
| Design doc (spec) | Generate manifest → execute sessions → QA |
| Task manifest | Execute sessions → QA |

Brainstorming stays manual — you want to be involved in the "what."

---

## Migration Path

This is a rewrite, not a refactor. The approach:

1. Build v2 orchestrator alongside v1 (new entry point: `src/v2/cli.ts`)
2. Reuse existing `dashboard.ts` and `progress.ts` (adapt as needed)
3. Write new agent instruction files in `commands/`
4. Validate with a real project (switchpad build)
5. Once validated, remove v1 code

---

## Verification

1. `npx tsc --noEmit` — type-check passes
2. `npm test` — all tests pass for v2 modules
3. `npm run build` — clean build
4. End-to-end: run liteboard v2 on a test project with 3-5 tasks, verify:
   - Manifest auto-generated from spec if missing
   - Each session: plan → plan review → implement → code review → commit
   - Merge to feature branch with build validation
   - Dashboard renders progress correctly
   - Resume works after simulated crash (kill process, restart)
   - QA runs on merged feature branch
5. Full validation: run on switchpad (13 tasks) end-to-end
