# Final Integration Gate

## Problem

Liteboard validates each task in isolation (plan review, code review, tsc, build, test at merge time), but never validates the integrated result after all tasks merge. Users consistently report that the final feature branch doesn't work — integration bugs, missing wiring, type mismatches across task boundaries, features that exist superficially but don't function. The typical experience is spending hours post-build fixing issues manually.

**Root cause:** Per-task validation proves each piece works alone, but not together. Cross-task interactions, conflicting assumptions about shared interfaces, and incomplete implementations slip through because no one ever starts the app and checks.

## Solution

A post-build validation pipeline that catches integration issues and auto-fixes them before declaring the build done. Four phases, from cheap/fast to expensive/thorough:

```
All tasks merged to feature branch
    │
    ▼
┌─────────────────────────────────┐
│  Phase 1: Clean Build           │
│  npm ci → tsc → build → test   │
│  (catches cross-task type/      │
│   import errors)                │
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Phase 2: Smoke Test            │
│  Auto-detect project type →     │
│  start app → verify response    │
│  (catches "app doesn't start")  │
└──────────────┬──────────────────┘
               │ pass + web app + playwright available
               ▼
┌─────────────────────────────────┐
│  Phase 3: Playwright QA         │
│  Spawn QA agent → signup/login  │
│  → test each feature from       │
│  manifest → report pass/fail    │
│  (catches "features don't work")│
└──────────────┬──────────────────┘
               │ any failure from phases 1-3
               ▼
┌─────────────────────────────────┐
│  Phase 4: Fixer Agent           │
│  Systematic debugging protocol: │
│  root cause → pattern analysis  │
│  → hypothesis → targeted fix    │
│  One commit per fix round       │
│  Patience-based stopping        │
│  Re-runs failed phases after    │
│  each fix                       │
└──────────────┬──────────────────┘
               │
               ▼
         Report + Exit
```

## Phase 1: Clean Build Validation

Run the full build pipeline from a clean state on the complete feature branch:

1. `npm ci` (clean install, not incremental `npm install`)
2. `npx tsc --noEmit` (type check)
3. `npm run build` (full build)
4. `npm test` (test suite, if configured)

**Why this catches bugs the per-task validation misses:** Per-task merges validate incrementally — each merge builds on partial state. The clean build validates the complete integrated code from scratch. Type errors that emerge from cross-task interface mismatches, missing imports, and conflicting type definitions surface here.

**Implementation:** Extract the existing validation pipeline from `merger.ts` (lines 128-192) into a shared `src/build-validation.ts` module. The merger calls it with throw-on-failure semantics. The integration gate calls it with structured-result semantics. Zero duplication.

The shared function returns:
```typescript
interface BuildValidationResult {
  success: boolean;
  failedPhase: "install" | "typecheck" | "build" | "test" | "none";
  error?: string;
  stderr?: string;
  tscErrorCount: number;
  testFailCount: number;
  testPassCount: number;
}
```

**tsc error counting:** Parse stderr lines matching `error TS\d+` pattern.

**Test result counting:** Use `vitest run --reporter=json` for structured output with `numFailedTests`/`numPassedTests`.

## Phase 2: Smoke Test (Project-Type-Aware)

Auto-detect the project type and verify the app actually starts:

### Detection Logic

| Signal | Project Type |
|--------|-------------|
| `next.config.*` exists | Next.js |
| `vite.config.*` exists | Vite |
| `package.json` has `express`/`fastify`/`hono` dep | API server |
| `package.json` has `bin` field | CLI tool |
| `package.json` has `main`/`exports` (no framework) | Library |
| None of the above | Generic (skip smoke test) |

Detection is hierarchical — most specific match wins.

### Smoke Tests Per Type

| Type | Start Command | Verification |
|------|--------------|-------------|
| Next.js | `next start -p <port>` | HTTP GET `/` → 200 |
| Vite | `vite preview --port <port>` | HTTP GET `/` → 200 |
| API server | `npm start` or `node dist/index.js` | HTTP GET `/` or `/health` → response |
| CLI | Run bin with `--help` | Exit code 0, non-empty output |
| Library | N/A | Verify entry point files exist, dynamic `import()` |

