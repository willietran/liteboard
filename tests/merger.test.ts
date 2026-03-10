import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { squashMerge, abortAndRecover } from "../src/merger.js";

const mockExec = vi.mocked(execFileSync);
const mockUnlink = vi.mocked(fs.unlinkSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns all git calls as [command, args] tuples. */
function gitCalls(): string[][] {
  return mockExec.mock.calls
    .filter((c) => c[0] === "git")
    .map((c) => c[1] as string[]);
}

/** Returns all npm calls as [command, args] tuples. */
function npmCalls(): [string, string[]][] {
  return mockExec.mock.calls
    .filter((c) => c[0] === "npm")
    .map((c) => [c[0] as string, c[1] as string[]]);
}

/** Returns all npx calls as [command, args] tuples. */
function npxCalls(): [string, string[]][] {
  return mockExec.mock.calls
    .filter((c) => c[0] === "npx")
    .map((c) => [c[0] as string, c[1] as string[]]);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const PKG_WITH_TEST = JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
  mockExistsSync.mockReturnValue(true); // Default: package.json exists
  mockReadFileSync.mockReturnValue(PKG_WITH_TEST); // Default: valid test script
});

// ─── squashMerge: happy path ─────────────────────────────────────────────────

describe("squashMerge — trial merge succeeds", () => {
  it("resolves repo root and passes cwd to npm calls", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "rev-parse" && a[1] === "--show-toplevel") {
        return "/repo/root";
      }
      return "";
    });

    await squashMerge(1, "proj", "feat/x", "chore: test", false);

    // npm run build should have cwd option
    const npmBuildCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "run",
    );
    expect(npmBuildCall).toBeDefined();
    expect(npmBuildCall![2]).toEqual(
      expect.objectContaining({ cwd: "/repo/root" }),
    );
  });

  it("commits with the correct message after successful merge", async () => {
    await squashMerge(3, "proj", "feat/x", "feat: add widget", false);

    // Should checkout feature branch
    expect(gitCalls()).toContainEqual(["checkout", "feat/x"]);

    // Should trial merge
    expect(gitCalls()).toContainEqual([
      "merge",
      "--squash",
      "--no-commit",
      "feat/x-t3",
    ]);

    // Should commit with exact message
    expect(gitCalls()).toContainEqual(["commit", "-m", "feat: add widget"]);
  });

  it("removes ephemeral files from staging before commit", async () => {
    await squashMerge(5, "proj", "feat/x", "fix: stuff", false);

    // Should attempt to unstage ephemeral files
    expect(gitCalls()).toContainEqual(
      expect.arrayContaining([
        "reset",
        "HEAD",
        "--",
        ".memory-entry.md",
        ".brief-t5.md",
      ]),
    );

    // The reset HEAD call must come before the commit call
    const calls = gitCalls();
    const resetIdx = calls.findIndex(
      (c) => c[0] === "reset" && c[1] === "HEAD",
    );
    const commitIdx = calls.findIndex((c) => c[0] === "commit");
    expect(resetIdx).toBeLessThan(commitIdx);
  });

  it("runs full validation pipeline: install → lockfile → tsc → build → test → commit", async () => {
    await squashMerge(1, "proj", "feat/x", "chore: init", false);

    // All validation steps should be called
    const npms = npmCalls();
    expect(npms).toContainEqual(["npm", ["install"]]);
    expect(npms).toContainEqual(["npm", ["run", "build"]]);
    expect(npms).toContainEqual(["npm", ["test"]]);

    const npxs = npxCalls();
    expect(npxs).toContainEqual(["npx", ["tsc", "--noEmit"]]);

    // Order: npm install → git add lockfile → tsc --noEmit → npm run build → npm test → git commit
    const allCalls = mockExec.mock.calls;
    const installIdx = allCalls.findIndex(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "install",
    );
    const addLockIdx = allCalls.findIndex(
      (c) =>
        c[0] === "git" &&
        (c[1] as string[])[0] === "add" &&
        (c[1] as string[])[1] === "package-lock.json",
    );
    const tscIdx = allCalls.findIndex(
      (c) => c[0] === "npx" && (c[1] as string[])[0] === "tsc",
    );
    const buildIdx = allCalls.findIndex(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "run",
    );
    const testIdx = allCalls.findIndex(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "test",
    );
    const commitIdx = allCalls.findIndex(
      (c) =>
        c[0] === "git" && (c[1] as string[])[0] === "commit",
    );
    expect(installIdx).toBeGreaterThan(-1);
    expect(addLockIdx).toBeGreaterThan(-1);
    expect(tscIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(testIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(addLockIdx);
    expect(addLockIdx).toBeLessThan(tscIdx);
    expect(tscIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(testIdx);
    expect(testIdx).toBeLessThan(commitIdx);
  });
});

// ─── squashMerge: build failure ──────────────────────────────────────────────

describe("squashMerge — build failure", () => {
  it("aborts merge and throws when build fails", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && a[0] === "run") {
        throw Object.assign(new Error("build failed"), {
          stderr: "tsc error TS2304",
        });
      }
      return "";
    });

    await expect(
      squashMerge(2, "proj", "feat/x", "feat: bad", false),
    ).rejects.toThrow(/[Bb]uild.*fail/);

    // Should NOT have committed
    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });
});

