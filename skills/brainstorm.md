---
name: brainstorm
description: Start a new liteboard project — interactive design session that produces a design doc. Use when beginning any new feature or project.
---

<!-- Adapted from Obra:Superpowers brainstorming skill (MIT License) -->
<!-- https://github.com/obra/superpowers -->

# Liteboard Brainstorm

You are starting a new liteboard project. Your goal is to collaboratively design a solution with the user, producing a `design.md` document.

## HARD GATE

**Do NOT implement anything.** This skill produces a design document only. Implementation happens later via `/liteboard:task-manifest` and `/liteboard:run`.

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project benefits from a design phase. Even "simple" features have edge cases, integration points, and decisions that benefit from explicit exploration. If you're tempted to skip design, that's a signal you haven't thought deeply enough about the problem.

## Workflow

### 1. Understand Intent
- If the user provided a description with the command, acknowledge it and move to clarifying questions — do NOT ask them to repeat what they already said
- If no description was provided, ask: "What would you like to build?"
- Then ask clarifying questions **one at a time**
- Prefer **multiple choice** format when possible (A/B/C with trade-offs)
- Cover: scope, constraints, user experience, edge cases, security
- Don't ask questions you can answer by reading the codebase

### 2. Explore Context
- Only after understanding user intent, explore the **relevant** parts of the codebase
- Use the Agent tool with `subagent_type="Explore"` to investigate integration points for the described feature
- If this is a greenfield project with no existing code to integrate with, skip this step

### 3. Propose Approaches
- Present **2-3 approaches** with explicit trade-offs
- Include: complexity, maintenance burden, performance, security implications
- Recommend one approach with reasoning
- Wait for user approval before proceeding

### 4. Write Design Doc
- Present design in sections with **approval checkpoints**
- Don't dump the entire design at once — get incremental buy-in
- Include a **Quality & Testing Strategy** section covering:
  - Which modules contain testable logic (TDD candidates)
  - Performance considerations and algorithmic complexity
  - Security and trust boundaries
  - Shared abstractions that prevent duplication
- Auto-generate a slug from the topic (kebab-case, max 30 chars)

### 5. Create Project Structure
On first write, create:
```
docs/liteboard/<slug>/
├── design.md
├── config.json          (default model config)
└── logs/
    └── .gitignore       (contains: *)
```

Default `config.json`:
```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "fallback": true
  },
  "agents": {
    "architect": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "explore": { "model": "claude-sonnet-4-6" },
        "planReview": { "model": "claude-opus-4-6" }
      }
    },
    "implementation": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "codeReview": { "model": "claude-sonnet-4-6" }
      }
    },
    "qa": {
      "provider": "claude",
      "model": "claude-opus-4-6",
      "subagents": {
        "qaFixer": { "model": "claude-opus-4-6" }
      }
    }
  },
  "concurrency": 1
}
```

### 6. Spec Review Loop
After writing the design doc:
1. Dispatch a spec-document-reviewer subagent via the Agent tool
2. The reviewer evaluates: completeness, feasibility, security, edge cases, clarity
3. Process feedback critically (don't blindly agree)
4. Update the design doc with accepted changes
5. Repeat up to 5 iterations or until the reviewer approves

**Spec reviewer prompt template:**
> You are reviewing a design document for a software project. Evaluate it against these criteria:
> 1. **Completeness**: Are all features specified? Any gaps?
> 2. **Feasibility**: Can this be built as described? Any impossible requirements?
> 3. **Security**: Any OWASP top-10 risks? Data handling concerns?
> 4. **Edge cases**: What happens when things fail? Concurrency issues?
> 5. **Clarity**: Could an engineer implement this without asking questions?
> 6. **DRY-readiness**: Does the design avoid specifying logic in multiple places? Will implementation naturally avoid duplication?
> 7. **Performance**: Potential O(n²) patterns, N+1 issues, unnecessary I/O?
> 8. **TDD strategy**: Are testable components identified? Are boundaries between logic and side effects clear?
> 9. **Code elegance**: Does the design favor clean abstractions and minimal complexity? Simpler alternatives not considered?
> 10. **Code organization**: Does the design produce a navigable file structure? Are module boundaries clear? Will a new contributor find things by intuition?
> 11. **Debuggability**: Are error paths explicit? Will failures be diagnosable from logs/output? Are error messages informative?
>
> Be specific. Reference sections by name. Flag blocking issues vs nice-to-haves.

### 7. Terminal State
When the design is approved, tell the user:

> Design doc written to `docs/liteboard/<slug>/design.md`.
>
> Next step: Run `/liteboard:task-manifest` to generate the implementation manifest.

## Key Principles
- YAGNI ruthlessly — don't design for hypothetical future requirements
- Explore alternatives before committing
- One question at a time, multiple choice preferred
- Incremental validation — don't present a 500-line design without checkpoints
