import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Session, Provider, StreamEvent, SpawnOpts } from "../src/types.js";

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

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    tasks: [],
    complexity: 1,
    focus: `Session ${partial.id}`,
    status: "running",
    bytesReceived: 0,
    turnCount: 0,
    lastLine: "",
    stage: "",
    attemptCount: 0,
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
    const session = makeSession({ id: "3" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "Do the thing", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/proj/artifacts/s3-brief.md",
      "Do the thing",
      "utf-8",
    );
  });

  // ── 2. Creates log directory if it doesn't exist ────────────────────────

  it("creates log directory if it doesn't exist", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    mockExistsSync.mockReturnValue(false);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(mockMkdirSync).toHaveBeenCalledWith("/proj/logs", { recursive: true });
  });

  // ── 3. Calls provider.spawn with correct opts ──────────────────────────

  it("calls provider.spawn with correct opts (no env)", () => {
    const session = makeSession({ id: "5" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "my brief", provider, "opus", "/tmp/wp", "/proj", true);

    expect(provider.spawn).toHaveBeenCalledWith({
      prompt: "my brief",
      model: "opus",
      cwd: "/tmp/wp",
      verbose: true,
      env: undefined,
    });
  });

  it("passes env to provider.spawn when provided", () => {
    const session = makeSession({ id: "5" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);
    const env = { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama" };

    spawnAgent(session, "my brief", provider, "opus", "/tmp/wp", "/proj", true, env);

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
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "message_start", turnIndex: 0 },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Emit two chunks, each producing a message_start event
    child.stdout!.emit("data", Buffer.from("chunk1"));
    child.stdout!.emit("data", Buffer.from("chunk2"));

    expect(session.turnCount).toBe(2);
  });

  // ── 5. Updates lastLine from text_delta, strips markdown, truncates ────

  it("updates lastLine from text_delta, strips markdown chars, truncates to 120", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const longText = "## " + "A".repeat(130) + "\n";
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: longText },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("chunk"));

    // Markdown chars stripped, truncated to 120
    expect(session.lastLine).toBe("A".repeat(120));
    expect(session.lastLine.length).toBe(120);
  });

  it("strips markdown characters #*`_~ from text_delta", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "## **Hello** `world` _foo_ ~bar~\n" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(session.lastLine).toBe("Hello world foo bar");
  });

  // ── Stage marker parsing ───────────────────────────────────────────────

  it("sets session.stage from [STAGE: X] marker in text_delta", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: Exploring]\n" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(session.stage).toBe("Exploring");
  });

  it("ignores invalid stage marker values", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: InvalidPhase]\n" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(session.stage).toBe("");
  });

  it("strips stage markers from lastLine", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: Planning] Starting plan work\n" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(session.stage).toBe("Planning");
    expect(session.lastLine).toBe("Starting plan work");
    expect(session.lastLine).not.toContain("[STAGE:");
  });

  it("does not change session.stage for text_delta without stage marker", () => {
    const session = makeSession({ id: "1", stage: "Exploring" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "Just some regular text\n" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(session.stage).toBe("Exploring");
  });

  it("uses the last stage marker when accumulated text has multiple markers", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    // stream-json sends accumulated text — later deltas contain all prior text
    // So after a stage transition, the text has both old and new markers
    const provider = makeMockProvider(child, [
      { type: "text_delta", text: "[STAGE: Exploring]\nreading files...\n[STAGE: Planning]\nwriting plan...\n" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("chunk"));

    // Must pick the LAST marker, not the first
    expect(session.stage).toBe("Planning");
    expect(session.lastLine).toBe("writing plan...");
  });

  // ── 6. Sets lastLine to [using toolName] on tool_use_start ─────────────

  it("sets lastLine to [using toolName] on tool_use_start", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child, [
      { type: "tool_use_start", toolName: "read_file" },
    ]);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("chunk"));

    expect(session.lastLine).toBe("[using read_file]");
  });

  // ── 7. Accumulates bytesReceived from chunks ──────────────────────────

  it("accumulates bytesReceived from chunks", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stdout!.emit("data", Buffer.from("hello")); // 5 bytes
    child.stdout!.emit("data", Buffer.from("world!!")); // 7 bytes

    expect(session.bytesReceived).toBe(12);
  });

  // ── 8. Writes stderr to log with [stderr] prefix ─────────────────────

  it("writes stderr to log with [stderr] prefix", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    child.stderr!.emit("data", Buffer.from("some error\n"));

    expect(logStreamWrite).toHaveBeenCalledWith("[stderr] some error\n");
  });

  // ── 9. Sets logPath on session ───────────────────────────────────────────

  it("sets session.logPath to the log file path", () => {
    const session = makeSession({ id: "7" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(session.logPath).toBe("/proj/logs/s7.jsonl");
  });

  // ── 10. Returns the ChildProcess ──────────────────────────────────────

  it("returns the ChildProcess from spawn", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    const result = spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    expect(result).toBe(child);
  });

  // ── 11. Pipes raw stdout to log file ──────────────────────────────────

  it("pipes raw stdout to log file", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    const chunk = Buffer.from("raw data");
    child.stdout!.emit("data", chunk);

    expect(logStreamWrite).toHaveBeenCalledWith(chunk);
  });

  // ── 12. Closes log stream on child close ──────────────────────────────

  it("closes log stream when child process closes", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

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
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Advance past 2 minutes (need to pass a stall check interval after the timeout)
    vi.advanceTimersByTime(2 * 60 * 1000 + 15 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.lastLine).toContain("[STALL]");
    expect(session.lastLine).toContain("startup timeout");

    // Clean up interval by emitting close
    child.emit("close");
  });

  // ── 14. Kills process after mid-task stall ────────────────────────────

  it("kills process after mid-task stall (5 min) with no new bytes", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Receive some bytes first
    child.stdout!.emit("data", Buffer.from("initial output"));

    // Now advance past the mid-task stall timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.lastLine).toContain("[STALL]");
    expect(session.lastLine).toContain("mid-task timeout");

    // Clean up
    child.emit("close");
  });

  // ── 15. Does not kill process if bytes keep flowing ───────────────────

  it("does not kill process if bytes keep flowing", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

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
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Close the child process
    child.emit("close");

    // Advance way past timeout - should not kill because interval was cleared
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(child.kill).not.toHaveBeenCalled();
  });

  // ── 17. onStall callback: kill when callback returns "kill" ───────────

  it("calls onStall callback and kills when callback returns 'kill'", async () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);
    const onStall = vi.fn(async () => "kill" as const);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false, undefined, onStall);

    // Receive some bytes then stall
    child.stdout!.emit("data", Buffer.from("some output"));

    // Advance past mid-task stall timeout (5 min + check interval)
    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);
    await Promise.resolve(); // flush async callback

    expect(onStall).toHaveBeenCalledWith(session);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.lastLine).toContain("[STALL]");

    child.emit("close");
  });

  // ── 18. onStall callback: keep when callback returns "keep" ───────────

  it("does not kill when onStall returns 'keep'", async () => {
    const session = makeSession({ id: "2" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);
    const onStall = vi.fn(async () => "keep" as const);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false, undefined, onStall);

    child.stdout!.emit("data", Buffer.from("some output"));

    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);
    await Promise.resolve();

    expect(onStall).toHaveBeenCalledWith(session);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close");
  });

  // ── 19. onStall callback: kill on callback error (fallback) ────────────

  it("falls back to kill when onStall throws", async () => {
    const session = makeSession({ id: "3" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);
    const onStall = vi.fn(async () => { throw new Error("triage failed"); });

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false, undefined, onStall);

    child.stdout!.emit("data", Buffer.from("some output"));

    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);
    await Promise.resolve();

    expect(onStall).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(session.lastLine).toContain("[STALL]");

    child.emit("close");
  });

  // ── 20. onStall callback: prevents re-entry ───────────────────────────

  it("prevents re-entry while stall callback is in progress", async () => {
    const session = makeSession({ id: "4" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    // Slow callback — won't resolve until we manually flush
    let resolveStall!: (v: "keep" | "kill") => void;
    const onStall = vi.fn(() => new Promise<"keep" | "kill">(r => { resolveStall = r; }));

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false, undefined, onStall);

    child.stdout!.emit("data", Buffer.from("some output"));

    // First stall check fires
    vi.advanceTimersByTime(5 * 60 * 1000 + 15 * 1000);
    await Promise.resolve();
    expect(onStall).toHaveBeenCalledTimes(1);

    // Advance another check interval — should NOT call again (flag still set)
    vi.advanceTimersByTime(15 * 1000);
    await Promise.resolve();
    expect(onStall).toHaveBeenCalledTimes(1);

    // Resolve callback and clean up
    resolveStall("kill");
    await Promise.resolve();

    child.emit("close");
  });
});