// ─── abortAndRecover ─────────────────────────────────────────────────────────

describe("abortAndRecover", () => {
  it("runs merge --abort, checkout, and reset --hard HEAD", () => {
    abortAndRecover("feat/x", false);

    const calls = gitCalls();
    expect(calls).toContainEqual(["merge", "--abort"]);
    expect(calls).toContainEqual(["checkout", "feat/x"]);
    expect(calls).toContainEqual(["reset", "--hard", "HEAD"]);

    // Order: abort → checkout → reset
    const abortIdx = calls.findIndex(
      (c) => c[0] === "merge" && c[1] === "--abort",
    );
    const checkoutIdx = calls.findIndex(
      (c) => c[0] === "checkout" && c[1] === "feat/x",
    );
    const resetIdx = calls.findIndex(
      (c) => c[0] === "reset" && c[1] === "--hard",
    );
    expect(abortIdx).toBeLessThan(checkoutIdx);
    expect(checkoutIdx).toBeLessThan(resetIdx);
  });
});

// ─── Merge serialization ─────────────────────────────────────────────────────

describe("squashMerge — serialization", () => {
  it("second merge waits for first to complete", async () => {
    const order: number[] = [];

    // First merge: resolves slowly using a deferred pattern
    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    let callCount = 0;
    mockExec.mockImplementation((cmd, args) => {
      if (cmd === "git" && (args as string[])[0] === "commit") {
        callCount++;
        if (callCount === 1) {
          order.push(1);
        } else {
          order.push(2);
        }
      }
      return "";
    });

    const p1 = squashMerge(1, "proj", "feat/x", "first", false);
    const p2 = squashMerge(2, "proj", "feat/x", "second", false);

    await Promise.all([p1, p2]);

    // First commit must happen before second commit
    expect(order).toEqual([1, 2]);
  });
});

// ─── Conflict: package.json auto-resolve ─────────────────────────────────────

describe("squashMerge — package.json conflict resolution", () => {
  it("auto-resolves package.json conflicts with checkout --theirs and npm install", async () => {
    let mergeAttempt = 0;

    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "merge" && a[1] === "--squash") {
        mergeAttempt++;
        if (mergeAttempt === 1) {
          throw new Error("merge conflict");
        }
        return "";
      }
      // Return conflicting files: only package.json and package-lock.json
      if (
        cmd === "git" &&
        a[0] === "diff" &&
        a.includes("--diff-filter=U")
      ) {
        return "package.json\npackage-lock.json";
      }
      return "";
    });

    await squashMerge(4, "proj", "feat/x", "fix: deps", false);

    const calls = gitCalls();

    // Should checkout --theirs for package.json
    expect(calls).toContainEqual(["checkout", "--theirs", "package.json"]);
    expect(calls).toContainEqual([
      "checkout",
      "--theirs",
      "package-lock.json",
    ]);

    // Should run npm install
    expect(npmCalls().some(([cmd, a]) => a[0] === "install")).toBe(true);

    // Should stage package-lock.json after npm install
    expect(calls).toContainEqual(["add", "package-lock.json"]);
  });
});

// ─── squashMerge: type-check failure ─────────────────────────────────────────

describe("squashMerge — type-check failure", () => {
  it("aborts merge and throws when tsc --noEmit fails", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npx" && a[0] === "tsc") {
        throw Object.assign(new Error("type check failed"), {
          stderr: "error TS2345: Argument of type",
        });
      }
      return "";
    });

    await expect(
      squashMerge(10, "proj", "feat/x", "feat: bad-types", false),
    ).rejects.toThrow(/Type check.*fail/);

    // Should NOT have committed
    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();

    // Should NOT have reached build or test
    expect(npmCalls().find(([, a]) => a[0] === "run")).toBeUndefined();
    expect(npmCalls().find(([, a]) => a[0] === "test")).toBeUndefined();
  });
});

// ─── squashMerge: test suite failure ─────────────────────────────────────────

describe("squashMerge — test suite failure", () => {
  it("aborts merge and throws when npm test fails", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && a[0] === "test") {
        throw Object.assign(new Error("tests failed"), {
          stderr: "FAIL src/foo.test.ts",
        });
      }
      return "";
    });

    await expect(
      squashMerge(11, "proj", "feat/x", "feat: bad-tests", false),
    ).rejects.toThrow(/Test suite.*fail/);

    // Should NOT have committed
    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });
});

