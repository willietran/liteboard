# Session Review (Post-Implementation Code Review)

Spawn an independent review subagent to evaluate the implementation diff before committing.

## Procedure

1. Gather the following artifacts:
   - The full diff of all changes (`git diff` output)
   - The approved implementation plan
   - Any relevant context (design doc, task description)

2. Spawn a review subagent using the Agent tool with the model from the Sub-Agent Models section (Code Review). Instruct the reviewer: review by reading the diff and existing files only — do not scaffold projects or install packages. Send it the diff, the plan, and the evaluation criteria from `commands/code-reviewer.md`. Ask the reviewer to assess:
   - Does the implementation match the approved plan?
   - Are all evaluation criteria from `commands/code-reviewer.md` satisfied?
   - Are there deviations from the plan, and if so, are they justified?
   - Do all verification commands from the plan pass?

3. Receive the review. For each piece of feedback:
   - If valid: implement the fix.
   - If incorrect: push back with technical reasoning (see `commands/receiving-code-review.md`).

4. If changes were made, regenerate the diff and resubmit to the reviewer.

5. **Max 3 rounds.** If the review has not converged after 3 rounds, note the unresolved items and proceed with the commit, documenting outstanding concerns in your memory entry (see the Rules section for the output path).

## Output

A clean diff ready to commit, with a note of any unresolved review items.