// ─── Output ring buffer tests ───────────────────────────────────────────────

describe("output ring buffer", () => {
  it("getRecentOutput returns empty array for unknown session", () => {
    const result = getRecentOutput(makeSession({ id: "999" }));
    expect(result).toEqual([]);
  });

  it("ring buffer stores stdout lines", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("line1\nline2\nline3\n"));

    expect(getRecentOutput(session)).toEqual(["line1", "line2", "line3"]);

    child.emit("close");
  });

  it("ring buffer stores stderr lines with [stderr] prefix", () => {
    const session = makeSession({ id: "2" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stderr!.emit("data", Buffer.from("error msg\n"));

    expect(getRecentOutput(session)).toEqual(["[stderr] error msg"]);

    child.emit("close");
  });

  it("ring buffer rotates at 30 lines", () => {
    const session = makeSession({ id: "3" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Emit 35 lines
    const lines = Array.from({ length: 35 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    child.stdout!.emit("data", Buffer.from(lines));

    const result = getRecentOutput(session);
    expect(result).toHaveLength(30);
    expect(result[0]).toBe("line6");
    expect(result[29]).toBe("line35");

    child.emit("close");
  });

  it("ring buffer is cleaned up on process close", () => {
    const session = makeSession({ id: "4" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("some output\n"));
    child.emit("close");

    expect(getRecentOutput(session)).toEqual([]);
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

  it("getStallInfo returns defaults for unknown session", () => {
    const info = getStallInfo(makeSession({ id: "999" }));
    expect(info).toEqual({ bytesReceived: 0, lastActivityMs: 0, isStalled: false });
  });

  it("getStallInfo returns not-stalled state for active process", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("hello"));

    const info = getStallInfo(session);
    expect(info.isStalled).toBe(false);
    expect(info.bytesReceived).toBe(5);
    expect(info.lastActivityMs).toBeGreaterThanOrEqual(0);

    child.emit("close");
  });

  it("getStallInfo returns isStalled true after startup timeout with zero bytes", () => {
    const session = makeSession({ id: "2" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);

    // Advance past 2 min startup timeout
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    const info = getStallInfo(session);
    expect(info.isStalled).toBe(true);
    expect(info.bytesReceived).toBe(0);

    child.emit("close");
  });

  it("getStallInfo returns isStalled true after mid-task stall", () => {
    const session = makeSession({ id: "3" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("some output"));

    // Advance past 5 min mid-task stall timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const info = getStallInfo(session);
    expect(info.isStalled).toBe(true);
    expect(info.bytesReceived).toBeGreaterThan(0);

    child.emit("close");
  });

  it("getStallInfo returns defaults after process close", () => {
    const session = makeSession({ id: "10" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("some data"));
    child.emit("close");

    expect(getStallInfo(session)).toEqual({ bytesReceived: 0, lastActivityMs: 0, isStalled: false });
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

  it("extendStallTimeout is a no-op for unknown session", () => {
    const unknownSession = makeSession({ id: "999" });
    expect(() => extendStallTimeout(unknownSession, 600000)).not.toThrow();
    expect(getStallInfo(unknownSession)).toEqual({ bytesReceived: 0, lastActivityMs: 0, isStalled: false });
  });

  it("extendStallTimeout resets the stall timer", () => {
    const session = makeSession({ id: "1" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("data"));

    // Advance to 4:45 — within the 5 min timeout, no kill yet
    vi.advanceTimersByTime(5 * 60 * 1000 - 15 * 1000);

    // Reset the stall timer (same 5 min duration)
    extendStallTimeout(session, 5 * 60 * 1000);

    // Advance 30s more: 5:00 total from start, but only 0:30 since extend — NOT killed
    vi.advanceTimersByTime(30 * 1000);
    expect(child.kill).not.toHaveBeenCalled();

    // Advance another 5:00 to be > 5 min since extend
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close");
  });

  it("extendStallTimeout with custom duration extends timeout beyond default", () => {
    const session = makeSession({ id: "2" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("data"));

    // Set a 15 min custom timeout immediately
    extendStallTimeout(session, 15 * 60 * 1000);

    // Advance 6 min (past default 5 min) — should NOT kill
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();

    // Advance past 15 min from extend (15 min + 15s for next check)
    vi.advanceTimersByTime(9 * 60 * 1000 + 15 * 1000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close");
  });

  it("getStallInfo reflects extended timeout — not stalled at 6 min after extend", () => {
    const session = makeSession({ id: "5" });
    const child = makeMockChild();
    const provider = makeMockProvider(child);

    spawnAgent(session, "brief", provider, "sonnet", "/tmp/wp", "/proj", false);
    child.stdout!.emit("data", Buffer.from("data"));
    extendStallTimeout(session, 15 * 60 * 1000);

    // Advance 6 min (past default 5 min timeout but within custom 15 min)
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(getStallInfo(session).isStalled).toBe(false);

    child.emit("close");
  });
});
