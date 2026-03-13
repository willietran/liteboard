import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Task, Provider, StreamEvent, SpawnOpts } from "../src/types.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
}));

import * as fs from "node:fs";
import { spawnAgent, getRecentOutput, getStallInfo, extendStallTimeout } from "../src/spawner.js";

const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockCreateWriteStream = vi.mocked(fs.createWriteStream);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(partial: Partial<Task> & { id: number }): Task {
  return {
    title: `Task ${partial.id}`,
    creates: [],
    modifies: [],
    dependsOn: [],
    requirements: [],
    explore: [],
    tddPhase: "GREEN",
    commitMessage: "",
    complexity: 1,
    status: "running",
    stage: "",
    turnCount: 0,
    lastLine: "",
    bytesReceived: 0,
    ...partial,
  };
}

/** Creates a mock ChildProcess with EventEmitter-based stdout/stderr. */
function makeMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = vi.fn(() => true);
  child.pid = 12345;
  return child;
}

/** Creates a mock Provider. */
function makeMockProvider(
  child: ChildProcess,
  parseResult: StreamEvent[] = [],
): Provider {
  return {
    name: "mock",
    spawn: vi.fn(() => child),
    parseStream: vi.fn(() => parseResult),
    createStreamParser: vi.fn(() => vi.fn(() => parseResult)),
    healthCheck: vi.fn(async () => true),
    subagentModelHint: vi.fn(() => "sonnet"),
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let logStreamWrite: ReturnType<typeof vi.fn>;
let logStreamEnd: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  logStreamWrite = vi.fn();
  logStreamEnd = vi.fn();
  mockCreateWriteStream.mockReturnValue({
    write: logStreamWrite,
    end: logStreamEnd,
  } as unknown as fs.WriteStream);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("spawnAgent", () => {
  // ── 1. Writes brief to temp file ────────────────────────────────────────

  it("writes brief to artifacts directory instead of worktree", () => {
    const task = makeTask({ id: 3 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "Do the thing", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/proj/artifacts/t3-brief.md",
      "Do the thing",
      "utf-8",
    );
  });

  // ── 2. Creates log directory if it doesn't exist ────────────────────────

  it("creates log directory if it doesn't exist", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    mockExistsSync.mockReturnValue(false);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(mockMkdirSync).toHaveBeenCalledWith("/proj/logs", { recursive: true });
  });

  // ── 3. Calls provider.spawn with correct opts ──────────────────────────

  it("calls provider.spawn with correct opts (no env)", () => {
    const task = makeTask({ id: 5 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "my brief", provider, "opus", "/tmp/wp", "/proj", true);

    expect(provider.spawn).toHaveBeenCalledWith({
      prompt: "my brief",
      model: "opus",
      cwd: "/tmp/wp",
      verbose: true,
      env: undefined,
    });
  });

  it("passes env to provider.spawn when provided", () => {
    const task = makeTask({ id: 5 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);
    const env = { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama" };

    spawnAgent(task, "my brief", provider, "opus", "/tmp/wp", "/proj", true, env);

    expect(provider.spawn).toHaveBeenCalledWith({
      prompt: "my brief",
      model: "opus",
      cwd: "/tmp/wp",
      verbose: true,
      env,
    });
  });

  // ── 4. Increments turnCount on message_start events ────────────────────

  it("increments turnCount on message_start events", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "message_start", turnIndex: 0 },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Emit two chunks, each producing a message_start event
    child.stdout!.emit("data", Buffer.from("chunk1"));
    child.stdout!.emit("data", Buffer.from("chunk2"));

    expect(task.turnCount).toBe(2);
  });

  // ── 5. Updates lastLine from text_delta, strips markdown, truncates ────

  it("updates lastLine from text_delta, strips markdown chars, truncates to 120", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const longText = "## " + "A".repeat(130) + "\n";
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: longText },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("chunk"));

    // Markdown chars stripped, truncated to 120
    expect(task.lastLine).toBe("A".repeat(120));
    expect(task.lastLine.length).toBe(120);
  });

  it("strips markdown characters #*`_~ from text_delta", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "## **Hello** `world` _foo_ ~bar~\n" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(task.lastLine).toBe("Hello world foo bar");
  });

  // ── Stage marker parsing ───────────────────────────────────────────────

  it("sets task.stage from [STAGE: X] marker in text_delta", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: Exploring]\n" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(task.stage).toBe("Exploring");
  });

  it("ignores invalid stage marker values", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: InvalidPhase]\n" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(task.stage).toBe("");
  });

  it("strips stage markers from lastLine", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: Planning] Starting plan work\n" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(task.stage).toBe("Planning");
    expect(task.lastLine).toBe("Starting plan work");
    expect(task.lastLine).not.toContain("[STAGE:");
  });

  it("does not change task.stage for text_delta without stage marker", () => {
    const task = makeTask({ id: 1, stage: "Exploring" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "Just some regular text\n" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(task.stage).toBe("Exploring");
  });

  it("uses the last stage marker when accumulated text has multiple markers", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    // stream-json sends accumulated text — later deltas contain all prior text
    // So after a stage transition, the text has both old and new markers
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: Exploring]\nreading files...\n[STAGE: Planning]\nwriting plan...\n" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    // Must pick the LAST marker, not the first
    expect(task.stage).toBe("Planning");
    expect(task.lastLine).toBe("writing plan...");
  });

  // ── 6. Sets lastLine to [using toolName] on tool_use_start ─────────────

  it("sets lastLine to [using toolName] on tool_use_start", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "tool_use_start", toolName: "read_file" },
    ]);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(task.lastLine).toBe("[using read_file]");
  });

  // ── 7. Accumulates bytesReceived from chunks ──────────────────────────

  it("accumulates bytesReceived from chunks", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("hello")); // 5 bytes
    child.stdout!.emit("data", Buffer.from("world!!")); // 7 bytes

    expect(task.bytesReceived).toBe(12);
  });

  // ── 8. Writes stderr to log with [stderr] prefix ─────────────────────

  it("writes stderr to log with [stderr] prefix", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stderr!.emit("data", Buffer.from("some error\n"));

    expect(logStreamWrite).toHaveBeenCalledWith("[stderr] some error\n");
  });

  // ── 9. Sets logPath on task ───────────────────────────────────────────

  it("sets task.logPath to the log file path", () => {
    const task = makeTask({ id: 7 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(task.logPath).toBe("/proj/logs/t7.jsonl");
  });

  // ── 10. Returns the ChildProcess ──────────────────────────────────────

  it("returns the ChildProcess from spawn", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    const result = spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(result).toBe(child);
  });

  // ── 11. Pipes raw stdout to log file ──────────────────────────────────

  it("pipes raw stdout to log file", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    const chunk = Buffer.from("raw data");
    child.stdout!.emit("data", chunk);

    expect(logStreamWrite).toHaveBeenCalledWith(chunk);
  });

  // ── 12. Closes log stream on child close ──────────────────────────────

  it("closes log stream when child process closes", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.emit("close");

    expect(logStreamEnd).toHaveBeenCalled();
  });
});

