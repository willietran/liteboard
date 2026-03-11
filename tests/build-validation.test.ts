import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { runBuildValidation, NPM_TIMEOUT_MS } from "../src/build-validation.js";

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

const PKG_WITH_TEST = JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } });
const PKG_NO_TEST = JSON.stringify({ scripts: { build: "tsc" } });
const PKG_DEFAULT_TEST = JSON.stringify({
  scripts: { test: 'echo "Error: no test specified" && exit 1', build: "tsc" },
});

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(PKG_WITH_TEST);
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("runBuildValidation — happy path", () => {
  it("returns success when all phases pass", () => {
    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(true);
    expect(result.failedPhase).toBe("none");
    expect(result.tscErrorCount).toBe(0);
    expect(result.testFailCount).toBe(0);
  });

  it("runs npm install (not ci) when cleanInstall is false", () => {
    runBuildValidation("/repo", { cleanInstall: false });

    const installCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "install",
    );
    expect(installCall).toBeDefined();
  });

  it("runs npm ci when cleanInstall is true", () => {
    runBuildValidation("/repo", { cleanInstall: true });

    const ciCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "ci",
    );
    expect(ciCall).toBeDefined();
  });

  it("runs validation in correct order: install → tsc → build → test", () => {
    runBuildValidation("/repo", { cleanInstall: false });

    const allCalls = mockExec.mock.calls;
    const installIdx = allCalls.findIndex(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "install",
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

    expect(installIdx).toBeLessThan(tscIdx);
    expect(tscIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(testIdx);
  });

  it("parses test pass count from vitest-style output", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && a[0] === "test") {
        return "Tests  0 failed | 15 passed";
      }
      return "";
    });

    const result = runBuildValidation("/repo", { cleanInstall: false });
    expect(result.success).toBe(true);
    expect(result.testPassCount).toBe(15);
  });
});

// ─── Install failure ─────────────────────────────────────────────────────────

describe("runBuildValidation — install failure", () => {
  it("returns failedPhase=install on npm install error", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && (a[0] === "install" || a[0] === "ci")) {
        throw Object.assign(new Error("install failed"), {
          stderr: "npm ERR! code ERESOLVE",
        });
      }
      return "";
    });

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe("install");
    expect(result.stderr).toContain("ERESOLVE");
  });
});

// ─── Typecheck failure ───────────────────────────────────────────────────────

describe("runBuildValidation — typecheck failure", () => {
  it("returns failedPhase=typecheck and counts tsc errors", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npx" && a[0] === "tsc") {
        throw Object.assign(new Error("tsc failed"), {
          stderr: "src/foo.ts(1,1): error TS2304: cannot find name\nsrc/bar.ts(5,3): error TS2345: argument type",
        });
      }
      return "";
    });

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe("typecheck");
    expect(result.tscErrorCount).toBe(2);
  });

  it("returns tscErrorCount=1 when stderr has no TS error codes", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npx" && a[0] === "tsc") {
        throw Object.assign(new Error("tsc failed"), { stderr: "some other error" });
      }
      return "";
    });

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe("typecheck");
    expect(result.tscErrorCount).toBe(1);
  });
});

// ─── Build failure ───────────────────────────────────────────────────────────

describe("runBuildValidation — build failure", () => {
  it("returns failedPhase=build on npm run build error", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && a[0] === "run") {
        throw Object.assign(new Error("build failed"), {
          stderr: "Error: Cannot find module",
        });
      }
      return "";
    });

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe("build");
  });
});

// ─── Test failure ────────────────────────────────────────────────────────────

describe("runBuildValidation — test failure", () => {
  it("returns failedPhase=test and parses fail counts", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (cmd === "npm" && a[0] === "test") {
        throw Object.assign(new Error("tests failed"), {
          stderr: "FAIL src/foo.test.ts",
          stdout: "Tests  2 failed | 10 passed",
        });
      }
      return "";
    });

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe("test");
    expect(result.testFailCount).toBe(2);
    expect(result.testPassCount).toBe(10);
  });
});

// ─── No package.json ─────────────────────────────────────────────────────────

describe("runBuildValidation — no package.json", () => {
  it("returns success immediately for non-npm projects", () => {
    mockExistsSync.mockReturnValue(false);

    const result = runBuildValidation("/repo", { cleanInstall: true });

    expect(result.success).toBe(true);
    expect(result.failedPhase).toBe("none");
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ─── No test script ──────────────────────────────────────────────────────────

describe("runBuildValidation — no test script", () => {
  it("skips tests when package.json has no test script", () => {
    mockReadFileSync.mockReturnValue(PKG_NO_TEST);

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(true);
    const testCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "test",
    );
    expect(testCall).toBeUndefined();
  });

  it("skips tests when test script is npm default placeholder", () => {
    mockReadFileSync.mockReturnValue(PKG_DEFAULT_TEST);

    const result = runBuildValidation("/repo", { cleanInstall: false });

    expect(result.success).toBe(true);
    const testCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "test",
    );
    expect(testCall).toBeUndefined();
  });
});

// ─── Timeout ─────────────────────────────────────────────────────────────────

describe("runBuildValidation — timeout", () => {
  it("passes custom timeout to execFileSync", () => {
    runBuildValidation("/repo", { cleanInstall: false, timeout: 60_000 });

    const installCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "install",
    );
    expect(installCall).toBeDefined();
    expect((installCall![2] as { timeout: number }).timeout).toBe(60_000);
  });

  it("uses NPM_TIMEOUT_MS as default timeout", () => {
    runBuildValidation("/repo", { cleanInstall: false });

    const installCall = mockExec.mock.calls.find(
      (c) => c[0] === "npm" && (c[1] as string[])[0] === "install",
    );
    expect((installCall![2] as { timeout: number }).timeout).toBe(NPM_TIMEOUT_MS);
  });
});
