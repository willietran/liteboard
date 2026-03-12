# Quality Standards

Every task must satisfy these standards. Violations are blocking issues in code review.

## Code Elegance

- **Single responsibility**: Each function and module does one thing well.
- **Minimal complexity**: Use the simplest solution that works. Flag unnecessary abstraction.
- **Idiomatic patterns**: Follow established conventions for the language and framework.
- **No premature abstraction**: Three similar lines are better than a premature helper. Extract only when duplication is proven.

## DRY (Don't Repeat Yourself)

- **Zero duplication**: If logic exists in one place, it must not be duplicated elsewhere.
- **Single source of truth**: Types, constants, and shared config live in dedicated modules. Never define ad-hoc types inline when a shared type exists.
- **Extract shared logic**: When duplication is found, extract into shared modules or colocated helpers immediately.

## Security

- **Never trust user input.** Validate ALL external input server-side at system boundaries (forms, API bodies, query params, URL params, uploads). Use schema validation (Zod, Joi, etc.). Client-side validation is UX, not security.
- **Prevent injection.** Use parameterized queries / ORMs for database access. Use argument arrays for subprocess calls. Never string-interpolate untrusted data into SQL, shell commands, templates, or HTML.
- **Enforce authorization, not just authentication.** Every endpoint and data query must verify the requesting user owns the resource. Use RLS or equivalent. Default-deny.
- **Protect secrets.** No API keys, tokens, or passwords in client bundles, logs, error messages, or committed code. Use environment variables. Ensure `.env` is gitignored.
- **Secure defaults.** Where applicable, set CORS, CSP, cookie flags, and rate limits explicitly. Don't expose stack traces in production. Protect abuse-prone endpoints with rate limiting.
- **Flag security issues explicitly.** When you encounter a potential security issue — even a minor one — flag it. Do not silently work around security problems.

## Performance

- **O(n) or O(n log n) only**: Algorithms must not be quadratic or worse as data grows. Watch for hidden O(n²) in nested loops.
- **No N+1 patterns**: Don't issue per-item queries or commands when a single batched operation suffices.
- **Non-blocking I/O**: Long-running or streaming operations must not block the event loop. Use async/line-buffered processing.
- **Minimize redundant operations**: Batch I/O, database queries, and external calls. Don't repeat work that can be cached or combined.

## TDD Discipline

For tasks marked TDD (non-Exempt), follow the strict RED → GREEN → REFACTOR cycle:

1. **RED**: Write a failing test that describes the desired behavior.
2. **Verify RED**: Run the test suite. Confirm the new test fails with the expected reason. Do NOT proceed if it passes — the test is wrong.
3. **GREEN**: Write the minimum implementation to make the test pass.
4. **Verify GREEN**: Run the test suite. Confirm all tests pass — new and existing.
5. **REFACTOR**: Clean up implementation and tests. Improve naming, extract duplication, simplify.
6. **Verify REFACTOR**: Run the test suite again. Confirm nothing broke.

**Skipping RED verification or writing implementation before tests is a BLOCKING violation.**

## Code Organization & Navigability

- **Single responsibility per file**: Each file has one clear purpose. If a file grows beyond a single responsibility, split it.
- **Colocate related code**: Related components, helpers, and tests live near each other. A new contributor should find functionality by intuition, not by grep.
- **Consistent module structure**: Each module exports from a clear entry point. File and directory naming conveys purpose.
- **Predictable naming**: Files, functions, and variables are named so their purpose is obvious without reading the implementation.
- **No junk drawers**: Avoid catch-all `utils/` or `helpers/` files. If a helper serves one module, colocate it. If it serves many, give it a descriptive name and dedicated file.

## Testing Thoroughness

TDD Discipline covers the *process* (RED → GREEN → REFACTOR). This section covers *scope* — what to test and how deeply.

- **Cover all paths**: Test happy path, edge cases, error conditions, and boundary values. Every `if` branch, every error handler, every new type needs coverage.
- **Every bug fix includes a regression test** that would have caught the bug. Fix the bug AND prove it stays fixed.
- **Test specific outcomes**: Don't just test that a function "doesn't throw" — test the specific return value, side effects, and state changes.
- **Test at boundaries**: What happens with 0 items? 1 item? Max items? Empty strings? Null/undefined? Concurrent access?

| Lazy testing (don't do this) | Thorough testing (do this) |
|------------------------------|---------------------------|
| One test for the happy path | Happy path + empty input + malformed input + boundary values |
| Test that a function "doesn't throw" | Test the specific return value, side effects, and state changes |
| Skip error paths ("they're obvious") | Test every `catch` block and every error message |
| Mock everything and test nothing | Mock external dependencies, test actual logic |
| "It works in the happy case, ship it" | "What happens with 0 items? 1 item? 50 items? Circular deps? Missing fields?" |

## Debugging Ease

- **Informative error messages**: Errors describe what went wrong AND what was expected. Include relevant context (IDs, file paths, values) so issues are reproducible from the error output alone.
- **Fail fast**: Functions should fail immediately with clear errors rather than propagating bad state silently through the system.
- **No swallowed errors**: Never catch without handling. Every `catch` block must log, re-throw, or return a meaningful error. Empty catch blocks are a BLOCKING violation.
- **Sufficient logging context**: Log enough detail to reproduce issues — but not so much that logs become noise. Structured logging with relevant identifiers over generic messages.

## Cleanup Culture

- **Leave the codebase cleaner than you found it.** If you touch a file and notice mess — stale comments, unused variables, poor organization — fix it. Don't punt cleanup to a future task.
- **Zero dead code**: No commented-out blocks, no unused functions, no orphaned imports, no stale TODOs. If code isn't actively called, delete it.
- **Remove failed attempts**: During debugging, when you fix a bug, remove every failed attempt before committing. The commit should contain only the working solution.
- **No debug artifacts**: Console.log statements, temporary test values, and debugging scaffolding must be removed before committing.

## Verification

All verification commands defined in your task's plan must pass before proceeding to code review. Run them, confirm they pass, and include the evidence. Never claim success without proof. Do not proceed to code review without passing verification.