// ─── Stall detection tests ──────────────────────────────────────────────────

describe("spawnAgent stall detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 13. Kills process after startup timeout with zero bytes ───────────

  it("kills process after startup timeout (2 min) with zero bytes", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Advance past 2 minutes (need to pass a stall check interval after the timeout)
    vi.advanceTimersByTime(2 * 60 * 1000 + 15 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(task.lastLine).toContain("[STALL]");
    expect(task.lastLine).toContain("startup timeout");

    // Clean up interval by emitting close
    child.emit("close");
  });

  // ── 14. Kills process after mid-task stall ────────────────────────────

  it("kills process after mid-task stall (5 min) with no new bytes", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Receive some bytes first
    child.stdout!.emit("data", Buffer.from("initial output"));

    // Now advance past the mid-task stall timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(task.lastLine).toContain("[STALL]");
    expect(task.lastLine).toContain("mid-task timeout");

    // Clean up
    child.emit("close");
  });

  // ── 15. Does not kill process if bytes keep flowing ───────────────────

  it("does not kill process if bytes keep flowing", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Send data every 10 seconds for 6 minutes (well past any timeout)
    for (let i = 0; i < 36; i++) {
      vi.advanceTimersByTime(10 * 1000);
      child.stdout!.emit("data", Buffer.from("more data"));
    }

    expect(child.kill).not.toHaveBeenCalled();

    // Clean up
    child.emit("close");
  });

  // ── 16. Clears stall interval on close ────────────────────────────────

  it("clears stall interval on child close", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Close the child process
    child.emit("close");

    // Advance way past timeout - should not kill because interval was cleared
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(child.kill).not.toHaveBeenCalled();
  });
});

// ─── Output ring buffer tests ───────────────────────────────────────────────

