import type { Slot } from "../core/slot.js";
import { COURSES, getCourse, type CourseEntry } from "../core/courses.js";
import { MISS, type AvailabilityStore } from "../store/store.js";

/**
 * The user-facing SEARCH / MERGE / RANK read path (tee-times-7y9).
 *
 * ARCHITECTURAL INVARIANT (THE BRIGHT LINE, tradeoff #4): this module reads
 * ONLY from an {@link AvailabilityStore}. It never imports an
 * {@link AvailabilityAdapter}, never calls `listSlots`, and never triggers a
 * poll/fetch as a side effect of a search. If the store has nothing for a
 * (courseId, date), that course is surfaced as `deep-link-only` — search
 * NEVER reaches out live to get an answer. This is asserted at runtime in
 * test/search/search.integration.test.ts (adapter-call-count === 0) and
 * checked structurally against this file's own source text.
 */

/** Inclusive calendar-day range, both bounds "YYYY-MM-DD". */
export interface DateRange {
  start: string;
  end: string;
}

/** Inclusive course-local wall-clock window, both bounds "HH:MM" (24h). */
export interface TimeWindow {
  start: string;
  end: string;
}

/**
 * A search request. Exactly one of `date` / `dateRange` must be given to
 * scope which dates are read from the store; the rest are optional filters
 * applied uniformly across every in-scope course (see bead NOTES: this is a
 * deliberate design choice for a consistent cross-course experience, even
 * though some backends could natively pre-filter server-side).
 */
export interface SearchQuery {
  /** A single calendar date, "YYYY-MM-DD". Mutually exclusive with dateRange. */
  date?: string;
  /** An inclusive multi-day range. Mutually exclusive with date. */
  dateRange?: DateRange;
  /** Keep only slots whose course-local time falls in [start, end] inclusive. */
  timeWindow?: TimeWindow;
  /** Keep only slots with spotsAvailable >= players. */
  players?: number;
  /** Keep only slots with this exact hole count. */
  holes?: 9 | 18;
  /** Restrict the search to this subset of registry course ids. Defaults to all registry courses. */
  courseIds?: string[];
}

/**
 * Per-course degradation state (A3):
 * - "healthy"        : the store has a fresh (non-stale) snapshot for every
 *                       date read for this course.
 * - "stale"          : the store has data, but at least one read came back
 *                       past its TTL. The slots are still surfaced (never
 *                       dropped), just flagged.
 * - "deep-link-only" : either the course's backend can never be live-scraped
 *                       (e.g. EZLinks, Cloudflare-blocked) or the store had
 *                       MISS for every date in scope (nothing ever polled, or
 *                       the errored/absent case). The course is surfaced with
 *                       a deep link, never dropped from the result.
 */
export type CourseState = "healthy" | "stale" | "deep-link-only";

/** One course's status row, alongside the merged slot list, for the UI to render. */
export interface CourseStatus {
  courseId: string;
  displayName: string;
  state: CourseState;
  /** Present when state is "deep-link-only": a link to the course's own booking page. */
  deepLinkUrl?: string;
}

/** A course-local time-of-day window that should rank higher in results (e.g. "after work" tee times). */
export interface PreferredWindow {
  start: string;
  end: string;
}

/** Ranking configuration. Injectable so callers (and tests) can tune "good times" without editing this module. */
export interface SearchOptions {
  /** Slots whose time falls in any of these windows are ranked ahead of slots that don't. Default: none (pure chronological order). */
  preferredWindows?: PreferredWindow[];
}

/** Sensible default: no preference configured, so ranking degenerates to a pure (date, time) sort. */
export const DEFAULT_PREFERRED_WINDOWS: readonly PreferredWindow[] = [];

/**
 * The shape the UI renders from: one merged, ranked slot list across every
 * in-scope course, plus a per-course status row so a degraded/absent backend
 * is visible (and deep-linkable) rather than silently missing.
 *
 * `slots` ordering: primarily by rank score (preferred-window slots first),
 * then by (date, time) ascending, then by courseId for a deterministic
 * tie-break when two courses share an identical date+time. With no
 * preferredWindows configured, every slot scores equally, so this reduces to
 * a plain merge sorted by (date, time) — satisfying the "merge -> time
 * sorted" baseline while still supporting ranking on top.
 */
export interface SearchResult {
  slots: Slot[];
  courses: CourseStatus[];
}

/**
 * Read-only SEARCH / MERGE / RANK over the AvailabilityStore. Never fetches
 * live; never imports an adapter. One course's MISS/stale/error can never
 * sink the merge — it is isolated into that course's CourseStatus row.
 */
