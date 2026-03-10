import type { Task } from "./types.js";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

const CURSOR_HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[2K";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "0:00";
  const elapsed = Math.floor(
    (Date.now() - new Date(startedAt).getTime()) / 1000,
  );
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}

export function renderStatus(tasks: Task[], projectDir: string): void {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const blocked = tasks.filter((t) => t.status === "blocked");

  const lines: string[] = [];

  // Progress bar
  const barWidth = 30;
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
  const failStr = failed > 0 ? ` ${RED}${failed} failed${RESET}` : "";
  lines.push(
    `${BOLD}Progress:${RESET} [${GREEN}${bar}${RESET}] ${done}/${total}${failStr}`,
  );
  lines.push("");

  // Running tasks
  if (running.length > 0) {
    lines.push(`${BOLD}${CYAN}Running (${running.length}):${RESET}`);
    for (const t of running) {
      const elapsed = formatElapsed(t.startedAt);
      const kb = (t.bytesReceived / 1024).toFixed(1);
      const title = truncate(t.title, 30);
      const last = truncate(t.lastLine || "...", 50);
      lines.push(
        `  ${CYAN}T${t.id}${RESET} ${title} ${DIM}\u2502${RESET} turns: ${t.turnCount} \u2502 ${elapsed} \u2502 ${kb}KB \u2502 ${GRAY}${last}${RESET}`,
      );
    }
    lines.push("");
  }

  // Status lists
  if (queued.length > 0)
    lines.push(
      `${YELLOW}Queued (${queued.length}):${RESET} ${queued.map((t) => `T${t.id}`).join(", ")}`,
    );
  if (blocked.length > 0)
    lines.push(
      `${DIM}Blocked (${blocked.length}):${RESET} ${blocked.map((t) => `T${t.id}`).join(", ")}`,
    );
  if (done > 0)
    lines.push(
      `${GREEN}Done (${done}):${RESET} ${tasks
        .filter((t) => t.status === "done")
        .map((t) => `T${t.id}`)
        .join(", ")}`,
    );
  if (failed > 0)
    lines.push(
      `${RED}Failed (${failed}):${RESET} ${tasks
        .filter((t) => t.status === "failed")
        .map((t) => `T${t.id}`)
        .join(", ")}`,
    );

  if (running.length > 0) {
    lines.push("");
    lines.push(
      `${DIM}Logs: ${projectDir}/logs/t{${running.map((t) => t.id).join(",")}}.jsonl${RESET}`,
    );
  }

  let output = CURSOR_HOME;
  for (const line of lines) output += CLEAR_LINE + line + "\n";
  // Clear any leftover lines from previous renders
  for (let i = 0; i < 10; i++) output += CLEAR_LINE + "\n";
  process.stdout.write(output);
}
