import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Task, Provider, StreamEvent, TaskStage } from "./types.js";
import { VALID_STAGE_MARKERS } from "./types.js";
import { artifactsDir } from "./paths.js";

/** Grace period for agent startup. Claude Code can take up to ~60s to initialize;
 *  2 minutes gives margin for API cold starts and network latency. */
const STARTUP_TIMEOUT_MS = 2 * 60 * 1000;

/** Maximum silence during an active task. 5 minutes balances tolerating
 *  slow tool calls (large file writes, npm installs) against detecting
 *  genuine hangs from API rate limits or deadlocked processes. */
const STALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Polling interval for stall detection. 15 seconds keeps CPU overhead
 *  negligible while detecting stalls within one check window of the timeout. */
const STALL_CHECK_INTERVAL_MS = 15 * 1000;

/** Maximum number of lines retained per task in the output ring buffer. */
const RING_BUFFER_SIZE = 30;

interface StallState {
  lastBytesTime: number;
  customTimeoutMs?: number;
}

/** Per-task output ring buffer. Cleaned up on process close. */
const outputBuffers = new Map<number, string[]>();

/** Per-task stall tracking state. Cleaned up on process close. */
const stallStates = new Map<number, StallState>();

/** Returns true if the task's process is considered stalled given current time. */
function checkIsStalled(ss: StallState, bytesReceived: number): boolean {
  const elapsed = Date.now() - ss.lastBytesTime;
  const midTaskTimeout = ss.customTimeoutMs ?? STALL_TIMEOUT_MS;
  return (
    (bytesReceived === 0 && elapsed > STARTUP_TIMEOUT_MS) ||
    (bytesReceived > 0 && elapsed > midTaskTimeout)
  );
}

/** Appends a line to the ring buffer, trimming to RING_BUFFER_SIZE. */
function appendToBuffer(buf: string[], line: string): void {
  buf.push(line);
  if (buf.length > RING_BUFFER_SIZE) {
    buf.splice(0, buf.length - RING_BUFFER_SIZE);
  }
}

export function spawnAgent(
  task: Task,
  brief: string,
  provider: Provider,
  model: string,
  wp: string,
  projectDir: string,
  verbose: boolean,
  env?: Record<string, string>,
  onStall?: (task: Task) => Promise<"keep" | "kill">,
): ChildProcess {
  // Write brief to artifacts directory (outside worktree, for debugging only)
  const briefPath = path.join(artifactsDir(projectDir), `t${task.id}-brief.md`);
  fs.writeFileSync(briefPath, brief, "utf-8");

  // Create log directory and file
  const logDir = path.join(projectDir, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `t${task.id}.jsonl`);
  task.logPath = logFile;
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  // Spawn via provider
  const child = provider.spawn({ prompt: brief, model, cwd: wp, verbose, env });

  // Create per-agent stream parser to avoid buffer corruption at concurrency > 1
  const parse = provider.createStreamParser();

  // Initialize module-level state for this task
  stallStates.set(task.id, { lastBytesTime: Date.now() });
  outputBuffers.set(task.id, []);

  // Parse stdout
  child.stdout?.on("data", (chunk: Buffer) => {
    task.bytesReceived += chunk.length;
    const ss = stallStates.get(task.id);
    if (ss) ss.lastBytesTime = Date.now();
    logStream.write(chunk);

    // Populate output ring buffer
    const buf = outputBuffers.get(task.id);
    if (buf) {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) appendToBuffer(buf, line);
    }

    const events = parse(chunk);
    for (const evt of events) {
      if (evt.type === "message_start") {
        task.turnCount++;
      } else if (evt.type === "text_delta") {
        const stripped = evt.text.replace(/[#*`_~]/g, "").trim();

        // Parse stage markers — use matchAll to find the LAST marker,
        // since text_delta contains accumulated text (not just new delta)
        const stageMatches = [...stripped.matchAll(/\[STAGE:\s*(.+?)\]/g)];
        const lastStageMatch = stageMatches[stageMatches.length - 1];
        if (lastStageMatch && VALID_STAGE_MARKERS.has(lastStageMatch[1])) {
          task.stage = lastStageMatch[1] as TaskStage;
        }

        // Filter stage markers from lastLine
        const forLastLine = stripped.replace(/\[STAGE:\s*.+?\]/g, "").trim();
        const lines = forLastLine.split("\n").filter(Boolean);
        const last = lines[lines.length - 1];
        if (last) {
          task.lastLine = last.slice(0, 120);
        }
      } else if (evt.type === "tool_use_start") {
        task.lastLine = `[using ${evt.toolName}]`;
      }
    }
  });

  // Capture stderr
  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) {
      logStream.write(`[stderr] ${msg}\n`);
      const buf = outputBuffers.get(task.id);
      if (buf) appendToBuffer(buf, `[stderr] ${msg}`);
    }
  });

  child.on("close", () => {
    logStream.end();
    clearInterval(stallInterval);
    outputBuffers.delete(task.id);
    stallStates.delete(task.id);
  });

  // Stall detection
  let stallCallbackInProgress = false;
  const stallInterval = setInterval(async () => {
    if (stallCallbackInProgress) return;
    const ss = stallStates.get(task.id);
    if (!ss) return;
    if (checkIsStalled(ss, task.bytesReceived)) {
      if (onStall) {
        stallCallbackInProgress = true;
        try {
          const result = await onStall(task);
          if (result === "kill") {
            task.lastLine = task.bytesReceived === 0
              ? "[STALL] No output received - startup timeout (2 min)"
              : "[STALL] No new output - mid-task timeout (5 min)";
            child.kill("SIGTERM");
          }
          // If "keep": callback already extended timeout via extendStallTimeout.
          // Stall interval continues — next check sees fresh lastBytesTime.
        } catch {
          // Callback failed — fallback to original kill behavior
          task.lastLine = task.bytesReceived === 0
            ? "[STALL] No output received - startup timeout (2 min)"
            : "[STALL] No new output - mid-task timeout (5 min)";
          child.kill("SIGTERM");
        } finally {
          stallCallbackInProgress = false;
        }
      } else {
        if (task.bytesReceived === 0) {
          task.lastLine = "[STALL] No output received - startup timeout (2 min)";
        } else {
          task.lastLine = "[STALL] No new output - mid-task timeout (5 min)";
        }
        child.kill("SIGTERM");
      }
    }
  }, STALL_CHECK_INTERVAL_MS);

  return child;
}

/** Returns a snapshot of the last ≤30 lines of stdout/stderr output for a task. */
export function getRecentOutput(task: Task): string[] {
  const buf = outputBuffers.get(task.id);
  return buf ? [...buf] : [];
}

/** Returns stall detection state for a task. */
export function getStallInfo(task: Task): {
  bytesReceived: number;
  lastActivityMs: number;
  isStalled: boolean;
} {
  const ss = stallStates.get(task.id);
  if (!ss) {
    return { bytesReceived: 0, lastActivityMs: 0, isStalled: false };
  }
  return {
    bytesReceived: task.bytesReceived,
    lastActivityMs: ss.lastBytesTime,
    isStalled: checkIsStalled(ss, task.bytesReceived),
  };
}

/** Resets the stall timer and optionally sets a custom timeout duration. */
export function extendStallTimeout(task: Task, durationMs: number): void {
  const ss = stallStates.get(task.id);
  if (!ss) return;
  ss.lastBytesTime = Date.now();
  ss.customTimeoutMs = durationMs;
}
