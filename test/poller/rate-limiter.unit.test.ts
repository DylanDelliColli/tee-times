import { describe, it, expect, vi } from "vitest";
import {
  RateLimiter,
  RateLimitError,
  type RateLimiterConfig,
  type RateLimiterDeps,
} from "../../src/poller/rate-limiter.js";
import { AdapterError } from "../../src/core/errors.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A base clock aligned to a UTC day start keeps the day-boundary math obvious.
const BASE = 1_700_000_000_000;

/**
 * Deterministic harness: a mutable clock, a sleep spy that records durations
 * (and never touches real time), and a jitter spy. No real timers, no
 * Math.random — exactly as the Bright Line enforcement requires for auditable
 * behaviour.
 */
function harness(config: RateLimiterConfig = {}, jitterMs = 5) {
  let clock = BASE;
  const sleepCalls: number[] = [];
  const jitter = vi.fn(() => jitterMs);
  const deps: RateLimiterDeps = {
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    }),
    jitter,
  };
  const limiter = new RateLimiter(deps, config);
  return {
    limiter,
    sleepCalls,
    jitter,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
    now: () => clock,
  };
}

const ok = () => async () => "SLOTS";

describe("RateLimiter — hourly quota (Bright Line: <=4 req/course/hr)", () => {
  it("blocks the 5th request for a course within the hour, allows again after the hour rolls", async () => {
    const h = harness();

    for (let i = 0; i < 4; i++) {
      const r = await h.limiter.run("tee-on", "lowville", ok());
      expect(r.status).toBe("ok");
    }

    // 5th within the same hour -> deferred, adapter never called.
    const fifth = vi.fn(async () => "SLOTS");
    const blocked = await h.limiter.run("tee-on", "lowville", fifth);
    expect(blocked.status).toBe("rate-limited");
    expect(fifth).not.toHaveBeenCalled();

    // A different course is unaffected by lowville's quota.
    const other = await h.limiter.run("tee-on", "granite", ok());
    expect(other.status).toBe("ok");

    // Roll the clock past the hour: the 4 old timestamps age out -> allowed.
    h.advance(HOUR_MS + 1);
    const fresh = vi.fn(async () => "SLOTS");
    const allowed = await h.limiter.run("tee-on", "lowville", fresh);
    expect(allowed.status).toBe("ok");
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe("RateLimiter — serial execution + jitter", () => {
  it("serializes overlapping runs (no two requests in flight) and invokes jitter each request", async () => {
    // Real async sleep so overlap would actually manifest if seriality were broken.
    let clock = BASE;
    const jitter = vi.fn(() => 0);
    const limiter = new RateLimiter(
      {
        now: () => clock,
        sleep: () => new Promise<void>((res) => setTimeout(res, 0)),
        jitter,
      },
      {},
    );

    let active = 0;
    let maxActive = 0;
    const makeFn = () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 0));
      active -= 1;
      return "x";
    };

    // Fire three runs across different courses WITHOUT awaiting between them.
    const p1 = limiter.run("tee-on", "c1", makeFn());
    const p2 = limiter.run("tei-unify", "c2", makeFn());
    const p3 = limiter.run("clubhouse", "c3", makeFn());
    const results = await Promise.all([p1, p2, p3]);

    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(maxActive).toBe(1); // never more than one request in flight
    expect(jitter).toHaveBeenCalledTimes(3); // one jitter wait per request
    void clock;
  });
});

describe("RateLimiter — 429 exponential backoff", () => {
  it("applies the exact backoff schedule on repeated 429s, then resolves 'error' when exhausted", async () => {
    const h = harness({ backoffScheduleMs: [100, 200, 400], maxRequestsPerHour: 100 }, 5);
    const fn = vi.fn(async () => {
      throw new RateLimitError();
    });

    const r = await h.limiter.run("tee-on", "lowville", fn);

    expect(r.status).toBe("error");
    // jitter (5) before the first request, then 100/200/400 backoff before each retry.
    expect(h.sleepCalls).toEqual([5, 100, 200, 400]);
    // initial attempt + 3 retries = 4 outbound attempts.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("recovers: backs off on 429s then returns 'ok' once the call succeeds", async () => {
    const h = harness({ backoffScheduleMs: [100, 200, 400], maxRequestsPerHour: 100 }, 5);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new RateLimitError();
      return "SLOTS";
    });

    const r = await h.limiter.run("tee-on", "lowville", fn);

    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.value).toBe("SLOTS");
    expect(h.sleepCalls).toEqual([5, 100, 200]); // jitter + two backoffs, no third
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("RateLimiter — 403/captcha HARD-STOP (Bright Line)", () => {
  function blockedError(): AdapterError {
    return new AdapterError({
      backendId: "tei-unify",
      courseId: "glen-abbey",
      kind: "blocked",
      retryable: false,
    });
  }

  it("hard-stops the backend for the rest of the day; subsequent calls suppressed, no adapter call", async () => {
    const h = harness();

    const fnBlocked = vi.fn(async () => {
      throw blockedError();
    });
    const first = await h.limiter.run("tei-unify", "glen-abbey", fnBlocked);
    expect(first.status).toBe("blocked");
    expect(h.limiter.isSuppressed("tei-unify")).toBe(true);

    // Any further request to that backend today is suppressed WITHOUT calling
    // the adapter — no retry-through, no rotation, no challenge-solving.
    const fnLater = vi.fn(async () => "SLOTS");
    const second = await h.limiter.run("tei-unify", "dentonia-park", fnLater);
    expect(second.status).toBe("suppressed");
    expect(fnLater).not.toHaveBeenCalled();

    // A DIFFERENT backend is unaffected — the hard-stop is per-backend.
    const otherBackend = await h.limiter.run("tee-on", "lowville", ok());
    expect(otherBackend.status).toBe("ok");
  });

  it("lifts the hard-stop after the calendar day boundary", async () => {
    const h = harness();
    await h.limiter.run("tei-unify", "glen-abbey", async () => {
      throw blockedError();
    });
    expect(h.limiter.isSuppressed("tei-unify")).toBe(true);

    // Cross into the next calendar day (injected clock).
    h.advance(DAY_MS);
    expect(h.limiter.isSuppressed("tei-unify")).toBe(false);

    const fn = vi.fn(async () => "SLOTS");
    const r = await h.limiter.run("tei-unify", "glen-abbey", fn);
    expect(r.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("hard-stop rolls off at course-local midnight not UTC (tee-times-r9j)", async () => {
    // All 16 courses are Toronto-area; the hard-stop's "rest of the calendar
    // day" must mean the course-LOCAL day, not the UTC day. America/Toronto is
    // EST (UTC-5, no DST) in January, so local midnight is UTC 05:00.
    const h = harness({ timeZone: "America/Toronto" });

    // Local 2026-01-14T00:30 EST == UTC 2026-01-14T05:30.
    h.setClock(Date.UTC(2026, 0, 14, 5, 30, 0));
    await h.limiter.run("tei-unify", "glen-abbey", async () => {
      throw blockedError();
    });
    expect(h.limiter.isSuppressed("tei-unify")).toBe(true);

    // Local 2026-01-14T19:30 EST == UTC 2026-01-15T00:30 — the UTC calendar
    // day has already rolled over to the 15th, but locally it's still the
    // evening of the 14th (5.5h before local midnight). A UTC-day-boundary
    // implementation would incorrectly lift the hard-stop here; a
    // course-local implementation must NOT.
    h.setClock(Date.UTC(2026, 0, 15, 0, 30, 0));
    expect(h.limiter.isSuppressed("tei-unify")).toBe(true);

    // Local 2026-01-15T00:30 EST == UTC 2026-01-15T05:30 — local midnight has
    // now actually passed. The hard-stop must roll off here.
    h.setClock(Date.UTC(2026, 0, 15, 5, 30, 0));
    expect(h.limiter.isSuppressed("tei-unify")).toBe(false);

    const fn = vi.fn(async () => "SLOTS");
    const r = await h.limiter.run("tei-unify", "glen-abbey", fn);
    expect(r.status).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
