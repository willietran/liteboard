import type { Task } from "./types.js";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";

const CURSOR_HOME = "\x1b[H";
const CLEAR_TO_EOL = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";

let forcePipeMode = false;

export function setForcePipeMode(value: boolean): void {
  forcePipeMode = value;
}

export function isTTY(): boolean {
  // --no-tui flag: guaranteed override for any environment
  if (forcePipeMode) return false;
  // LITEBOARD_NO_TUI=1: env-var override for programmatic invocations
  if (process.env.LITEBOARD_NO_TUI === "1") return false;
  // Claude Code's background task runner allocates a full PTY (both stdin
  // and stdout report isTTY=true), but reads the raw byte stream — not a
  // terminal screen buffer. Cursor-positioning escapes corrupt the output.
  if (process.env.CLAUDECODE === "1") return false;
  return !!process.stdout.isTTY && !!process.stdin.isTTY;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function formatSeconds(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "0:00";
  return formatSeconds(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function truncate(s: string, maxLen: number): string {
  if (maxLen <= 1) return s.length > 0 ? "\u2026" : "";
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}

function providerTag(task: Task): string {
  if (task.provider === "ollama") return `${YELLOW}[O]${RESET} `;
  return `${CYAN}[C]${RESET} `;
}

function clipSection(lines: string[], budget: number): string[] {
  if (lines.length <= budget) return lines;
  if (budget <= 0) return [];
  if (budget === 1) return [`  ${DIM}... ${lines.length} rows clipped${RESET}`];
  return [...lines.slice(0, budget - 1), `  ${DIM}... +${lines.length - budget + 1} more${RESET}`];
}

export function renderStatus(tasks: Task[], projectDir: string): void {
  const cols = process.stdout.columns || 80;
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const blocked = tasks.filter((t) => t.status === "blocked");

  // Header section (always shown)
  const headerLines: string[] = [];
  const barWidth = Math.max(1, Math.min(40, cols - 30));
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
  const failStr = failed > 0 ? ` ${RED}${failed} failed${RESET}` : "";
  headerLines.push(
    `${BOLD}Progress:${RESET} [${GREEN}${bar}${RESET}] ${done}/${total}${failStr}`,
  );
  headerLines.push("");

  // Running tasks section
  const runningLines: string[] = [];
  if (running.length > 0) {
    runningLines.push(`${BOLD}${CYAN}Running (${running.length}):${RESET}`);
    for (const t of running) {
      const elapsed = formatElapsed(t.startedAt);
      const kb = (t.bytesReceived / 1024).toFixed(0);
      const title = truncate(t.title, 35);
      const turnLabel = t.turnCount === 1 ? "turn" : "turns";
      const stageLabel = t.stage
        ? ` ${YELLOW}${t.stage}${RESET}`
        : (t.bytesReceived > 0 ? ` ${GRAY}Working...${RESET}` : "");
      const stageWidth = t.stage ? t.stage.length + 1 : (t.bytesReceived > 0 ? 11 : 0);
      const last = truncate(t.lastLine || "starting...", Math.max(1, cols - 59 - stageWidth));
      runningLines.push(
        `  ${CYAN}T${t.id}${RESET} ${providerTag(t)}${title}${stageLabel}  ${GRAY}${turnLabel} ${t.turnCount} | ${elapsed} | ${kb}KB${RESET}  ${DIM}${last}${RESET}`,
      );
    }
    runningLines.push("");
  }

  // Summary lines (queued/blocked/done)
  const summaryLines: string[] = [];
  if (queued.length > 0)
    summaryLines.push(
      `${YELLOW}Queued (${queued.length}):${RESET} ${DIM}${queued.map((t) => `T${t.id}`).join(", ")}${RESET}`,
    );
  if (blocked.length > 0)
    summaryLines.push(
      `${GRAY}Blocked (${blocked.length}):${RESET} ${DIM}${blocked.map((t) => `T${t.id}`).join(", ")}${RESET}`,
    );
  if (done > 0)
    summaryLines.push(
      `${GREEN}Done (${done}):${RESET} ${DIM}${tasks
        .filter((t) => t.status === "done")
        .map((t) => `T${t.id}`)
        .join(", ")}${RESET}`,
    );

  // Failed tasks section
  const failedLines: string[] = [];
  if (failed > 0) {
    failedLines.push(`${RED}Failed (${failed}):${RESET}`);
    for (const t of tasks.filter((t) => t.status === "failed")) {
      failedLines.push(
        `  ${RED}T${t.id}${RESET} ${providerTag(t)}${t.title}  ${DIM}${truncate(t.lastLine, Math.max(1, cols - 44))}${RESET}`,
      );
    }
  }

  // Footer section (always shown)
  const footerLines: string[] = [
    "",
    `${DIM}Logs: ${projectDir}/logs/t<N>.jsonl  (tail -f to watch)${RESET}`,
  ];

  if (isTTY()) {
    const maxRows = (process.stdout.rows || 24) - 1;
    let budget = maxRows - headerLines.length - footerLines.length;

    const clippedRunning = clipSection(runningLines, budget);
    budget -= clippedRunning.length;

    const clippedSummary = summaryLines.slice(0, budget);
    budget -= clippedSummary.length;

    const clippedFailed = clipSection(failedLines, budget);

    const clippedLines = [...headerLines, ...clippedRunning, ...clippedSummary, ...clippedFailed, ...footerLines];
    const output = CURSOR_HOME
      + clippedLines.map((l) => l + CLEAR_TO_EOL).join("\n")
      + "\n"
      + CLEAR_BELOW;
    process.stdout.write(output);
  } else {
    const allLines = [...headerLines, ...runningLines, ...summaryLines, ...failedLines, ...footerLines];
    for (const line of allLines) {
      console.log(line);
    }
  }
}
