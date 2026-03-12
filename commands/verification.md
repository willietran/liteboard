# Verification

Emit `[STAGE: Verifying]` at the start of this phase.

## The Iron Law

No completion claims without fresh verification evidence. If you haven't run the command in this phase, you cannot claim it passes.

## Verification Loop (max 3 attempts)

For each attempt:

1. Run each command separately and read full output:
   - `npx tsc --noEmit` — read stderr, check exit code
   - `npm run build` — read output, check exit code
   - `npm test` — read output, count pass/fail, check exit code

2. After ALL three pass: state the results with evidence
   (e.g., "tsc: exit 0, no errors. build: exit 0. tests: 47/47 pass.")

3. If ANY command fails:
   - Read the full error output
   - Diagnose the root cause
   - Fix the issue
   - Increment attempt counter and re-run ALL three commands

4. After 3 failed attempts: describe the blocker, commit what works,
   and exit with a clear failure description.

## Red Flags — STOP

- Using "should pass", "probably works", "seems fine"
- Expressing satisfaction before running commands
- Running commands without reading output
- Claiming success from a prior run (must be fresh in THIS phase)

## Evidence Pattern

✅ [run tsc] → "exit 0, 0 errors" → [run build] → "exit 0" → [run test] → "47/47 pass" → "All verification passes"
❌ "Tests should pass now" / "I fixed it so it works"
