import type { BackendId } from "../core/adapter.js";
import { COURSES } from "../core/courses.js";
import type { AvailabilityStore } from "../store/store.js";
import { search, type SearchOptions, type SearchQuery, type SearchResult } from "./search.js";

/**
 * Coverage-% acceptance + backend health rollup (tee-times-avh).
 *
 * Makes the charter success bar executable: PARTIAL COVERAGE = FAILURE.
 * `coverageReport` turns a {@link SearchResult} (or a live
 * {@link AvailabilityStore}, which is first read via {@link search}) into a
 * single pass/fail verdict against the full course registry
 * ({@link COURSES}, src/core/courses.ts — the single source of truth for
 * "how many courses exist and on which backend").
 *
 * DENOMINATOR: coursesTotal is ALWAYS derived from COURSES.length, never
 * hardcoded — the registry is the one source of truth (per bead NOTES: do
 * not hardcode 16 if the registry says otherwise). At the time this module
 * was written the registry held all 16 courses across 5 backends (Tee-On x5,
 * EZLinks x2 deep-link-only, Chronogolf x2, TEI Unify x6, ClubHouse x1), but
 * this module makes no assumption about that count beyond "whatever COURSES
 * currently holds."
 *
 * BAR DEFINITION (meetsBar):
 *   1. "All courses accounted for" — every registry course must appear in
 *      the search result's per-course status list, in SOME state (healthy,
 *      stale, or deep-link-only). A course entirely absent from the status
 *      list (e.g. dropped by a bug, or excluded by an over-narrow query)
 *      fails this leg regardless of percentage — see `missingCourseIds`.
 *   2. "Scraped coverage >= threshold" — coveragePct (coursesScraped /
 *      coursesTotal * 100) must be >= thresholdPct (default 75, a
 *      strong-majority bar). "Scraped" means the course actually has
 *      store-backed data (state healthy OR stale) — EZLinks-style
 *      deep-link-only courses are accounted for but do NOT count as scraped,
 *      by design (THE BRIGHT LINE in search.ts/ezlinks.ts: they are never
 *      live-polled).
 * Both legs must hold for meetsBar to be true.
 */

/** Strong-majority default coverage threshold (percentage points), per the bead's charter success bar. */
export const DEFAULT_COVERAGE_THRESHOLD_PCT = 75;

/** Tunable knobs for {@link coverageReport}. */
export interface CoverageOptions {
  /** Minimum scraped-coverage percentage required to meet the bar. Default: {@link DEFAULT_COVERAGE_THRESHOLD_PCT}. */
  thresholdPct?: number;
}

/** Per-backend health rollup: how many of that backend's registry courses landed in each bucket. */
export interface BackendHealthCounts {
  /** Healthy: fresh (non-stale) store-backed data. */
  ok: number;
  /** Stale: store-backed data, but past the store's TTL. */
  stale: number;
  /** Blocked: deep-link-only — either the backend is never live-scraped (e.g. EZLinks), or nothing has ever been polled/stored. */
  blocked: number;
}

/** The full coverage verdict: denominator, per-state breakdown, percentage, pass/fail, and per-backend health. */
export interface CoverageReport {
  /** Total courses in the registry (COURSES.length) — the denominator. Never hardcoded. */
  coursesTotal: number;
  /** Courses with store-backed data: state healthy OR stale. */
  coursesScraped: number;
  /** Courses surfaced as deep-link-only (never-scraped backend, or nothing ever stored). */
  coursesDeepLinkOnly: number;
  /** Subset of coursesScraped whose data is past the store's TTL (informational; already included in coursesScraped). */
  coursesStale: number;
  /** coursesScraped / coursesTotal * 100. 0 if the registry is empty. */
  coveragePct: number;
  /** True iff every registry course is accounted for AND coveragePct >= thresholdPct. */
  meetsBar: boolean;
  /** Registry courseIds that never appeared in the search result's course-status list at all (fails "all accounted for" if non-empty). */
  missingCourseIds: string[];
  /** Per-backend ok/stale/blocked counts, keyed by BackendId. */
  backendHealth: Record<BackendId, BackendHealthCounts>;
}