// ─── squashMerge: no package.json (non-npm project) ─────────────────────────

describe("squashMerge — no package.json", () => {
  it("skips all validation when no package.json", async () => {
    mockExistsSync.mockReturnValue(false);

    await squashMerge(7, "proj", "feat/x", "chore: no-npm", false);

    // No npm or npx calls at all
    expect(npmCalls()).toHaveLength(0);
    expect(npxCalls()).toHaveLength(0);

    // But commit still happens
    expect(gitCalls()).toContainEqual(["commit", "-m", "chore: no-npm"]);
  });
});

// ─── squashMerge: npm install failure ───────────────────────────────────────

describe("squashMerge — npm install failure", () => {
  it("throws when npm install fails", async () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && a[0] === "install") {
        throw Object.assign(new Error("install failed"), {
          stderr: "npm ERR! code ERESOLVE",
        });
      }
      return "";
    });

    await expect(
      squashMerge(8, "proj", "feat/x", "feat: bad-deps", false),
    ).rejects.toThrow(/Dependency installation.*fail/);

    // Should NOT have committed
    expect(gitCalls().find((c) => c[0] === "commit")).toBeUndefined();
  });
});

// ─── squashMerge: lockfile staging order ────────────────────────────────────

describe("squashMerge — lockfile staging", () => {
  it("stages package-lock.json after npm install and before build", async () => {
    await squashMerge(9, "proj", "feat/x", "chore: lock", false);

    const allCalls = mockExec.mock.calls;
    const installIdx = allCalls.findIndex(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "install",
    );
    const addLockIdx = allCalls.findIndex(
      (c) =>
        c[0] === "git" &&
        (c[1] as string[])[0] === "add" &&
        (c[1] as string[])[1] === "package-lock.json",
    );
    const buildIdx = allCalls.findIndex(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "run",
    );

    expect(installIdx).toBeGreaterThan(-1);
    expect(addLockIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(addLockIdx);
    expect(addLockIdx).toBeLessThan(buildIdx);
  });
});

// ─── Conflict: other files → squash-rebase-retry ─────────────────────────────

describe("squashMerge — non-package conflict triggers squash-rebase-retry", () => {
  it("squashes task branch, rebases, and retries merge on non-package conflicts", async () => {
    let mergeAttempt = 0;

    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "git" && a[0] === "merge" && a[1] === "--squash") {
        mergeAttempt++;
        if (mergeAttempt === 1) {
          throw new Error("merge conflict");
        }
        // Second attempt succeeds
        return "";
      }
      // Conflict in a source file, not package.json
      if (
        cmd === "git" &&
        a[0] === "diff" &&
        a.includes("--diff-filter=U")
      ) {
        return "src/index.ts";
      }
      return "";
    });

    await squashMerge(6, "proj", "feat/x", "feat: widget", false);

    const calls = gitCalls();

    // Should abort the first merge
    expect(calls).toContainEqual(["merge", "--abort"]);

    // Should checkout the task branch for squashing
    expect(calls).toContainEqual(["checkout", "feat/x-t6"]);

    // Should soft reset to feature branch
    expect(calls).toContainEqual(["reset", "--soft", "feat/x"]);

    // Should commit the squash
    expect(calls).toContainEqual([
      "commit",
      "-m",
      "squashed: feat: widget",
    ]);

    // Should rebase onto feature branch
    expect(calls).toContainEqual(["rebase", "feat/x"]);

    // Should checkout feature branch again for retry
    const checkoutFeatureCalls = calls.filter(
      (c) => c[0] === "checkout" && c[1] === "feat/x",
    );
    expect(checkoutFeatureCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── squashMerge: test script guard ─────────────────────────────────────────

describe("squashMerge — test script guard", () => {
  it("skips npm test when package.json has no test script", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { build: "tsc" } }));

    await squashMerge(12, "proj", "feat/x", "chore: no-tests", false);

    // npm test should NOT be called
    expect(npmCalls().find(([, a]) => a[0] === "test")).toBeUndefined();

    // But commit still happens
    expect(gitCalls()).toContainEqual(["commit", "-m", "chore: no-tests"]);
  });

  it("skips npm test when test script is the npm default placeholder", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: "tsc" } }),
    );

    await squashMerge(13, "proj", "feat/x", "chore: default-test", false);

    // npm test should NOT be called
    expect(npmCalls().find(([, a]) => a[0] === "test")).toBeUndefined();

    // But commit still happens
    expect(gitCalls()).toContainEqual(["commit", "-m", "chore: default-test"]);
  });

  it("runs npm test when package.json has a valid test script", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    );

    await squashMerge(14, "proj", "feat/x", "feat: with-tests", false);

    // npm test should be called
    expect(npmCalls()).toContainEqual(["npm", ["test"]]);
  });
});
