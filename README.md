# Liteboard

AI-driven development orchestrator — from brainstorm to built feature branch.

Liteboard manages parallel Claude Code agents in git worktrees, handling dependencies, merging results, and rendering a live terminal dashboard. Ship features without driving the build.

## Installation

```bash
npm i -g liteboard
liteboard setup
```

## Workflow

### 1. Design

```
/liteboard:brainstorm
```

Interactive design session. Explores your codebase, asks clarifying questions, proposes approaches with trade-offs. Produces `design.md`.

### 2. Plan

```
/liteboard:task-manifest
```

Generates a task manifest from the design doc — self-contained tasks with dependency graphs, TDD phases, and complexity scores. Produces `manifest.md`.

### 3. Build

```
/liteboard:run <project>
```

Launches the orchestrator. Spawns parallel agents in isolated git worktrees, each following a mandatory workflow: Explore → Plan → Plan Review → Implement → Code Review → Commit.

Claude enters supervisor mode — monitoring progress, retrying failures, and reporting status until all tasks complete. The feature branch is ready for PR when done.

## How It Works

- **Parallel agents** work in isolated git worktrees with dependency-aware scheduling
- **Squash merges** bring each task's work onto the feature branch with build validation
- **Shared memory** gives later tasks context from what's already been built
- **Review gates** ensure every plan and implementation gets independent code review
- **Stall detection** catches hung agents and API throttling
- **Resume support** picks up where you left off if interrupted

## Project Structure

```
docs/liteboard/<project>/
├── design.md          # Written during brainstorm
├── manifest.md        # Generated task manifest
├── config.json        # Model config, concurrency settings
├── progress.md        # Live status (updated by orchestrator)
├── memory.md          # Shared context across tasks
└── logs/              # Per-task JSONL logs (gitignored)
```

## CLI Usage

```bash
liteboard run <project-path-or-slug> [options]

Options:
  --concurrency=<N>    Max parallel agents, 1-5 (default: 1)
  --model=<model>      Override implementation model
  --branch=<name>      Feature branch name
  --tasks=<1,2,3>      Run specific task IDs only
  --dry-run            Parse and show dependency graph only
  --verbose            Log all git commands to stderr
```

## Attribution

- Brainstorming and code review patterns adapted from [Obra:Superpowers](https://github.com/obra/superpowers) (MIT License)

## License

MIT