function emptyBackendHealth(): Record<BackendId, BackendHealthCounts> {
  return {
    "tee-on": { ok: 0, stale: 0, blocked: 0 },
    ezlinks: { ok: 0, stale: 0, blocked: 0 },
    chronogolf: { ok: 0, stale: 0, blocked: 0 },
    "tei-unify": { ok: 0, stale: 0, blocked: 0 },
    clubhouse: { ok: 0, stale: 0, blocked: 0 },
  };
}

/** Duck-types `input` as an AvailabilityStore (has putSnapshot) vs. a plain SearchResult (has courses/slots, no putSnapshot). */
function isAvailabilityStore(input: SearchResult | AvailabilityStore): input is AvailabilityStore {
  return typeof (input as Partial<AvailabilityStore>).putSnapshot === "function";
}

function computeCoverage(searchResult: SearchResult, options: CoverageOptions = {}): CoverageReport {
  const thresholdPct = options.thresholdPct ?? DEFAULT_COVERAGE_THRESHOLD_PCT;
  const coursesTotal = COURSES.length;

  const statusByCourseId = new Map(searchResult.courses.map((status) => [status.courseId, status]));
  const backendHealth = emptyBackendHealth();

  let coursesScraped = 0;
  let coursesDeepLinkOnly = 0;
  let coursesStale = 0;
  const missingCourseIds: string[] = [];

  for (const entry of COURSES) {
    const status = statusByCourseId.get(entry.courseId);
    if (!status) {
      missingCourseIds.push(entry.courseId);
      continue;
    }

    const health = backendHealth[entry.backend];
    switch (status.state) {
      case "healthy":
        coursesScraped += 1;
        health.ok += 1;
        break;
      case "stale":
        coursesScraped += 1;
        coursesStale += 1;
        health.stale += 1;
        break;
      case "deep-link-only":
        coursesDeepLinkOnly += 1;
        health.blocked += 1;
        break;
    }
  }

  const coveragePct = coursesTotal === 0 ? 0 : (coursesScraped / coursesTotal) * 100;
  const allAccounted = missingCourseIds.length === 0;
  const meetsBar = allAccounted && coveragePct >= thresholdPct;

  return {
    coursesTotal,
    coursesScraped,
    coursesDeepLinkOnly,
    coursesStale,
    coveragePct,
    meetsBar,
    missingCourseIds,
    backendHealth,
  };
}

/** Compute the coverage report directly from an already-merged SEARCH/MERGE/RANK result. Pure, no I/O. */
export function coverageReport(searchResult: SearchResult, options?: CoverageOptions): CoverageReport;
/**
 * Compute the coverage report against a live store: runs {@link search} over
 * the full registry (or `query.courseIds` if narrowed) using `query`, then
 * rolls up the resulting SearchResult exactly as the SearchResult overload
 * does. Never mutates the store (search() is read-only — see search.ts's
 * bright-line invariant).
 */
export function coverageReport(
  store: AvailabilityStore,
  query: SearchQuery,
  options?: CoverageOptions,
  searchOptions?: SearchOptions,
): CoverageReport;
export function coverageReport(
  input: SearchResult | AvailabilityStore,
  queryOrOptions?: SearchQuery | CoverageOptions,
  maybeOptions?: CoverageOptions,
  searchOptions?: SearchOptions,
): CoverageReport {
  if (isAvailabilityStore(input)) {
    const query = (queryOrOptions ?? {}) as SearchQuery;
    const result = search(query, input, searchOptions);
    return computeCoverage(result, maybeOptions);
  }
  return computeCoverage(input, queryOrOptions as CoverageOptions | undefined);
}
