import { describe, it, expect } from "vitest";
import { isProgress, isCodeFixable } from "../src/fixer.js";
import type { ValidationMetrics, BuildValidationResult, SmokeTestResult, QAReport } from "../src/types.js";

// ─── isProgress ──────────────────────────────────────────────────────────────

describe("isProgress", () => {
  const baseMetrics: ValidationMetrics = {
    tscErrorCount: 5,
    testFailCount: 3,
    buildPasses: false,
    smokeTestPasses: false,
    qaFailures: 2,
  };

  it("returns true when tsc errors decrease", () => {
    const current: ValidationMetrics = { ...baseMetrics, tscErrorCount: 3 };
    expect(isProgress(current, baseMetrics)).toBe(true);
  });

  it("returns true when test failures decrease", () => {
    const current: ValidationMetrics = { ...baseMetrics, testFailCount: 1 };
    expect(isProgress(current, baseMetrics)).toBe(true);
  });

  it("returns true when build starts passing", () => {
    const current: ValidationMetrics = { ...baseMetrics, buildPasses: true };
    expect(isProgress(current, baseMetrics)).toBe(true);
  });

  it("returns true when smoke test starts passing", () => {
    const current: ValidationMetrics = { ...baseMetrics, smokeTestPasses: true };
    expect(isProgress(current, baseMetrics)).toBe(true);
  });

  it("returns true when QA failures decrease", () => {
    const current: ValidationMetrics = { ...baseMetrics, qaFailures: 0 };
    expect(isProgress(current, baseMetrics)).toBe(true);
  });

  it("returns false when metrics are the same (no progress)", () => {
    expect(isProgress({ ...baseMetrics }, baseMetrics)).toBe(false);
  });

  it("returns false when metrics worsen (regression)", () => {
    const current: ValidationMetrics = { ...baseMetrics, tscErrorCount: 10 };
    expect(isProgress(current, baseMetrics)).toBe(false);
  });

  it("returns false when one metric improves but another worsens equally", () => {
    const current: ValidationMetrics = {
      ...baseMetrics,
      tscErrorCount: 3,
      testFailCount: 5,
    };
    expect(isProgress(current, baseMetrics)).toBe(false);
  });

  it("returns true when everything passes", () => {
    const allPassing: ValidationMetrics = {
      tscErrorCount: 0,
      testFailCount: 0,
      buildPasses: true,
      smokeTestPasses: true,
      qaFailures: 0,
    };
    expect(isProgress(allPassing, baseMetrics)).toBe(true);
  });
});

// ─── isCodeFixable ───────────────────────────────────────────────────────────

describe("isCodeFixable", () => {
  const passingBuild: BuildValidationResult = {
    success: true,
    failedPhase: "none",
    tscErrorCount: 0,
    testFailCount: 0,
    testPassCount: 10,
  };

  const failingBuild: BuildValidationResult = {
    success: false,
    failedPhase: "typecheck",
    tscErrorCount: 3,
    testFailCount: 0,
    testPassCount: 0,
    stderr: "error TS2304",
  };

  it("returns true when build fails", () => {
    expect(isCodeFixable(failingBuild)).toBe(true);
  });

  it("returns true when QA has failures", () => {
    const qaReport: QAReport = {
      features: [{ name: "Login", passed: false, error: "Button broken" }],
      totalPassed: 0,
      totalFailed: 1,
    };
    expect(isCodeFixable(passingBuild, undefined, qaReport)).toBe(true);
  });

  it("returns false for port timeout (infrastructure)", () => {
    const smoke: SmokeTestResult = {
      success: false,
      projectType: "vite",
      error: "Port 12345 not ready within 60s",
    };
    expect(isCodeFixable(passingBuild, smoke)).toBe(false);
  });

  it("returns false for all-ports-in-use (infrastructure)", () => {
    const smoke: SmokeTestResult = {
      success: false,
      projectType: "vite",
      error: "All ports 12345-12349 in use",
    };
    expect(isCodeFixable(passingBuild, smoke)).toBe(false);
  });

  it("returns false for app exit before port ready (infrastructure)", () => {
    const smoke: SmokeTestResult = {
      success: false,
      projectType: "vite",
      error: "App process exited before port was ready",
    };
    expect(isCodeFixable(passingBuild, smoke)).toBe(false);
  });

  it("returns true for HTTP 500 smoke failure (code issue)", () => {
    const smoke: SmokeTestResult = {
      success: false,
      projectType: "vite",
      error: "HTTP check returned 500",
      appUrl: "http://127.0.0.1:12345",
    };
    expect(isCodeFixable(passingBuild, smoke)).toBe(true);
  });

  it("returns false when everything passes and no smoke/QA results", () => {
    expect(isCodeFixable(passingBuild)).toBe(false);
  });

  it("returns false when everything passes including smoke and QA", () => {
    const smoke: SmokeTestResult = { success: true, projectType: "vite" };
    const qa: QAReport = { features: [{ name: "X", passed: true }], totalPassed: 1, totalFailed: 0 };
    expect(isCodeFixable(passingBuild, smoke, qa)).toBe(false);
  });
});
