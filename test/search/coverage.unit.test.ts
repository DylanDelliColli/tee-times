import { describe, it, expect } from "vitest";
import { COURSES } from "../../src/core/courses.js";
import type { CourseStatus, SearchResult } from "../../src/search/search.js";
import {
  coverageReport,
  DEFAULT_COVERAGE_THRESHOLD_PCT,
  type CoverageReport,
} from "../../src/search/coverage.js";

const NOW = 1_800_000_000_000;

/** Builds a CourseStatus for a registry entry in the given state, matching search.ts's own shape. */
function statusFor(entry: (typeof COURSES)[number], state: CourseStatus["state"]): CourseStatus {
  if (state === "deep-link-only") {
    return {
      courseId: entry.courseId,
      displayName: entry.displayName,
      state,
      deepLinkUrl: entry.bookingUrl,
    };
  }
  return {
    courseId: entry.courseId,
    displayName: entry.displayName,
    state,
    fetchedAt: NOW,
  };
}

/** Builds a full SearchResult covering every registry course, mapping courseId -> forced state via `stateFor`. */
function buildSearchResult(stateFor: (entry: (typeof COURSES)[number]) => CourseStatus["state"] | "omit"): SearchResult {
  const courses: CourseStatus[] = [];
  for (const entry of COURSES) {
    const state = stateFor(entry);
    if (state === "omit") continue;
    courses.push(statusFor(entry, state));
  }
  return { slots: [], courses };
}

describe("coverageReport (unit, pure SearchResult input)", () => {
  it("all registry courses accounted for + fully scraped (100%) -> meetsBar true", () => {
    const result = buildSearchResult(() => "healthy");
    const report = coverageReport(result);

    expect(report.coursesTotal).toBe(COURSES.length);
    expect(report.missingCourseIds).toEqual([]);
    expect(report.coveragePct).toBe(100);
    expect(report.meetsBar).toBe(true);
  });

  it("all courses accounted for; EZLinks deep-link-only + everything else scraped (registry's real >=75% shape) -> meetsBar true", () => {
    // Every non-EZLinks-backend course scraped healthy; EZLinks courses
    // surfaced deep-link-only (accounted for, never scraped by design).
    const result = buildSearchResult((entry) => (entry.backend === "ezlinks" ? "deep-link-only" : "healthy"));
    const report = coverageReport(result);

    const expectedScraped = COURSES.filter((c) => c.backend !== "ezlinks").length;
    const expectedDeepLink = COURSES.filter((c) => c.backend === "ezlinks").length;

    expect(report.missingCourseIds).toEqual([]);
    expect(report.coursesScraped).toBe(expectedScraped);
    expect(report.coursesDeepLinkOnly).toBe(expectedDeepLink);
    expect(report.coveragePct).toBeGreaterThanOrEqual(DEFAULT_COVERAGE_THRESHOLD_PCT);
    expect(report.meetsBar).toBe(true);
  });

  it("a Tee-On-only seed (~5/16, well under 75%) -> meetsBar FALSE", () => {
    // Only Tee-On courses scraped; every other course accounted for as
    // deep-link-only (present, but not scraped) so this exercises the
    // percentage leg specifically, not the "all accounted for" leg.
    const result = buildSearchResult((entry) => (entry.backend === "tee-on" ? "healthy" : "deep-link-only"));
    const report = coverageReport(result);

    const teeOnCount = COURSES.filter((c) => c.backend === "tee-on").length;

    expect(report.missingCourseIds).toEqual([]); // all accounted for
    expect(report.coursesScraped).toBe(teeOnCount);
    expect(report.coveragePct).toBeLessThan(DEFAULT_COVERAGE_THRESHOLD_PCT);
    expect(report.meetsBar).toBe(false);
  });

  it("a missing course (not accounted in any state) fails 'all accounted', even at 100% coverage among the rest", () => {
    const missingId = COURSES[0]!.courseId;
    const result = buildSearchResult((entry) => (entry.courseId === missingId ? "omit" : "healthy"));
    const report = coverageReport(result);

    expect(report.missingCourseIds).toEqual([missingId]);
    // Coverage among the *present* courses is 100%, but the bar still fails.
    expect(report.coveragePct).toBeGreaterThanOrEqual(DEFAULT_COVERAGE_THRESHOLD_PCT);
    expect(report.meetsBar).toBe(false);
  });

  it("coursesStale is tracked separately but counted within coursesScraped", () => {
    const staleId = COURSES.find((c) => c.backend !== "ezlinks")!.courseId;
    const result = buildSearchResult((entry) => (entry.courseId === staleId ? "stale" : "healthy"));
    const report = coverageReport(result);

    expect(report.coursesStale).toBe(1);
    expect(report.coursesScraped).toBe(COURSES.length); // stale still counts as scraped
    expect(report.meetsBar).toBe(true);
  });

  it("backendHealth rolls up ok/stale/blocked per backend", () => {
    const result = buildSearchResult((entry) => (entry.backend === "ezlinks" ? "deep-link-only" : "healthy"));
    const report: CoverageReport = coverageReport(result);

    expect(report.backendHealth.ezlinks).toEqual({
      ok: 0,
      stale: 0,
      blocked: COURSES.filter((c) => c.backend === "ezlinks").length,
    });
    expect(report.backendHealth["tee-on"]).toEqual({
      ok: COURSES.filter((c) => c.backend === "tee-on").length,
      stale: 0,
      blocked: 0,
    });
  });

  it("a custom thresholdPct is honored", () => {
    const result = buildSearchResult((entry) => (entry.backend === "tee-on" ? "healthy" : "deep-link-only"));
    const teeOnCount = COURSES.filter((c) => c.backend === "tee-on").length;
    const pct = (teeOnCount / COURSES.length) * 100;

    // Lower the bar below the Tee-On-only percentage -> should now pass.
    const lenient = coverageReport(result, { thresholdPct: Math.max(0, pct - 1) });
    expect(lenient.meetsBar).toBe(true);

    // Raise it above -> should fail.
    const strict = coverageReport(result, { thresholdPct: Math.min(100, pct + 1) });
    expect(strict.meetsBar).toBe(false);
  });
});
