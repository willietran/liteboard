# Quality Standards

Every task must satisfy these standards. Violations are blocking issues in code review.

## Code Elegance

- **Single responsibility**: Each function and module does one thing well.
- **Minimal complexity**: Use the simplest solution that works. Flag unnecessary abstraction.
- **Idiomatic patterns**: Follow established conventions for the language and framework.
- **No premature abstraction**: Three similar lines are better than a premature helper. Extract only when duplication is proven.

## DRY (Don't Repeat Yourself)

- **Zero duplication**: If logic exists in one place, it must not be duplicated elsewhere.
- **Single source of truth**: Types live in `src/types.ts`. Constants and shared config live in dedicated modules. Never define ad-hoc types inline when a shared type exists.
- **Extract shared logic**: When duplication is found, extract into `src/lib/` or colocated helpers immediately.

## Security

- **Argument arrays for subprocess calls**: Always use `execFileSync`/`spawn` with argument arrays — never string interpolation into shell commands.
- **Validate external input**: Task fields parsed from markdown are untrusted. Sanitize file paths, task IDs, and branch names before passing to git commands.
- **No secrets in output**: Never log, print, or embed credentials, tokens, or API keys.
- **Atomic file writes**: Use write-to-temp-then-rename for state files to prevent corruption on crash.

## Performance

- **O(n) or O(n log n) only**: Dependency resolution, conflict detection, and task scheduling must not be quadratic or worse.
- **No N+1 patterns**: Don't shell out per-task when a single command suffices.
- **Non-blocking I/O**: Stream parsing must not block the event loop. Use line-buffered processing.
- **Minimize redundant operations**: Batch git operations. Don't run redundant status checks.

## TDD Discipline

For tasks marked TDD (non-Exempt), follow the strict RED → GREEN → REFACTOR cycle:

1. **RED**: Write a failing test that describes the desired behavior.
2. **Verify RED**: Run the test suite. Confirm the new test fails with the expected reason. Do NOT proceed if it passes — the test is wrong.
3. **GREEN**: Write the minimum implementation to make the test pass.
4. **Verify GREEN**: Run the test suite. Confirm all tests pass — new and existing.
5. **REFACTOR**: Clean up implementation and tests. Improve naming, extract duplication, simplify.
6. **Verify REFACTOR**: Run the test suite again. Confirm nothing broke.

**Skipping RED verification or writing implementation before tests is a BLOCKING violation.**

## Verification Checklist

Before requesting code review, all three must pass:

```bash
npx tsc --noEmit    # Type check
npm run build       # Build
npm test            # Tests
```

Failure in any step is a blocking issue — do not proceed to code review until resolved.
