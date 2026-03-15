import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Session, StreamEvent, StreamParser } from "./types.js";
import { VALID_STAGE_MARKERS } from "./types.js";

const STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
const STALL_TIMEOUT_MS = 5 * 60 * 1000;
const STALL_CHECK_INTERVAL_MS = 15 * 1000;
const RING_BUFFER_SIZE = 30;

const outputBuffers = new Map<string, string[]>();

/** Creates a stream parser with its own line buffer for concurrent use. */
function createStreamParser(): StreamParser {
  let buffer = "";
  let lastMessageId = "";
  return (chunk: Buffer): StreamEvent[] => {
    const events: StreamEvent[] = [];
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

      if (raw.type === "assistant") {
        const msg = raw.message as { id?: string; content?: Array<{ type: string; text?: string; name?: string }>; stop_reason?: string | null } | undefined;
        if (!msg) continue;
        const msgId = msg.id;
        if (msgId && msgId !== lastMessageId) {
          events.push({ type: "message_start", turnIndex: 0 });
          lastMessageId = msgId;
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text !== undefined) events.push({ type: "text_delta", text: block.text });
            else if (block.type === "tool_use" && block.name) events.push({ type: "tool_use_start", toolName: block.name });
          }
        }
        if (msg.stop_reason) events.push({ type: "message_end" });
      } else if (raw.type === "user") {
        events.push({ type: "tool_use_end" });
      } else if (raw.type === "error") {
        const err = raw.error as { message?: string } | undefined;
        events.push({ type: "error", message: err?.message ?? "Unknown error" });
      }
    }
    return events;
  };
}

export function spawnSession(
  session: Session,
  prompt: string,
  model: string,
  cwd: string,
  logDir: string,
  verbose: boolean,
  env?: Record<string, string>,
): ChildProcess {
  // Ensure log directory exists
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${session.id}.jsonl`);
  session.logPath = logFile;
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  // Build spawn env: clone process.env, merge extras, strip CLAUDECODE
  const spawnEnv: Record<string, string | undefined> = { ...process.env };
  if (env) Object.assign(spawnEnv, env);
  delete spawnEnv.CLAUDECODE;

  const args = [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--disable-slash-commands",
  ];

  const child = spawn("claude", args, { cwd, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });

  const parse = createStreamParser();
  let lastBytesTime = Date.now();
  outputBuffers.set(session.id, []);

  // stdout
  child.stdout?.on("data", (chunk: Buffer) => {
    session.bytesReceived += chunk.length;
    lastBytesTime = Date.now();
    logStream.write(chunk);

    const buf = outputBuffers.get(session.id);
    if (buf) {
      for (const l of chunk.toString().split("\n").filter(Boolean)) {
        buf.push(l);
        if (buf.length > RING_BUFFER_SIZE) buf.splice(0, buf.length - RING_BUFFER_SIZE);
      }
    }

    for (const evt of parse(chunk)) {
      if (evt.type === "message_start") session.turnCount++;
      else if (evt.type === "text_delta") {
        const stripped = evt.text.replace(/[#*`_~]/g, "").trim();
        const stageMatches = [...stripped.matchAll(/\[STAGE:\s*(.+?)\]/g)];
        const last = stageMatches[stageMatches.length - 1];
        if (last && VALID_STAGE_MARKERS.has(last[1])) session.stage = last[1];
        const forLine = stripped.replace(/\[STAGE:\s*.+?\]/g, "").trim();
        const lines = forLine.split("\n").filter(Boolean);
        const tail = lines[lines.length - 1];
        if (tail) session.lastLine = tail.slice(0, 120);
      } else if (evt.type === "tool_use_start") {
        session.lastLine = `[using ${evt.toolName}]`;
      }
    }
  });

  // stderr
  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) {
      logStream.write(`[stderr] ${msg}\n`);
      const buf = outputBuffers.get(session.id);
      if (buf) {
        buf.push(`[stderr] ${msg}`);
        if (buf.length > RING_BUFFER_SIZE) buf.splice(0, buf.length - RING_BUFFER_SIZE);
      }
    }
  });

  // Stall detection
  const stallInterval = setInterval(() => {
    const elapsed = Date.now() - lastBytesTime;
    const stalled =
      (session.bytesReceived === 0 && elapsed > STARTUP_TIMEOUT_MS) ||
      (session.bytesReceived > 0 && elapsed > STALL_TIMEOUT_MS);
    if (stalled) {
      session.lastLine = session.bytesReceived === 0
        ? "[STALL] No output received - startup timeout (2 min)"
        : "[STALL] No new output - mid-task timeout (5 min)";
      child.kill("SIGTERM");
    }
  }, STALL_CHECK_INTERVAL_MS);

  child.on("close", () => {
    logStream.end();
    clearInterval(stallInterval);
    outputBuffers.delete(session.id);
  });

  return child;
}

/** Returns a snapshot of the last ≤30 output lines for a session. */
export function getRecentOutput(session: Session): string[] {
  const buf = outputBuffers.get(session.id);
  return buf ? [...buf] : [];
}
