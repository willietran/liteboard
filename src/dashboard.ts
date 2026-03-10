import type { Task } from "./types.js";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR_SCREEN = "\x1b[2J";

const CURSOR_HOME = "\x1b[H";
const CLEAR_TO_EOL = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";
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
  const cols = process.stdout.columns || 80;
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const blocked = tasks.filter((t) => t.status === "blocked");

  const lines: string[] = [];

  // Progress bar
  const barWidth = Math.min(40, cols - 30);
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
      const kb = (t.bytesReceived / 1024).toFixed(0);
      const title = truncate(t.title, 35);
      const last = truncate(t.lastLine || "...", cols - 55);
      lines.push(
        `  ${CYAN}T${t.id}${RESET} ${title} ${GRAY}turns:${t.turnCount} ${elapsed} ${kb}KB${RESET}  ${DIM}${last}${RESET}`,
      );
    }
    lines.push("");
  }

  // Status lists
  if (queued.length > 0)
    lines.push(
      `${YELLOW}Queued (${queued.length}):${RESET} ${DIM}${queued.map((t) => `T${t.id}`).join(", ")}${RESET}`,
    );
  if (blocked.length > 0)
    lines.push(
      `${GRAY}Blocked (${blocked.length}):${RESET} ${DIM}${blocked.map((t) => `T${t.id}`).join(", ")}${RESET}`,
    );
  if (done > 0)
    lines.push(
      `${GREEN}Done (${done}):${RESET} ${DIM}${tasks
        .filter((t) => t.status === "done")
        .map((t) => `T${t.id}`)
        .join(", ")}${RESET}`,
    );
  if (failed > 0) {
    lines.push(`${RED}Failed (${failed}):${RESET}`);
    for (const t of tasks.filter((t) => t.status === "failed")) {
      lines.push(
        `  ${RED}T${t.id}${RESET} ${t.title}  ${DIM}${truncate(t.lastLine, cols - 40)}${RESET}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `${DIM}Logs: ${projectDir}/logs/t<N>.jsonl  (tail -f to watch)${RESET}`,
  );

  // Render: content first, then clear-to-EOL — matches docs/run.ts pattern
  const output = CURSOR_HOME
    + lines.map((l) => l + CLEAR_TO_EOL).join("\n")
    + "\n"
    + CLEAR_BELOW;
  process.stdout.write(output);
}
