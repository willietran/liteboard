# Plan Review

Spawn an independent review subagent to evaluate the implementation plan before any code is written.

## Procedure

1. Gather the following artifacts:
   - The implementation plan (step-by-step with verification commands)
   - The design doc or task description
   - The project manifest / relevant context files

2. Spawn a review subagent using the Agent tool with the model from the Sub-Agent Models section (Plan Review). Instruct the reviewer: review by reading only — do not create files, scaffold projects, or install packages. Send it all three artifacts. Ask the reviewer to evaluate across these dimensions:
   - **Alignment** — Does the plan address the full scope of the task and remain consistent with the design doc?
   - **Completeness** — Are there missing steps, unaddressed requirements, or gaps?
   - **Sequencing** — Are steps in the right order with correct dependencies?
   - **Edge cases & risks** — Which failure modes or scenarios are not accounted for?
   - **Over-engineering** — Is the plan introducing more complexity than the task needs?
   - **Integration risk** — Could this conflict with or break other parts of the system?
   - **Testability** — Are verification commands sufficient to catch regressions?

   **Proportionality**: Scale review depth to task complexity. Simple tasks (config changes, single-file edits, prompt tweaks) need scope/correctness/dependency checks — not exhaustive security audits.

3. Receive the review. For each piece of feedback:
   - If valid: update the plan accordingly.
   - If incorrect: push back with technical reasoning (see `commands/receiving-code-review.md`).

4. If changes were made, resubmit the updated plan to the reviewer.

5. **Max 3 rounds.** If unresolved **BLOCKING** issues remain after 3 rounds, the plan review **fails** — do not proceed to implementation. NIT-level items may be noted and carried forward.

## Output

The final approved plan, with a note of any unresolved review items carried forward.
