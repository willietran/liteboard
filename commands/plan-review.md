# Plan Review

Spawn an independent review subagent to evaluate the implementation plan before any code is written.

## Procedure

1. Gather the following artifacts:
   - The implementation plan (step-by-step with verification commands)
   - The design doc or task description
   - The project manifest / relevant context files

2. Spawn a review subagent using the Agent tool with the model from the Sub-Agent Models section (Plan Review). Instruct the reviewer: review by reading only — do not create files, scaffold projects, or install packages. Send it all three artifacts along with the evaluation criteria from `commands/code-reviewer.md`. Ask the reviewer to assess:
   - Does the plan address the full scope of the task?
   - Are the steps in the right order with correct dependencies?
   - Are verification commands sufficient to catch regressions?
   - Are there security, performance, or DRY concerns in the proposed approach?
   - Is anything missing or underspecified?
   - For TDD tasks: does the plan include test-first steps? (RED → GREEN → REFACTOR)

   **Proportionality**: Scale review depth to task complexity. Simple tasks (config changes, single-file edits, prompt tweaks) need scope/correctness/dependency checks — not exhaustive OWASP audits or architecture reviews. Reserve deep security, performance, and design scrutiny for tasks that introduce new modules, APIs, or data flows.

3. Receive the review. For each piece of feedback:
   - If valid: update the plan accordingly.
   - If incorrect: push back with technical reasoning (see `commands/receiving-code-review.md`).

4. If changes were made, resubmit the updated plan to the reviewer.

5. **Max 3 rounds.** If unresolved **BLOCKING** issues remain after 3 rounds, the plan review **fails** — do not proceed to implementation. NIT-level items may be noted and carried forward.

## Output

The final approved plan, with a note of any unresolved review items carried forward.
