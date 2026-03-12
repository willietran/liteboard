# Architect Review Audit Trail

## Review Round 1

### Blocking Issues Accepted

1. **T1 missing `ProjectConfig` type** — Added to T1 requirements. T4 depends on this type.
2. **T1 missing `Provider` interface update** — Added `subagentModelHint(model, providerName)` signature change to T1 since it's the only task touching `types.ts`.
3. **T1 missing `tests/types.test.ts`** — Added to T1 Creates with specific test cases for `defaultModelConfig()`.
4. **T5 missing dependency on T2** — T5 uses updated `subagentModelHint()` signature. Added T2 to dependency list. Execution layers remain unchanged (T5 was already Layer 2, T2 is Layer 1).
5. **T5 missing DRY helper** — Added `formatSubagentHints()` helper requirement. All three brief builders now use it instead of duplicating Ollama-conditional logic.
6. **T9 log file overwrite bug** — Architect phase log gets renamed to `t<N>-architect.jsonl` before implementation spawn. Preserves both logs without changing `spawnAgent()` internals.
7. **T9 ambiguous env passing** — Made explicit: add `env?` param to `spawnAgent()`, passes through to `provider.spawn()` via `SpawnOpts.env`. T9 now also lists `src/spawner.ts` in Modifies.

### Nice-to-Haves Accepted

- T4: Added note to update `checkPrereqs()` call site in `main()` to `await`.

### Issues Rejected

- **Env var whitelisting in `getProviderEnv()`** — The function IS the whitelist. It returns exactly 3 hardcoded keys. No arbitrary env vars can be injected through it.
- **Flatten T9 nested callbacks** — Implementation detail. The agent can decide the best pattern.
- **`subagentModelHint()` instance vs standalone** — Keeping as instance method with extra param is simpler than refactoring the entire Provider interface method set.
