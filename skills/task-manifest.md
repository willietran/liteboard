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
- Backend modules, services, data pipelines: default to TDD (`RED → GREEN → REFACTOR`)
- UI components, CLI entry points, markdown files: default to Exempt
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

## Architect Review Loop

After generating the manifest:
1. Dispatch a critic subagent via the Agent tool (max 3 rounds)
2. Critic evaluates: completeness, security, DRY, dependency correctness, explore coverage
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
