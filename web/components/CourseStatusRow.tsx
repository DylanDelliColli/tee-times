import type { CourseStatus } from "../../src/search/search.js";

export interface CourseStatusRowProps {
  status: CourseStatus;
  /** Injectable clock (epoch ms) so "~N min old" is deterministic in tests. Defaults to Date.now(). */
  now?: number;
}

function ageMinutes(fetchedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - fetchedAt) / 60_000));
}

/**
 * Per-course degradation row (A3). Three states:
 * - "healthy"        : a small "live" badge, no link needed.
 * - "stale"          : a "stale" badge showing "~N min old" (derived from
 *                       CourseStatus.fetchedAt, tee-times-npr).
 * - "deep-link-only" : a "check times ->" link straight to the course's own
 *                       booking page (CourseStatus.deepLinkUrl) — the course
 *                       is NEVER dropped from this list, even with zero slots.
 */
export function CourseStatusRow({ status, now = Date.now() }: CourseStatusRowProps) {
  if (status.state === "deep-link-only") {
    return (
      <li
        className="course-status course-status--deep-link-only"
        data-testid="course-status"
        data-course-id={status.courseId}
        data-state={status.state}
      >
        <span className="course-name">{status.displayName}</span>
        <a
          className="deep-link"
          data-testid="deep-link"
          href={status.deepLinkUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          check times &rarr;
        </a>
      </li>
    );
  }

  if (status.state === "stale") {
    const age = status.fetchedAt !== undefined ? ageMinutes(status.fetchedAt, now) : undefined;
    return (
      <li
        className="course-status course-status--stale"
        data-testid="course-status"
        data-course-id={status.courseId}
        data-state={status.state}
      >
        <span className="course-name">{status.displayName}</span>
        <span className="badge badge--stale" data-testid="stale-badge">
          stale{age !== undefined ? ` (~${age} min old)` : ""}
        </span>
      </li>
    );
  }

  return (
    <li
      className="course-status course-status--healthy"
      data-testid="course-status"
      data-course-id={status.courseId}
      data-state={status.state}
    >
      <span className="course-name">{status.displayName}</span>
      <span className="badge badge--healthy">live</span>
    </li>
  );
}