export function search(query: SearchQuery, store: AvailabilityStore, opts: SearchOptions = {}): SearchResult {
  const dates = resolveDates(query);
  const scopeCourses = resolveScopeCourses(query.courseIds);
  const preferredWindows = opts.preferredWindows ?? DEFAULT_PREFERRED_WINDOWS;

  const mergedSlots: Slot[] = [];
  const courses: CourseStatus[] = [];

  for (const entry of scopeCourses) {
    // Deep-link-only BACKENDS (e.g. EZLinks, Cloudflare-blocked) are never
    // live-scraped by design, regardless of what the store holds for them.
    if (entry.backend === "ezlinks") {
      courses.push(deepLinkStatus(entry));
      continue;
    }

    try {
      const { anyResult, anyStale, courseSlots } = readCourseSlots(store, entry.courseId, dates);

      if (!anyResult) {
        // Never polled / nothing stored for any date in scope -> deep-link-only.
        courses.push(deepLinkStatus(entry));
        continue;
      }

      for (const slot of courseSlots) {
        if (passesFilters(slot, query)) {
          mergedSlots.push(slot);
        }
      }
      courses.push({
        courseId: entry.courseId,
        displayName: entry.displayName,
        state: anyStale ? "stale" : "healthy",
      });
    } catch {
      // A3 isolation: one course's unexpected store failure must never sink
      // the whole merge. Surface it the same way as MISS: deep-link-only.
      courses.push(deepLinkStatus(entry));
    }
  }

  return {
    slots: rankSlots(mergedSlots, preferredWindows),
    courses,
  };
}

/** Pulls every stored slot for a course across the resolved date scope, tracking MISS/stale across dates. */
function readCourseSlots(
  store: AvailabilityStore,
  courseId: string,
  dates: readonly string[],
): { anyResult: boolean; anyStale: boolean; courseSlots: Slot[] } {
  let anyResult = false;
  let anyStale = false;
  const courseSlots: Slot[] = [];

  for (const date of dates) {
    const result = store.getSlots(courseId, date);
    if (result === MISS) {
      continue;
    }
    anyResult = true;
    if (result.stale) {
      anyStale = true;
    }
    courseSlots.push(...result.slots);
  }

  return { anyResult, anyStale, courseSlots };
}

function passesFilters(slot: Slot, query: SearchQuery): boolean {
  if (query.players !== undefined && slot.spotsAvailable < query.players) {
    return false;
  }
  if (query.holes !== undefined && slot.holes !== query.holes) {
    return false;
  }
  if (query.timeWindow) {
    if (slot.time < query.timeWindow.start || slot.time > query.timeWindow.end) {
      return false;
    }
  }
  return true;
}

/** Expands query.date | query.dateRange into the explicit list of dates to read from the store. */
function resolveDates(query: SearchQuery): string[] {
  if (query.date) {
    return [query.date];
  }
  if (query.dateRange) {
    return enumerateDates(query.dateRange.start, query.dateRange.end);
  }
  throw new Error("search query must specify either 'date' or 'dateRange'");
}

/** Inclusive list of "YYYY-MM-DD" dates from start to end. Treated as UTC calendar days to avoid DST drift. */
function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= endDate.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** All registry courses, or the subset named by query.courseIds (unknown ids are silently skipped). */
function resolveScopeCourses(courseIds?: string[]): CourseEntry[] {
  if (!courseIds) {
    return COURSES;
  }
  const result: CourseEntry[] = [];
  for (const id of courseIds) {
    const entry = getCourse(id);
    if (entry) {
      result.push(entry);
    }
  }
  return result;
}

/** Builds a deep-link-only CourseStatus row for a course, from the registry's canonical booking-page URL. */
function deepLinkStatus(entry: CourseEntry): CourseStatus {
  return {
    courseId: entry.courseId,
    displayName: entry.displayName,
    state: "deep-link-only",
    deepLinkUrl: entry.bookingUrl,
  };
}

/**
 * Scores + sorts the merged slot list. Score is 1 if the slot's time falls in
 * any configured preferred window, else 0 — higher scores rank first. Ties
 * (including the all-zero-score default case) fall back to (date, time,
 * courseId) ascending, which is what makes the no-preferredWindows case a
 * plain chronological merge.
 */
export function rankSlots(slots: readonly Slot[], preferredWindows: readonly PreferredWindow[]): Slot[] {
  return slots
    .map((slot) => ({ slot, score: scoreSlot(slot, preferredWindows) }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.slot.date !== b.slot.date) {
        return a.slot.date < b.slot.date ? -1 : 1;
      }
      if (a.slot.time !== b.slot.time) {
        return a.slot.time < b.slot.time ? -1 : 1;
      }
      if (a.slot.courseId !== b.slot.courseId) {
        return a.slot.courseId < b.slot.courseId ? -1 : 1;
      }
      return 0;
    })
    .map((entry) => entry.slot);
}

function scoreSlot(slot: Slot, preferredWindows: readonly PreferredWindow[]): number {
  for (const window of preferredWindows) {
    if (slot.time >= window.start && slot.time <= window.end) {
      return 1;
    }
  }
  return 0;
}