### Port Strategy

Use a deterministic port derived from the feature branch name: `10000 + (hash(branchName) % 50000)`. Avoids collision with other liteboard runs. If port in use, try port+1 up to 5 attempts.

### Timeout & Cleanup

- Poll port readiness with `net.createConnection` at 500ms intervals, max 60 seconds
- If app process exits before port ready → immediate failure
- Always kill app process in `finally` block (SIGTERM → 5s grace → SIGKILL)
- Register app process in a cleanup set for SIGINT handler

## Phase 3: Playwright QA (Web Apps Only)

Only runs if:
1. Project type is a web app (Next.js, Vite, or API server with frontend)
2. Playwright MCP is available (detected from `~/.claude.json` or `~/.claude/settings.json`)

### How It Works

1. The smoke test leaves the app running (Phase 2 keeps the server up for Phase 3)
2. Spawn a QA agent via `provider.spawn()` with the `qa-agent.md` brief
3. The brief includes:
   - The app URL (`http://localhost:<port>`)
   - All task titles and requirements from the manifest
   - Instructions for auth handling (find signup/login, create test account)
4. The QA agent uses Playwright MCP tools to:
   - Navigate to the app
   - Handle signup/login flows
   - Test each feature listed in the manifest
   - Output structured markers: `[QA:PASS] <feature>` or `[QA:FAIL] <feature>: <error>`
5. Parse the agent's output into a structured report:
   ```typescript
   interface QAReport {
     features: Array<{ name: string; passed: boolean; error?: string }>;
     totalPassed: number;
     totalFailed: number;
   }
   ```

### Playwright MCP Detection

```typescript
function isPlaywrightMCPAvailable(): boolean {
  // Check Claude config files for playwright MCP server registration
  const configPaths = [
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const p of configPaths) {
    if (!existsSync(p)) continue;
    const config = JSON.parse(readFileSync(p, 'utf-8'));
    if (config.mcpServers?.playwright) return true;
  }
  return false;
}
```

## Phase 4: Fixer Agent

When any validation phase fails, the fixer agent activates. It follows the systematic-debugging methodology — root cause investigation before any code changes.

### Fixer Brief Contents

The `commands/fixer-agent.md` brief embeds the systematic-debugging protocol:
1. **Root Cause Investigation** — Read all errors, trace data flow across task boundaries, identify which task(s) produced conflicting code
2. **Pattern Analysis** — Find working parts, compare with broken integration points
3. **Hypothesis** — Form a specific hypothesis ("Task 3's export doesn't match Task 5's import because...")
4. **Targeted Fix** — Fix at the root cause, not the symptom. One change at a time.

The brief also includes:
- All error output from the failed validation phases
- The full task manifest (what was supposed to be built)
- The complete `git diff main...HEAD`
- Previous fix round errors (if this is a retry)

### Patience-Based Stopping

Instead of a hard attempt limit, the fixer uses a "patience" counter:

- **Start:** patience = 3
- **After each fix round:** re-run failed validation phases, compare metrics
- **Progress made** (fewer failures): patience stays at current value
- **No progress** (same or more failures): patience decrements by 1
- **Patience = 0:** stop, report remaining issues to user
- **All validation passes:** stop, success

This allows unlimited productive rounds but caps unproductive ones at 3.

### Convergence Detection

```typescript
interface ValidationMetrics {
  tscErrorCount: number;
  testFailCount: number;
  buildPasses: boolean;
  smokeTestPasses: boolean;
  qaFailures: number;
}

function isProgress(current: ValidationMetrics, previous: ValidationMetrics): boolean {
  const currentScore = current.tscErrorCount + current.testFailCount + current.qaFailures
    + (current.buildPasses ? 0 : 10) + (current.smokeTestPasses ? 0 : 10);
  const previousScore = previous.tscErrorCount + previous.testFailCount + previous.qaFailures
    + (previous.buildPasses ? 0 : 10) + (previous.smokeTestPasses ? 0 : 10);
  return currentScore < previousScore;
}
```

