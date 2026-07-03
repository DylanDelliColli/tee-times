import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import { COURSES } from "../../src/core/courses.js";
import type { Slot } from "../../src/core/slot.js";
import { coverageReport, DEFAULT_COVERAGE_THRESHOLD_PCT } from "../../src/search/coverage.js";

function makeSlot(courseId: string, overrides: Partial<Slot> = {}): Slot {
  return {
    courseId,
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    bookingUrl: `https://example.com/book/${courseId}/2026-07-15/0730`,
    ...overrides,
  };
}

// Real better-sqlite3-backed SqliteAvailabilityStore against a real temp DB
// file — never mocked. The point of this suite is to prove the coverage-%
// acceptance bar end-to-end against real store composition, not a stand-in:
// mocking the store here would defeat the purpose (see bead tee-times-avh).
describe("coverageReport (integration, real file-backed SqliteAvailabilityStore)", () => {
  let dir: string;
  let dbPath: string;
  const openStores: SqliteAvailabilityStore[] = [];
  const DATE = "2026-07-15";
  const NOW = 1_800_000_000_000;
  const TTL_MS = 15 * 60 * 1000;

  function openStore(): SqliteAvailabilityStore {
    const store = new SqliteAvailabilityStore(dbPath, { ttlMs: TTL_MS, now: () => NOW });
    openStores.push(store);
    return store;
  }

  function freshDbPath(): void {
    dir = mkdtempSync(join(tmpdir(), "tee-times-coverage-"));
    dbPath = join(dir, `availability-${randomUUID()}.sqlite3`);
  }

  afterEach(() => {
    while (openStores.length > 0) {
      const store = openStores.pop()!;
      try {
        store.close();
      } catch {
        // already closed, ignore
      }
    }
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const nonEzlinksCourses = COURSES.filter((c) => c.backend !== "ezlinks");
  const ezlinksCourses = COURSES.filter((c) => c.backend === "ezlinks");
  const teeOnCourses = COURSES.filter((c) => c.backend === "tee-on");

  it("seeded across all 3 states (healthy/stale/deep-link-only) covering the full registry -> meets the bar end-to-end via the real store", () => {
    freshDbPath();
    const store = openStore();

    // Every scrapable (non-EZLinks) course except the last one: fresh, healthy.
    const staleCourse = nonEzlinksCourses[nonEzlinksCourses.length - 1]!;
    for (const entry of nonEzlinksCourses) {
      if (entry.courseId === staleCourse.courseId) {
        // (B) stale: snapshot exists but older than TTL.
        store.putSnapshot(entry.courseId, DATE, [makeSlot(entry.courseId)], NOW - TTL_MS - 1);
      } else {
        // (A) healthy: fresh snapshot.
        store.putSnapshot(entry.courseId, DATE, [makeSlot(entry.courseId)], NOW);
      }
    }
    // (C) EZLinks courses: never stored at all -> deep-link-only by backend
    // predicate (isDeepLinkOnlyBackend), never live-scraped by design.

    const report = coverageReport(store, { date: DATE });

    expect(report.coursesTotal).toBe(COURSES.length);
    expect(report.missingCourseIds).toEqual([]);
    expect(report.coursesDeepLinkOnly).toBe(ezlinksCourses.length);
    expect(report.coursesStale).toBe(1);
    expect(report.coursesScraped).toBe(nonEzlinksCourses.length); // healthy + stale
    expect(report.coveragePct).toBeGreaterThanOrEqual(DEFAULT_COVERAGE_THRESHOLD_PCT);
    expect(report.meetsBar).toBe(true);

    expect(report.backendHealth.ezlinks.blocked).toBe(ezlinksCourses.length);
    expect(report.backendHealth.ezlinks.ok).toBe(0);
  });

  it("a Tee-On-only seed FAILS the bar end-to-end via the real store (guards against silently shipping half-coverage)", () => {
    freshDbPath();
    const store = openStore();

    // Only Tee-On courses ever get a snapshot; every other backend's courses
    // are never stored (real MISS from the real store), and EZLinks courses
    // are never scrapable by design either way.
    for (const entry of teeOnCourses) {
      store.putSnapshot(entry.courseId, DATE, [makeSlot(entry.courseId)], NOW);
    }

    const report = coverageReport(store, { date: DATE });

    // All 16 registry courses are still ACCOUNTED FOR (the non-Tee-On ones
    // surface as real deep-link-only rows from the real store's MISS), but
    // coverage is well under the bar.
    expect(report.missingCourseIds).toEqual([]);
    expect(report.coursesScraped).toBe(teeOnCourses.length);
    expect(report.coveragePct).toBeLessThan(DEFAULT_COVERAGE_THRESHOLD_PCT);
    expect(report.meetsBar).toBe(false);

    expect(report.backendHealth["tee-on"].ok).toBe(teeOnCourses.length);
    expect(report.backendHealth["tei-unify"].blocked).toBeGreaterThan(0);
    expect(report.backendHealth.clubhouse.blocked).toBeGreaterThan(0);
    expect(report.backendHealth.chronogolf.blocked).toBeGreaterThan(0);
  });

  it("a registry course excluded from the query scope is reported MISSING, failing 'all accounted for' even though the rest is fully scraped", () => {
    freshDbPath();
    const store = openStore();

    const excluded = nonEzlinksCourses[0]!;
    const scopedIds = COURSES.map((c) => c.courseId).filter((id) => id !== excluded.courseId);

    // Seed everything (including the course we'll exclude from scope) as
    // healthy, so the ONLY reason the bar fails is the missing-course leg.
    for (const entry of nonEzlinksCourses) {
      store.putSnapshot(entry.courseId, DATE, [makeSlot(entry.courseId)], NOW);
    }

    const report = coverageReport(store, { date: DATE, courseIds: scopedIds });

    expect(report.missingCourseIds).toEqual([excluded.courseId]);
    expect(report.meetsBar).toBe(false);
  });
});
