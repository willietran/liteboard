import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Task, Provider, StreamEvent, TaskStage } from "./types.js";
import { VALID_STAGE_MARKERS } from "./types.js";

const STARTUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALL_CHECK_INTERVAL_MS = 15 * 1000; // 15 seconds

export function spawnAgent(
  task: Task,
  brief: string,
  provider: Provider,
  model: string,
  wp: string,
  projectDir: string,
  verbose: boolean,
): ChildProcess {
  // Write brief to temp file
  const briefPath = path.join(wp, `.brief-t${task.id}.md`);
  fs.writeFileSync(briefPath, brief, "utf-8");

  // Create log directory and file
  const logDir = path.join(projectDir, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `t${task.id}.jsonl`);
  task.logPath = logFile;
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  // Spawn via provider
  const child = provider.spawn({ prompt: brief, model, cwd: wp, verbose });

  // Create per-agent stream parser to avoid buffer corruption at concurrency > 1
  const parse = provider.createStreamParser();

  let lastBytesTime = Date.now();

  // Parse stdout
  child.stdout?.on("data", (chunk: Buffer) => {
    task.bytesReceived += chunk.length;
    lastBytesTime = Date.now();
    logStream.write(chunk);

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
    if (msg) logStream.write(`[stderr] ${msg}\n`);
  });

  child.on("close", () => {
    logStream.end();
    clearInterval(stallInterval);
  });

  // Stall detection
  const stallInterval = setInterval(() => {
    const elapsed = Date.now() - lastBytesTime;
    if (task.bytesReceived === 0 && elapsed > STARTUP_TIMEOUT_MS) {
      task.lastLine = "[STALL] No output received - startup timeout (2 min)";
      child.kill("SIGTERM");
    } else if (task.bytesReceived > 0 && elapsed > STALL_TIMEOUT_MS) {
      task.lastLine = "[STALL] No new output - mid-task timeout (5 min)";
      child.kill("SIGTERM");
    }
  }, STALL_CHECK_INTERVAL_MS);

  return child;
}
