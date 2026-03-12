# Plan Review

Spawn an independent review subagent to evaluate the implementation plan before any code is written.

## Procedure

1. Gather the following artifacts:
   - The implementation plan (step-by-step with verification commands)
   - The design doc or task description
   - The project manifest / relevant context files

2. Spawn a review subagent using the Agent tool with the model from the Sub-Agent Models section (Plan Review). Send it all three artifacts along with the evaluation criteria from `commands/code-reviewer.md`. Ask the reviewer to assess:
   - Does the plan address the full scope of the task?
   - Are the steps in the right order with correct dependencies?
   - Are verification commands sufficient to catch regressions?
   - Are there security, performance, or DRY concerns in the proposed approach?
   - Is anything missing or underspecified?
   - Does the plan include test-first steps for TDD tasks? (write test → verify RED → implement → verify GREEN → refactor)
   - Performance concerns in proposed approach? (algorithm complexity, I/O patterns, N+1)
   - Clean, elegant design? (minimal abstractions, no over-engineering, idiomatic patterns)
   - Does the plan describe a clear, navigable code organization? (file structure, module boundaries, naming conventions)
   - Does the plan include an error handling strategy? (how failures surface, what information errors carry, debugging ease)

3. Receive the review. For each piece of feedback:
   - If valid: update the plan accordingly.
   - If incorrect: push back with technical reasoning (see `commands/receiving-code-review.md`).

4. If changes were made, resubmit the updated plan to the reviewer.

5. **Max 3 rounds.** If unresolved **BLOCKING** issues remain after 3 rounds, the plan review **fails** — do not proceed to implementation. NIT-level items may be noted and carried forward.

## Output

The final approved plan, with a note of any unresolved review items carried forward.