describe("output ring buffer", () => {
  it("getRecentOutput returns empty array for unknown task", () => {
    const result = getRecentOutput(makeTask({ id: 999 }));
    expect(result).toEqual([]);
  });

  it("ring buffer stores stdout lines", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("line1\nline2\nline3\n"));

    expect(getRecentOutput(task)).toEqual(["line1", "line2", "line3"]);

    child.emit("close");
  });

  it("ring buffer stores stderr lines with [stderr] prefix", () => {
    const task = makeTask({ id: 2 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stderr!.emit("data", Buffer.from("error msg\n"));

    expect(getRecentOutput(task)).toEqual(["[stderr] error msg"]);

    child.emit("close");
  });

  it("ring buffer rotates at 30 lines", () => {
    const task = makeTask({ id: 3 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Emit 35 lines
    const lines = Array.from({ length: 35 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    child.stdout!.emit("data", Buffer.from(lines));

    const result = getRecentOutput(task);
    expect(result).toHaveLength(30);
    expect(result[0]).toBe("line6");
    expect(result[29]).toBe("line35");

    child.emit("close");
  });

  it("ring buffer is cleaned up on process close", () => {
    const task = makeTask({ id: 4 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("some output\n"));
    child.emit("close");

    expect(getRecentOutput(task)).toEqual([]);
  });
});

// ─── Stall info exposure tests ──────────────────────────────────────────────

describe("stall info exposure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getStallInfo returns defaults for unknown task", () => {
    const info = getStallInfo(makeTask({ id: 999 }));
    expect(info).toEqual({ bytesReceived: 0, lastActivityMs: 0, isStalled: false });
  });

  it("getStallInfo returns not-stalled state for active process", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("hello"));

    const info = getStallInfo(task);
    expect(info.isStalled).toBe(false);
    expect(info.bytesReceived).toBe(5);
    expect(info.lastActivityMs).toBeGreaterThanOrEqual(0);

    child.emit("close");
  });

  it("getStallInfo returns isStalled true after startup timeout with zero bytes", () => {
    const task = makeTask({ id: 2 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Advance past 2 min startup timeout
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    const info = getStallInfo(task);
    expect(info.isStalled).toBe(true);
    expect(info.bytesReceived).toBe(0);

    child.emit("close");
  });

  it("getStallInfo returns isStalled true after mid-task stall", () => {
    const task = makeTask({ id: 3 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("some output"));

    // Advance past 5 min mid-task stall timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const info = getStallInfo(task);
    expect(info.isStalled).toBe(true);
    expect(info.bytesReceived).toBeGreaterThan(0);

    child.emit("close");
  });

  it("getStallInfo returns defaults after process close", () => {
    const task = makeTask({ id: 10 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("some data"));
    child.emit("close");

    expect(getStallInfo(task)).toEqual({ bytesReceived: 0, lastActivityMs: 0, isStalled: false });
  });
});

// ─── extendStallTimeout tests ───────────────────────────────────────────────

describe("extendStallTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extendStallTimeout is a no-op for unknown task", () => {
    const unknownTask = makeTask({ id: 999 });
    expect(() => extendStallTimeout(unknownTask, 600000)).not.toThrow();
    expect(getStallInfo(unknownTask)).toEqual({ bytesReceived: 0, lastActivityMs: 0, isStalled: false });
  });

  it("extendStallTimeout resets the stall timer", () => {
    const task = makeTask({ id: 1 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("data"));

    // Advance to 4:45 — within the 5 min timeout, no kill yet
    vi.advanceTimersByTime(5 * 60 * 1000 - 15 * 1000);

    // Reset the stall timer (same 5 min duration)
    extendStallTimeout(task, 5 * 60 * 1000);

    // Advance 30s more: 5:00 total from start, but only 0:30 since extend — NOT killed
    vi.advanceTimersByTime(30 * 1000);
    expect(child.kill).not.toHaveBeenCalled();

    // Advance another 5:00 to be > 5 min since extend
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close");
  });

  it("extendStallTimeout with custom duration extends timeout beyond default", () => {
    const task = makeTask({ id: 2 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("data"));

    // Set a 15 min custom timeout immediately
    extendStallTimeout(task, 15 * 60 * 1000);

    // Advance 6 min (past default 5 min) — should NOT kill
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();

    // Advance past 15 min from extend (15 min + 15s for next check)
    vi.advanceTimersByTime(9 * 60 * 1000 + 15 * 1000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close");
  });

  it("getStallInfo reflects extended timeout — not stalled at 6 min after extend", () => {
    const task = makeTask({ id: 5 });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(task, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("data"));
    extendStallTimeout(task, 15 * 60 * 1000);

    // Advance 6 min (past default 5 min timeout but within custom 15 min)
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(getStallInfo(task).isStalled).toBe(false);

    child.emit("close");
  });
});