### Commit Strategy

One commit per fix round with message format: `fix(integration): <description>`. Distinct from task commit messages to avoid confusing `detectCompletedFromGitLog`.

### Rollback on Regression

If a fix round makes things worse (more failures than before), `git revert HEAD --no-edit` before the next round.

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/build-validation.ts` | Shared build validation pipeline (extracted from merger.ts) |
| `src/validator.ts` | Project type detection, smoke tests, integration gate orchestrator |
| `src/qa.ts` | Playwright QA agent spawning + report parsing |
| `src/fixer.ts` | Fixer agent with systematic-debugging + patience counter |
| `commands/qa-agent.md` | Brief for QA agent (Playwright testing, auth handling) |
| `commands/fixer-agent.md` | Brief for fixer agent (systematic-debugging embedded) |
| `tests/build-validation.test.ts` | Tests for shared validation pipeline |
| `tests/validator.test.ts` | Tests for project detection + smoke tests |
| `tests/qa.test.ts` | Tests for QA agent + MCP detection |
| `tests/fixer.test.ts` | Tests for fixer patience/convergence logic |

### Modified Files

| File | Change |
|------|--------|
| `src/merger.ts` | Use shared `runBuildValidation()` instead of inline pipeline |
| `src/cli.ts` | Add integration gate after main loop, new CLI flags, SIGINT cleanup |
| `src/types.ts` | Add ProjectType, BuildValidationResult, ValidationMetrics, QAReport, CLIArgs extensions |
| `src/brief.ts` | Add `buildFixerBrief()` and `buildQABrief()` functions |

### CLI Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--skip-validation` | false | Skip entire integration gate |
| `--skip-smoke` | false | Skip Phase 2 only |
| `--skip-qa` | false | Skip Phase 3 only |
| `--no-fixer` | false | Report failures without auto-fix |
| `--fixer-patience=N` | 3 | Override patience counter start |

### Integration Point in cli.ts

After the main loop exits (line 415) and promises settle (line 421), before dashboard cleanup (line 424):

```typescript
if (done === filteredTasks.length && !args.skipValidation) {
  const gateResult = await runIntegrationGate(process.cwd(), filteredTasks, {
    branch: args.branch, provider, model: args.model,
    skipSmoke: args.skipSmoke, skipQA: args.skipQA,
    noFixer: args.noFixer, fixerPatience: args.fixerPatience,
    verbose: args.verbose, projectDir: args.projectPath,
  });
  if (!gateResult.finalSuccess) process.exit(2); // distinct from task failure (exit 1)
}
```

### SIGINT Handling

Maintain a module-level `Set<ChildProcess>` for integration gate processes (app server, QA agent, fixer agent). The existing SIGINT handler iterates this set and kills each process on interrupt.

## Edge Cases

1. **Partial task failure:** Integration gate only runs if ALL tasks succeeded. If some failed, skip (the build is already known-broken).
2. **Non-npm projects:** Phase 1 skips (no package.json). Phase 2 skips (no smoke test for generic). Only the fixer could still help if there are obvious issues.
3. **No Playwright:** Phase 3 skips with a log message. Phases 1+2 still run.
4. **Port conflict:** Try deterministic port, then port+1 through port+4. If all fail, skip smoke test with error.
5. **Fixer makes things worse:** Revert the fixer's commit, decrement patience.
6. **Resume after interrupt:** If interrupted during integration gate, all tasks show "done" on resume. The gate re-runs from scratch (no intermediate state persisted — simpler and safer).

## Testing Strategy

All tests mock `node:child_process` and `node:fs` — no real git repos or processes. Follow existing patterns from `tests/merger.test.ts`.

- **build-validation.test.ts:** Happy path, each failure type, no package.json, no test script, timeout
- **validator.test.ts:** Each project type detection path, smoke test timeout, HTTP failure, process cleanup
- **fixer.test.ts:** Patience decrements, stays on progress, stops at 0, handles agent crash, rollback on regression
- **qa.test.ts:** MCP detection, QA brief assembly, report parsing from agent output markers
