import { execFileSync } from "node:child_process";

/**
 * Executes a git command with argument arrays (no shell injection).
 * Uses merger's superior approach: captures stderr for error messages,
 * logs to stderr (stdout is reserved for the dashboard TUI).
 */
export function git(
  args: string[],
  opts?: { cwd?: string; verbose?: boolean },
): string {
  if (opts?.verbose) {
    console.error(
      `\x1b[90m$ git ${args.join(" ")}${opts?.cwd ? ` (cwd: ${opts.cwd})` : ""}\x1b[0m`,
    );
  }
  try {
    return execFileSync("git", args, {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (e: unknown) {
    const stderr = (e as { stderr?: { toString?: () => string } }).stderr?.toString?.() || "";
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || (e as Error).message}`);
  }
}
