---
name: task-manifest
description: Generate a task manifest from a liteboard design doc. Produces a structured implementation plan with dependency graph, TDD phases, and complexity scores.
---

# Liteboard Task Manifest Generator

You are generating a task manifest from a design document. The manifest breaks the design into self-contained, parallelizable implementation tasks.

## Input

The design doc path is provided as an argument. If a slug is provided instead of a path, resolve it to `docs/liteboard/<slug>/design.md`.

Read the design doc first. Understand the full scope before generating tasks.

## Output

Write the manifest to `docs/liteboard/<slug>/manifest.md`.

## Task Record Format

Each task must include:

```markdown
### Task N: <Title>

- **Creates:** `file1.ts`, `file2.ts`
- **Modifies:** (none)
- **Depends on:** Task 1, Task 2
- **Requirements:**
  - First requirement
  - Second requirement
    - Sub-detail
  - Third requirement
- **Type:** QA (or omit for implementation tasks)
- **TDD Phase:** `RED`, `GREEN`, `REFACTOR` (or Exempt)
- **Commit:** `task N: description`
- **Complexity Score:** N
- **Suggested Session:** SN
```

## Rules

### Dependency Inference
- Honor explicit dependencies from the design doc
- Infer implicit dependencies from file/data-flow coupling (if Task B modifies a file Task A creates, B depends on A)
- Ensure topologically valid ordering (no circular deps)

### TDD Inference
- **Default: TDD** for any task creating or modifying files with testable logic
- **Exempt only when**: Pure UI with no logic, config files, documentation, CLI entry points that only wire tested modules
- **When in doubt, mark TDD** — easier to exempt later than retrofit tests
- Override based on design doc specifications

### Complexity Scoring
| Score | Meaning |
|-------|---------|
| 1 | Trivial — config files, type-only modules |
| 2 | Simple — straightforward implementation, few decisions |
| 3 | Moderate — multiple components, some edge cases |
| 4 | Complex — significant logic, error handling, integration |
| 5 | Very complex — concurrent operations, state machines, protocols |
| +1 | TDD overhead |

### Required Manifest Sections
1. Title + design doc reference
2. Tech stack table
3. Testing strategy
4. TDD discipline summary
5. Phase sections with task entries
6. Task dependency graph (ASCII art)
7. Execution layers (for parallel scheduling)
8. TDD tasks table
9. Security checklist
10. Session-grouping hints

### QA Task Rules

#### When to use QA gates (structural criterion)

- **Flat dependency graph** (all tasks are independent — no task depends on another implementation task's output): One final QA task that depends on all implementation tasks. No mid-pipeline gates needed.
- **Layered dependency graph** (tasks form distinct layers where later tasks consume outputs from earlier tasks): QA gates at layer boundaries, plus a final QA task. A layer boundary exists when you see a fan-out-then-fan-in pattern: a group of parallel tasks completes, and a subsequent group of tasks all depend on their outputs.

#### Gate rules (for multi-phase projects)

1. **Phase-boundary QA gates**: After each logical phase of related tasks, insert a QA task that depends on all tasks in that phase (and any prior QA gates). This validates that the phase's tasks work together correctly.

2. **Blocking gate pattern**: All tasks in the next phase must depend on the QA gate from the previous phase. This makes the QA task a true gate — nothing downstream proceeds until QA passes.

3. **Final integration QA**: The last task in the manifest is always a QA task that depends on all other tasks (including earlier QA gates) for full end-to-end validation. Transitive-redundant dependencies are acceptable here for readability — the final QA task should explicitly list all tasks so the graph is self-documenting.

4. **Gate naming convention**: QA gate tasks should be named clearly (e.g., "QA: Validate Phase 2 integration") so the dependency graph is readable.

5. **Don't force phases where none exist.** If the dependency graph is flat (all tasks are independent), don't artificially group them into phases just to insert QA gates. One final QA task is sufficient.

#### Examples

*These diagrams illustrate the dependency structure, not manifest syntax. In the actual manifest, tasks are listed individually with their `Depends on:` fields wiring the graph.*

**Flat graph (no mid-pipeline gates needed):**
```
T1, T2, T3 (parallel, independent)
    ↓
T4: Final QA (depends on T1, T2, T3)
```

**Layered graph (gates at layer boundaries):**
```
Phase 1: T1, T2, T3 (parallel)
    ↓
T4: QA gate (depends on T1, T2, T3)
    ↓
Phase 2: T5, T6 (depend on T4)
    ↓
T7: QA gate (depends on T4, T5, T6)
    ↓
Phase 3: T8, T9 (depend on T7)
    ↓
T10: Final QA (depends on all)
```

#### QA task format requirements
- QA tasks must have `**Type:** QA`, requirements describing what to validate, and dependencies on the tasks they validate
- QA tasks are TDD-Exempt (they validate, not implement)
- Complexity: typically 2-3 (validation is simpler than implementation)
- QA tasks should reference the requirements of their dependency tasks so the QA agent knows what to check
- QA task commit messages describe the squash merge (e.g., `qa: validate integration for tasks 1-5`). Inner fixer sub-agent commits use `fix(qa): <description>` — these get squashed

### Quality Contract
- All tasks inherit quality standards injected via the agent brief: code elegance, DRY, security, performance, TDD discipline, code organization, testing thoroughness, debugging ease, and cleanup culture
- TDD tasks must follow strict RED → GREEN → REFACTOR with verification at each step
- All tasks must pass `tsc --noEmit`, `npm run build`, `npm test` before merge
- Review gates (plan review + code review) are mandatory and blocking
- No need to repeat the contract per-task — it is injected automatically

## Architect Review Loop

After generating the manifest:
1. Dispatch a critic subagent via the Agent tool (max 3 rounds)
2. Critic evaluates: completeness, security, DRY, dependency correctness, explore coverage, performance (algorithmic complexity, I/O patterns), code elegance (clean abstractions, minimal complexity), TDD coverage (are the right tasks marked TDD?), code organization (file structure, module boundaries), and debuggability (error handling patterns, informative errors)
3. Process feedback critically — push back on wrong suggestions
4. Update manifest with accepted changes
5. Write audit trail to `docs/liteboard/<slug>/architect-review.md`

## Terminal State

Show the user a summary:
- Total task count
- Number of dependency layers
- High-complexity callouts (score >= 5)
- Any security concerns

Then prompt:
> Manifest written to `docs/liteboard/<slug>/manifest.md`.
>
> Next step: Run `/liteboard:run <slug>` to start the build.
