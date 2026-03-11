import type { Task, GateStatus, GatePhaseStatus } from "./types.js";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR_SCREEN = "\x1b[2J";

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
  const barWidth = Math.max(1, Math.min(40, cols - 30));
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
      const turnLabel = t.turnCount === 1 ? "turn" : "turns";
      const stageLabel = t.stage
        ? ` ${YELLOW}${t.stage}${RESET}`
        : (t.bytesReceived > 0 ? ` ${GRAY}Working...${RESET}` : "");
      const stageWidth = t.stage ? t.stage.length + 1 : (t.bytesReceived > 0 ? 11 : 0);
      const last = truncate(t.lastLine || "starting...", Math.max(1, cols - 55 - stageWidth));
      lines.push(
        `  ${CYAN}T${t.id}${RESET} ${title}${stageLabel}  ${GRAY}${turnLabel} ${t.turnCount} | ${elapsed} | ${kb}KB${RESET}  ${DIM}${last}${RESET}`,
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
        `  ${RED}T${t.id}${RESET} ${t.title}  ${DIM}${truncate(t.lastLine, Math.max(1, cols - 40))}${RESET}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `${DIM}Logs: ${projectDir}/logs/t<N>.jsonl  (tail -f to watch)${RESET}`,
  );

  if (isTTY()) {
    const output = CURSOR_HOME
      + lines.map((l) => l + CLEAR_TO_EOL).join("\n")
      + "\n"
      + CLEAR_BELOW;
    process.stdout.write(output);
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }
}

// ─── Gate Dashboard ──────────────────────────────────────────────────────────

function formatElapsedMs(startMs: number): string {
  return formatSeconds(Math.floor((Date.now() - startMs) / 1000));
}

const PHASE_ICONS: Record<GatePhaseStatus, { symbol: string; color: string }> = {
  pending:  { symbol: " ", color: DIM },
  running:  { symbol: ">", color: CYAN },
  passed:   { symbol: "+", color: GREEN },
  failed:   { symbol: "!", color: RED },
  fixed:    { symbol: "~", color: YELLOW },
  skipped:  { symbol: "-", color: GRAY },
};

const PHASE_LABELS: Record<GatePhaseStatus, string> = {
  pending: "",
  running: "",
  passed: "passed",
  failed: "FAILED",
  fixed: "fixed",
  skipped: "skipped",
};

export function renderGateStatus(status: GateStatus): void {
  const lines: string[] = [];
  const elapsed = formatElapsedMs(status.startedAt);

  // Header: compact — task count + gate title + elapsed on one line
  lines.push(`${GREEN}${status.taskCount} tasks merged${RESET}  ${BOLD}Integration Gate${RESET}  ${GRAY}${elapsed}${RESET}`);

  // Phase checklist
  for (const phase of status.phases) {
    const icon = PHASE_ICONS[phase.status];
    const label = PHASE_LABELS[phase.status];
    const labelStr = label ? `  ${icon.color}${label}${RESET}` : "";
    lines.push(`  ${icon.color}[${icon.symbol}]${RESET} ${phase.name}${labelStr}`);
  }

  // Current activity + stats on one line
  const kb = (status.bytesReceived / 1024).toFixed(0);
  const turnLabel = status.turnCount === 1 ? "turn" : "turns";
  const fixStr = status.maxFixAttempts > 0
    ? `  ${status.fixAttempts > 0 ? YELLOW : DIM}fix ${status.fixAttempts}/${status.maxFixAttempts}${RESET}`
    : "";
  if (status.currentTool) {
    lines.push(`  ${GRAY}> ${status.currentTool}${RESET}  ${DIM}${status.turnCount} ${turnLabel} | ${kb}KB${fixStr}${RESET}`);
  } else {
    lines.push(`  ${DIM}Starting...${RESET}`);
  }

  // Log path
  lines.push(`${DIM}Logs: ${status.logPath}${RESET}`);

  if (isTTY()) {
    const output = CURSOR_HOME
      + lines.map((l) => l + CLEAR_TO_EOL).join("\n")
      + "\n"
      + CLEAR_BELOW;
    process.stdout.write(output);
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }
}
