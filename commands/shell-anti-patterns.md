# Shell Anti-Patterns

These patterns cause agent failures and wasted retries. Avoid them.

## Never use interactive CLI tools without suppression

Many scaffolding tools (`create-next-app`, `create-vite`, etc.) prompt for input by default.
Always pass non-interactive flags or pipe input:
- Use `--yes` with `npx` to skip "Ok to proceed?" prompts (e.g., `npx --yes create-next-app@latest my-app --use-npm`)
- Use `yes "" | <command>` as a last resort for tools with no non-interactive flag
- Set `CI=1` or `NONINTERACTIVE=1` to suppress interactive behavior

## Use `npm ci`, not `npm install`

`npm install` modifies the lockfile and is non-deterministic. `npm ci` installs exactly
what's in the lockfile. Always use `npm ci` for reproducible builds.

## Don't run commands that block on stdin

If a command hangs with no output, it's probably waiting for input. Kill it and find the
non-interactive equivalent. Common culprits:
- Test runners in watch mode (fix: `CI=1 npm test`)
- Package managers asking for confirmation
- Git operations that open an editor (fix: use `-m` flags)

## Run verification commands in order

Type-check → build → test. If type-check fails, don't run build. If build fails, don't run tests.
Read error output carefully before retrying — don't re-run the same failing command.
