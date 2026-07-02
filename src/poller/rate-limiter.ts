import type { BackendId } from "../core/adapter.js";
import { AdapterError } from "../core/errors.js";

/**
 * THE BRIGHT LINE (this module is the enforcement chokepoint):
 *   Never log in. Never defeat a block. Back off on 403/captcha.
 *   No stealth, no anti-bot evasion, no proxy/IP rotation, no challenge-solving.
 *   Polite rate only: <= 4 requests / course / hour, serial with jitter.
 *   On 403/captcha: HARD-STOP that backend for the rest of the calendar day —
 *   no retry-through, no rotation, no challenge-solving.
 *
 * These are encoded as this limiter's ACTUAL behaviour, not just comments:
 *  - {@link RateLimiter.maxRequestsPerHour} caps requests per course per rolling hour.
 *  - All runs pass through a single serial queue with an injected jitter wait.
 *  - A {@link RateLimitError} (HTTP 429) triggers a bounded exponential backoff.
 *  - An {@link AdapterError} of kind 'blocked' (403/captcha) arms a per-backend,
 *    per-calendar-day hard-stop: every further request to that backend that day
 *    is suppressed WITHOUT calling the adapter. No retry-through. No rotation.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default polite ceiling: at most 4 requests per course per rolling hour. */
export const DEFAULT_MAX_REQUESTS_PER_HOUR = 4;

/**
 * Default exponential backoff schedule (ms) applied on successive 429s within a
 * single run: 1s, 2s, 4s. schedule.length is the max number of retries; after it
 * is exhausted the run resolves with status 'error'.
 */
export const DEFAULT_BACKOFF_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Signal that an upstream returned HTTP 429 (Too Many Requests). This is
 * DISTINCT from {@link AdapterError}: an AdapterError means "could not produce
 * a Slot[]" (parse/network/auth/blocked), whereas a RateLimitError means "you
 * asked too fast — slow down and retry". The limiter is the only place that
 * knows how to back off, so adapters/callers throw this to request a retry
 * under the limiter's schedule. It is never written to the store.
 */
export class RateLimitError extends Error {
  /** Optional server-advised delay before retrying, in ms (Retry-After). */
  readonly retryAfterMs?: number;

  constructor(message = "Too Many Requests (429)", retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Injected, deterministic dependencies. Real timers and Math.random are NEVER
 * used directly — they are passed in so tests are fully deterministic.
 */
export interface RateLimiterDeps {
  /** Monotonic-ish clock in epoch ms (e.g. Date.now). Drives quota + day boundary. */
  now: () => number;
  /** Sleep for `ms` (e.g. a real setTimeout wrapper). Awaited serially between requests. */
  sleep: (ms: number) => Promise<void>;
  /**
   * Returns the jitter wait (ms) to apply before an outbound request. Inject a
   * fixed value in tests; in production a small randomized value. Called once
   * per outbound attempt so requests never march in lockstep.
   */
  jitter: () => number;
}

export interface RateLimiterConfig {
  /** Requests per course per rolling hour. Default {@link DEFAULT_MAX_REQUESTS_PER_HOUR}. */
  maxRequestsPerHour?: number;
  /** Exponential backoff schedule (ms) for 429s. Default {@link DEFAULT_BACKOFF_SCHEDULE_MS}. */
  backoffScheduleMs?: readonly number[];
}

/**
 * The result of a limiter-governed run. The poller only writes to the store on
 * `ok`; every other outcome means "do NOT write — leave the prior snapshot
 * intact" (empty-vs-broken invariant I1).
 *
 * - ok          : fn resolved; `value` is its result (may be an empty Slot[]).
 * - rate-limited: the course already hit its hourly quota; fn was NOT called.
 * - suppressed  : the backend is hard-stopped for the day; fn was NOT called.
 * - blocked     : fn threw a 403/captcha AdapterError; the backend is now
 *                 hard-stopped for the rest of the day (Bright Line).
 * - error       : fn failed for another reason (parse/network/auth AdapterError,
 *                 429-backoff exhausted, or an unexpected throw).
 */
export type LimiterOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "rate-limited" }
  | { status: "suppressed" }
  | { status: "blocked"; error: AdapterError }
  | { status: "error"; error: unknown };

/**
 * Serial, polite rate limiter. One instance governs all backends/courses. All
 * runs are funnelled through a single promise chain so at most one request is
 * ever in flight (serial), each preceded by an injected jitter wait.
 */
export class RateLimiter {
  readonly maxRequestsPerHour: number;
  readonly backoffScheduleMs: readonly number[];

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  /** courseId -> epoch-ms timestamps of outbound requests within the rolling hour. */
  private readonly requestTimes = new Map<string, number[]>();
  /** backendId -> day index (floor(now/DAY_MS)) on which it was hard-stopped. */
  private readonly hardStopDay = new Map<BackendId, number>();

