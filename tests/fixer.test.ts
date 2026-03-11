import { describe, it, expect } from "vitest";
import { isProgress } from "../src/fixer.js";
import type { ValidationMetrics } from "../src/types.js";

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
