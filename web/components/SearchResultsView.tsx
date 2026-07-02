import type { SearchResult } from "../../src/search/search.js";
import { SlotRow } from "./SlotRow.js";
import { CourseStatusRow } from "./CourseStatusRow.js";

export interface SearchResultsViewProps {
  result: SearchResult;
  /** Injectable clock (epoch ms), threaded through to CourseStatusRow for deterministic "~N min old" rendering in tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Renders a SearchResult: the merged, time-sorted slot list (search() already
 * sorts — this component does not re-sort) plus a per-course status section
 * with degradation badges. No login/account UI anywhere (A2, shared no-account view).
 *
 * Handles both degenerate cases explicitly rather than letting them fall out
 * of a generic empty check:
 *   - EMPTY: zero slots at all -> a clear "no tee times" message.
 *   - ALL-DEGRADED: every in-scope course is stale/deep-link-only -> still
 *     renders the full course-status list (with working deep links), never a
 *     blank page.
 */
export function SearchResultsView({ result, now = Date.now() }: SearchResultsViewProps) {
  const courseById = new Map(result.courses.map((c) => [c.courseId, c] as const));

  const allDegraded =
    result.courses.length > 0 &&
    result.courses.every((c) => c.state === "deep-link-only" || c.state === "stale");

  return (
    <section className="search-results" data-testid="search-results">
      <section className="course-status-list" aria-label="Course status">
        <h2>Course status</h2>
        {result.courses.length === 0 ? (
          <p className="course-status-empty">No courses in scope for this search.</p>
        ) : (
          <ul data-testid="course-status-list">
            {result.courses.map((status) => (
              <CourseStatusRow key={status.courseId} status={status} now={now} />
            ))}
          </ul>
        )}
      </section>

      <section className="slot-list" aria-label="Tee times">
        <h2>Tee times</h2>
        {result.slots.length === 0 ? (
          <p data-testid="empty-state" className="empty-state">
            {allDegraded
              ? "No live tee times right now — every course is stale or deep-link-only. Use the links above to check times directly on each course's site."
              : "No tee times found for this search. Try widening your date range, time window, or course selection."}
          </p>
        ) : (
          <ul data-testid="slot-list">
            {result.slots.map((slot) => (
              <SlotRow
                key={`${slot.courseId}|${slot.date}|${slot.time}|${slot.holes}`}
                slot={slot}
                courseDisplayName={courseById.get(slot.courseId)?.displayName ?? slot.courseId}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