  /** Serial queue tail: every run() chains off this so requests never overlap. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: RateLimiterDeps, config: RateLimiterConfig = {}) {
    this.now = deps.now;
    this.sleep = deps.sleep;
    this.jitter = deps.jitter;
    this.maxRequestsPerHour = config.maxRequestsPerHour ?? DEFAULT_MAX_REQUESTS_PER_HOUR;
    this.backoffScheduleMs = config.backoffScheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS;
  }

  /** The calendar-day index for a clock value (UTC day boundary from the injected clock). */
  private dayIndex(nowMs: number): number {
    return Math.floor(nowMs / DAY_MS);
  }

  /**
   * True if `backendId` has been hard-stopped (403/captcha) earlier on the
   * current calendar day. Rolls off automatically once the clock crosses into
   * the next day.
   */
  isSuppressed(backendId: BackendId): boolean {
    const day = this.hardStopDay.get(backendId);
    return day !== undefined && day === this.dayIndex(this.now());
  }

  /** Arm the per-backend, same-day hard-stop. Bright Line: no retry-through, no rotation. */
  private armHardStop(backendId: BackendId): void {
    this.hardStopDay.set(backendId, this.dayIndex(this.now()));
  }

  /** Drop request timestamps older than the rolling hour, return the survivors. */
  private liveRequestTimes(courseId: string): number[] {
    const cutoff = this.now() - HOUR_MS;
    const times = (this.requestTimes.get(courseId) ?? []).filter((t) => t > cutoff);
    this.requestTimes.set(courseId, times);
    return times;
  }

  /** Record one outbound request against the course's hourly quota. */
  private recordRequest(courseId: string): void {
    const times = this.liveRequestTimes(courseId);
    times.push(this.now());
    this.requestTimes.set(courseId, times);
  }

  /**
   * Run `fn` for (backendId, courseId) under the Bright Line. Serial: this call
   * will not start `fn` until every previously-queued run has fully settled.
   * Never throws — every failure mode is a {@link LimiterOutcome}.
   */
  run<T>(backendId: BackendId, courseId: string, fn: () => Promise<T>): Promise<LimiterOutcome<T>> {
    const exec = () => this.execute(backendId, courseId, fn);
    // Chain off the tail regardless of whether the previous run resolved or
    // rejected, so one bad run can never wedge the queue.
    const result = this.tail.then(exec, exec);
    // Keep the tail from ever being a rejected promise.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async execute<T>(
    backendId: BackendId,
    courseId: string,
    fn: () => Promise<T>,
  ): Promise<LimiterOutcome<T>> {
    const schedule = this.backoffScheduleMs;
    let lastError: unknown;

    // attempt 0 is the initial request; attempts 1..schedule.length are 429 retries.
    for (let attempt = 0; attempt <= schedule.length; attempt++) {
      // Bright Line: a hard-stopped backend never touches the network again today.
      if (this.isSuppressed(backendId)) {
        return { status: "suppressed" };
      }

      // Polite quota: <= maxRequestsPerHour per course per rolling hour. Every
      // outbound attempt (including 429 retries) counts.
      if (this.liveRequestTimes(courseId).length >= this.maxRequestsPerHour) {
        return { status: "rate-limited" };
      }

      // Serial pacing: jitter before the first request, exponential backoff
      // before each retry.
      if (attempt === 0) {
        await this.sleep(this.jitter());
      } else {
        await this.sleep(schedule[attempt - 1]!);
      }

      this.recordRequest(courseId);

      try {
        const value = await fn();
        return { status: "ok", value };
      } catch (err) {
        if (err instanceof RateLimitError) {
          // 429: back off and retry (bounded by the schedule).
          lastError = err;
          continue;
        }
        if (err instanceof AdapterError && err.kind === "blocked") {
          // 403/captcha: HARD-STOP this backend for the rest of the day.
          this.armHardStop(backendId);
          return { status: "blocked", error: err };
        }
        // Any other failure (parse/network/auth AdapterError, or unexpected).
        return { status: "error", error: err };
      }
    }

    // Backoff schedule exhausted — still 429ing. Give up politely this cycle.
    return { status: "error", error: lastError };
  }
}
