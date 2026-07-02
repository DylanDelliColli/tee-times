import type { AvailabilityAdapter, BackendId, ListQuery } from "../core/adapter.js";
import { AdapterError } from "../core/errors.js";
import { COURSES, getCourse, type CourseEntry } from "../core/courses.js";
import type { AvailabilityStore } from "../store/store.js";
import type { RateLimiter } from "./rate-limiter.js";

/**
 * Poller fan-out: crosses the course registry with a caller-supplied date window,
 * polls each (course, date) through the {@link RateLimiter}, and writes results
 * to the {@link AvailabilityStore}.
 *
 * INVARIANT I1 (empty-vs-broken): a SUCCESSFUL poll returning [] IS written as an
 * empty snapshot (a real "no tee times"). A FAILED poll (AdapterError, 429, or a
 * limiter skip) is NEVER written as [] — that would corrupt the cache into
 * reading "no times". On failure we record backend health and leave the prior
 * snapshot untouched.
 *
 * RESILIENCE: one adapter throwing (or 429ing, or being hard-stopped) must NEVER
 * sink the rest of the cycle. Every target is isolated; the others still poll.
 */

/** Health of one backend as observed during a single cycle. */
export type BackendHealthStatus = "healthy" | "unhealthy" | "blocked";

export interface BackendHealth {
  status: BackendHealthStatus;
  /** Human-readable reason (e.g. the AdapterError kind, or 'suppressed'). */
  reason?: string;
}

/** Per-target disposition, useful for tests and observability. */
export type TargetDisposition =
  | "written" // success (incl. empty []) -> putSnapshot called
  | "blocked" // 403/captcha this cycle -> backend hard-stopped
  | "suppressed" // backend already hard-stopped today -> adapter NOT called
  | "rate-limited" // course hit hourly quota -> adapter NOT called
  | "error" // parse/network/auth/429-exhausted -> prior snapshot left intact
  | "no-adapter" // no adapter registered for this course's backend
  | "unknown-course"; // courseId not in the registry

export interface TargetResult {
  courseId: string;
  date: string;
  backendId?: BackendId;
  disposition: TargetDisposition;
}

export interface CycleResult {
  /** Every target's disposition, in poll order. */
  targets: TargetResult[];
  /** Terminal health per backend touched this cycle. */
  health: Map<BackendId, BackendHealth>;
  /** Count of putSnapshot writes (successful polls, including empty []). */
  written: number;
  /** Count of targets whose prior snapshot was left intact due to failure/skip. */
  skipped: number;
}

/** A lookup from backend id to the adapter that serves it. */
export type AdapterMap = Partial<Record<BackendId, AvailabilityAdapter>>;

export interface RunCycleOptions {
  /**
   * The forward-looking date window to poll, as "YYYY-MM-DD" strings. THE
   * DATE-WINDOW CONTRACT: the poller does NOT invent dates — the caller (the
   * cron wiring) supplies the exact set of course-local calendar dates to poll
   * (e.g. today .. today+N). Required and must be non-empty; an empty window
   * yields an empty cycle.
   */
  dateWindow: readonly string[];
  /**
   * Which courses to poll. Defaults to every course in the registry
   * ({@link COURSES}). Cross-producted with `dateWindow` via
   * `store.listCoursesToPoll`.
   */
  courseIds?: readonly string[];
  /** Query knobs forwarded to every adapter.listSlots. Defaults to {}. */
  query?: ListQuery;
}

export interface PollerDeps {
  limiter: RateLimiter;
  /** Clock for stamping putSnapshot.fetchedAt. Share the limiter's clock in prod/tests. */
  now: () => number;
}

export class Poller {
  private readonly limiter: RateLimiter;
  private readonly now: () => number;

  constructor(deps: PollerDeps) {
    this.limiter = deps.limiter;
    this.now = deps.now;
  }

  /**
   * Run one full poll cycle over (courseIds x dateWindow). Adapters are injected
   * (interface only) — the poller never imports concrete adapters. Returns a
   * per-target report; never throws for a per-target failure.
   */
  async runCycle(adapters: AdapterMap, store: AvailabilityStore, opts: RunCycleOptions): Promise<CycleResult> {
    const courseIds = opts.courseIds ?? COURSES.map((c) => c.courseId);
    const query = opts.query ?? {};
    const targets = store.listCoursesToPoll(courseIds, opts.dateWindow);

    const result: CycleResult = {
      targets: [],
      health: new Map<BackendId, BackendHealth>(),
      written: 0,
      skipped: 0,
    };

    for (const target of targets) {
      const tr = await this.pollTarget(target.courseId, target.date, adapters, store, query, result.health);
      result.targets.push(tr);
      if (tr.disposition === "written") {
        result.written += 1;
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  private async pollTarget(
    courseId: string,
    date: string,
    adapters: AdapterMap,
    store: AvailabilityStore,
    query: ListQuery,
    health: Map<BackendId, BackendHealth>,
  ): Promise<TargetResult> {
    // Defense in depth: nothing below is allowed to throw out of this cycle.
    try {
      const course: CourseEntry | undefined = getCourse(courseId);
      if (!course) {
        return { courseId, date, disposition: "unknown-course" };
      }
      const backendId = course.backend;
      const adapter = adapters[backendId];
      if (!adapter) {
        return { courseId, date, backendId, disposition: "no-adapter" };
      }

      const outcome = await this.limiter.run(backendId, courseId, () =>
        adapter.listSlots(course.courseRef, date, query),
      );

      switch (outcome.status) {
        case "ok": {
          // I1: a successful [] IS a real empty snapshot — write it.
          store.putSnapshot(courseId, date, outcome.value, this.now());
          this.mergeHealth(health, backendId, { status: "healthy" });
          return { courseId, date, backendId, disposition: "written" };
        }
        case "blocked": {
          // Bright Line: do NOT write. Backend is now hard-stopped for the day.
          this.mergeHealth(health, backendId, { status: "blocked", reason: "blocked" });
          return { courseId, date, backendId, disposition: "blocked" };
        }
        case "suppressed": {
          // Backend hard-stopped earlier today; adapter was NOT called.
          this.mergeHealth(health, backendId, { status: "blocked", reason: "suppressed" });
          return { courseId, date, backendId, disposition: "suppressed" };
        }
        case "rate-limited": {
          // Course hit its hourly quota; adapter was NOT called. Leave prior intact.
          return { courseId, date, backendId, disposition: "rate-limited" };
        }
        case "error": {
          // I1: do NOT write []. Record unhealthy, leave the prior snapshot.
          const reason = outcome.error instanceof AdapterError ? outcome.error.kind : "error";
          this.mergeHealth(health, backendId, { status: "unhealthy", reason });
          return { courseId, date, backendId, disposition: "error" };
        }
      }
    } catch (err) {
      // Truly unexpected (e.g. store.putSnapshot threw). Do not sink the cycle.
      const course = getCourse(courseId);
      const backendId = course?.backend;
      if (backendId) {
        this.mergeHealth(health, backendId, { status: "unhealthy", reason: "cycle-error" });
      }
      return { courseId, date, backendId, disposition: "error" };
    }
  }

  /**
   * Merge health for a backend within one cycle. A 'blocked' status is sticky:
   * once a backend is blocked/suppressed this cycle, a later healthy target
   * (there should be none — they'd be suppressed) must not clear it.
   */
  private mergeHealth(health: Map<BackendId, BackendHealth>, backendId: BackendId, next: BackendHealth): void {
    const prev = health.get(backendId);
    if (prev?.status === "blocked") {
      return;
    }
    health.set(backendId, next);
  }
}
