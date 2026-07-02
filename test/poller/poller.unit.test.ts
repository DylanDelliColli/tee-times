import { describe, it, expect, vi } from "vitest";
import { Poller, type AdapterMap } from "../../src/poller/poller.js";
import { RateLimiter } from "../../src/poller/rate-limiter.js";
import type { AvailabilityAdapter, BackendId, CourseRef, ListQuery } from "../../src/core/adapter.js";
import { AdapterError } from "../../src/core/errors.js";
import type { Slot } from "../../src/core/slot.js";
import {
  MISS,
  crossCoursesWithDateWindow,
  type AvailabilityStore,
  type CoursePollTarget,
  type DiffSnapshots,
  type GetSlotsResult,
} from "../../src/store/store.js";
import { getCourse } from "../../src/core/courses.js";

const BASE = 1_700_000_000_000;
const DATE = "2026-07-10";

function makeSlot(courseId: string, backendId: BackendId, overrides: Partial<Slot> = {}): Slot {
  return {
    courseId,
    backendId,
    date: DATE,
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    bookingUrl: `https://example.com/book/${courseId}/${DATE}/0730`,
    ...overrides,
  };
}

/** In-memory store that records every putSnapshot for assertions. */
class RecordingStore implements AvailabilityStore {
  readonly puts: { courseId: string; date: string; slots: Slot[] }[] = [];
  putSnapshot(courseId: string, date: string, slots: Slot[]): void {
    this.puts.push({ courseId, date, slots });
  }
  getSlots(): GetSlotsResult {
    return MISS;
  }
  getSnapshotsForDiff(): DiffSnapshots {
    return {};
  }
  listCoursesToPoll(courseIds: readonly string[], dateWindow: readonly string[]): CoursePollTarget[] {
    return crossCoursesWithDateWindow(courseIds, dateWindow);
  }
  close(): void {}
}

function stubAdapter(
  backendId: BackendId,
  impl: (ref: CourseRef, date: string, query: ListQuery) => Promise<Slot[]>,
): AvailabilityAdapter {
  return { backendId, listSlots: impl };
}

function makePoller() {
  let clock = BASE;
  const limiter = new RateLimiter(
    { now: () => clock, sleep: async () => {}, jitter: () => 0 },
    {},
  );
  const poller = new Poller({ limiter, now: () => clock });
  return { poller, limiter, advance: (ms: number) => (clock += ms) };
}

describe("Poller.runCycle — resilience", () => {
  it("one adapter throwing does NOT sink the cycle: the other courses still poll", async () => {
    const { poller } = makePoller();
    const store = new RecordingStore();

    const okSlots = [makeSlot("lowville", "tee-on")];
    const adapters: AdapterMap = {
      "tee-on": stubAdapter("tee-on", async () => okSlots), // lowville OK
      "tei-unify": stubAdapter("tei-unify", async () => {
        throw new AdapterError({
          backendId: "tei-unify",
          courseId: "glen-abbey",
          kind: "parse",
          retryable: false,
        });
      }),
    };

    const result = await poller.runCycle(adapters, store, {
      courseIds: ["lowville", "glen-abbey"],
      dateWindow: [DATE],
    });

    // OK course written; broken course NOT written (prior left intact).
    expect(store.puts).toEqual([{ courseId: "lowville", date: DATE, slots: okSlots }]);
    const byCourse = new Map(result.targets.map((t) => [t.courseId, t.disposition]));
    expect(byCourse.get("lowville")).toBe("written");
    expect(byCourse.get("glen-abbey")).toBe("error");
    expect(result.health.get("tee-on")?.status).toBe("healthy");
    expect(result.health.get("tei-unify")?.status).toBe("unhealthy");
    expect(result.written).toBe(1);
  });
});

describe("Poller.runCycle — empty([]) vs broken(AdapterError) write semantics (I1)", () => {
  it("writes a real empty [] snapshot, but never writes [] for an AdapterError", async () => {
    const { poller } = makePoller();
    const store = new RecordingStore();

    const adapters: AdapterMap = {
      // clubhouse: genuinely no tee times -> [] IS a real snapshot.
      clubhouse: stubAdapter("clubhouse", async () => []),
      // chronogolf: broken -> must NOT be written as [].
      chronogolf: stubAdapter("chronogolf", async () => {
        throw new AdapterError({
          backendId: "chronogolf",
          courseId: "bantys-roost",
          kind: "network",
          retryable: true,
        });
      }),
    };

    const result = await poller.runCycle(adapters, store, {
      courseIds: ["upper-unionville", "bantys-roost"],
      dateWindow: [DATE],
    });

    // Exactly one write: the real empty [] for the clubhouse course.
    expect(store.puts).toEqual([{ courseId: "upper-unionville", date: DATE, slots: [] }]);
    const byCourse = new Map(result.targets.map((t) => [t.courseId, t.disposition]));
    expect(byCourse.get("upper-unionville")).toBe("written");
    expect(byCourse.get("bantys-roost")).toBe("error");
  });
});

describe("Poller.runCycle — 403 hard-stop suppresses the rest of the backend's targets", () => {
  it("blocks on the first tei-unify target, suppresses the rest without calling the adapter again", async () => {
    const { poller } = makePoller();
    const store = new RecordingStore();

    const listSlots = vi.fn(async () => {
      throw new AdapterError({
        backendId: "tei-unify",
        courseId: "?",
        kind: "blocked",
        retryable: false,
      });
    });
    const adapters: AdapterMap = { "tei-unify": stubAdapter("tei-unify", listSlots) };

    // Poll several tei-unify courses; only the FIRST should hit the network.
    const result = await poller.runCycle(adapters, store, {
      courseIds: ["glen-abbey", "dentonia-park", "don-valley"],
      dateWindow: [DATE],
    });

    expect(listSlots).toHaveBeenCalledTimes(1);
    expect(store.puts).toHaveLength(0);
    const dispositions = result.targets.map((t) => t.disposition);
    expect(dispositions[0]).toBe("blocked");
    expect(dispositions.slice(1)).toEqual(["suppressed", "suppressed"]);
    expect(result.health.get("tei-unify")?.status).toBe("blocked");
  });
});

describe("Poller.runCycle — registry / adapter wiring", () => {
  it("marks 'no-adapter' when a course's backend has no injected adapter, and 'unknown-course' for a bad id", async () => {
    const { poller } = makePoller();
    const store = new RecordingStore();
    // Sanity: these registry lookups exist / don't, matching our expectations.
    expect(getCourse("lowville")?.backend).toBe("tee-on");
    expect(getCourse("nope-not-real")).toBeUndefined();

    const result = await poller.runCycle(
      {},
      store,
      { courseIds: ["lowville", "nope-not-real"], dateWindow: [DATE] },
    );

    const byCourse = new Map(result.targets.map((t) => [t.courseId, t.disposition]));
    expect(byCourse.get("lowville")).toBe("no-adapter");
    expect(byCourse.get("nope-not-real")).toBe("unknown-course");
    expect(store.puts).toHaveLength(0);
  });
});
