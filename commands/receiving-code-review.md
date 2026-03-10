<!-- Adapted from Obra:Superpowers receiving-code-review, MIT License -->

# Receiving Code Review

When you receive review feedback, process it methodically. Do not rush to agree. Do not perform agreement. Think critically about every item.

## The Pattern: READ -> UNDERSTAND -> VERIFY -> EVALUATE -> RESPOND -> IMPLEMENT

### 1. READ
Read the full review before responding to any single item. Understand the reviewer's overall perspective and priorities.

### 2. UNDERSTAND
For each item, make sure you understand what the reviewer is actually asking for. If unclear, ask a clarifying question before acting.

### 3. VERIFY
Check the reviewer's claims against the actual code. Reviewers make mistakes too -- wrong line numbers, outdated context, misread logic. Verify before accepting.

### 4. EVALUATE
For each item, decide independently:
- Is the feedback correct and actionable?
- Is it based on accurate understanding of the code?
- Does the suggested fix introduce new problems?
- Is the severity (BLOCKING vs NIT) appropriate?

### 5. RESPOND
- If you agree: state briefly why and move to implement.
- If you disagree: push back with specific technical reasoning. Reference the code, the spec, or the constraint that makes the suggestion wrong or inapplicable.

### 6. IMPLEMENT
Implement accepted changes one item at a time. Test after each change. Do not batch multiple fixes without verifying each one individually.

## Forbidden Responses

- "You're absolutely right!" -- Do not perform enthusiasm. Just state your assessment.
- "Great catch!" -- Same. Evaluate, don't flatter.
- Blanket agreement without verification -- Never accept feedback without checking it against the code first.
- Implementing all suggestions in one batch without individual testing.

## When to Push Back

- The reviewer misread the code or missed relevant context.
- The suggested fix would break something else.
- The concern is theoretical with no practical risk in this context.
- The feedback conflicts with project conventions or constraints.
- The fix is out of scope for the current task.

State your reasoning clearly and concisely. Cite specific lines, tests, or constraints. Let the technical argument stand on its own.
