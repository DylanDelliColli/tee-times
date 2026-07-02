import { describe, it, expect } from "vitest";
import { DEEP_LINK_ONLY_BACKENDS, isDeepLinkOnlyBackend } from "../../src/adapters/ezlinks.js";
import type { BackendId } from "../../src/core/adapter.js";
import { COURSES, getCourse } from "../../src/core/courses.js";
import { search } from "../../src/search/search.js";
import { Poller, type AdapterMap } from "../../src/poller/poller.js";
import { RateLimiter } from "../../src/poller/rate-limiter.js";
import { MISS, crossCoursesWithDateWindow } from "../../src/store/store.js";
import type { AvailabilityStore, CoursePollTarget, DiffSnapshots, GetSlotsResult } from "../../src/store/store.js";
import type { Slot } from "../../src/core/slot.js";

// ALL non-ezlinks BackendIds, so the "false for everything else" assertion is
// exhaustive rather than a hand-picked sample that could drift if a new
// backend is added.
const OTHER_BACKENDS: BackendId[] = Array.from(
  new Set(COURSES.map((c) => c.backend).filter((b) => b !== "ezlinks")),
);

describe("isDeepLinkOnlyBackend / DEEP_LINK_ONLY_BACKENDS (tee-times-3rj)", () => {
  it("DEEP_LINK_ONLY_BACKENDS is exactly ['ezlinks']", () => {
    expect(DEEP_LINK_ONLY_BACKENDS).toEqual(["ezlinks"]);
  });

  it("is true for 'ezlinks'", () => {
    expect(isDeepLinkOnlyBackend("ezlinks")).toBe(true);
  });

  it("is false for every other registered backend", () => {
    expect(OTHER_BACKENDS.length).toBeGreaterThan(0); // sanity: registry actually has other backends
    for (const backend of OTHER_BACKENDS) {
      expect(isDeepLinkOnlyBackend(backend)).toBe(false);
    }
  });
});

/** Minimal in-memory store: always MISS, records nothing — the point is that
 * search()/the poller must not even need real data for EZLinks courses. */
class AlwaysMissStore implements AvailabilityStore {
  getSlots(): GetSlotsResult {
    return MISS;
  }
  putSnapshot(): void {
    throw new Error("AlwaysMissStore.putSnapshot should never be called for a deep-link-only backend");
  }
  getSnapshotsForDiff(): DiffSnapshots {
    return {};
  }
  listCoursesToPoll(courseIds: readonly string[], dateWindow: readonly string[]): CoursePollTarget[] {
    return crossCoursesWithDateWindow(courseIds, dateWindow);
  }
  close(): void {}
}

describe("search() surfaces EZLinks (lakeview + braeben) as deep-link-only with their real registry bookingUrl", () => {
  it("both courses come back state:'deep-link-only' with deepLinkUrl === entry.bookingUrl, and are never dropped", () => {
    const store = new AlwaysMissStore();
    const lakeview = getCourse("lakeview")!;
    const braeben = getCourse("braeben")!;
    expect(lakeview.backend).toBe("ezlinks");
    expect(braeben.backend).toBe("ezlinks");

    const result = search({ date: "2026-07-15", courseIds: ["lakeview", "braeben"] }, store);

    expect(result.courses).toHaveLength(2);
    const byId = Object.fromEntries(result.courses.map((c) => [c.courseId, c]));

    expect(byId.lakeview?.state).toBe("deep-link-only");
    expect(byId.lakeview?.deepLinkUrl).toBe(lakeview.bookingUrl);
    expect(byId.braeben?.state).toBe("deep-link-only");
    expect(byId.braeben?.deepLinkUrl).toBe(braeben.bookingUrl);
  });

  it("EZLinks courses stay present (never dropped) even mixed in with other backends", () => {
    const store = new AlwaysMissStore();
    const result = search(
      { date: "2026-07-15", courseIds: ["lowville", "lakeview", "braeben", "granite"] },
      store,
    );
    const ids = result.courses.map((c) => c.courseId).sort();
    expect(ids).toEqual(["braeben", "granite", "lakeview", "lowville"]);
  });
});

/** Records every putSnapshot call, so we can prove the poller never writes for EZLinks. */
class RecordingStore implements AvailabilityStore {
  readonly puts: { courseId: string; date: string }[] = [];
  putSnapshot(courseId: string, date: string): void {
    this.puts.push({ courseId, date });
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

describe("Poller never live-polls EZLinks (no adapter is ever registered for 'ezlinks')", () => {
  it("lakeview + braeben both come back disposition 'no-adapter' against an AdapterMap with zero ezlinks entry", async () => {
    const BASE = 1_700_000_000_000;
    const DATE = "2026-07-10";
    const limiter = new RateLimiter({ now: () => BASE, sleep: async () => {}, jitter: () => 0 }, {});
    const poller = new Poller({ limiter, now: () => BASE });
    const store = new RecordingStore();

    // An AdapterMap that (realistically, per THE BRIGHT LINE) never has an
    // 'ezlinks' key — this is the actual production wiring shape, not a
    // contrived test-only omission.
    const adapters: AdapterMap = {};

    const result = await poller.runCycle(adapters, store, {
      courseIds: ["lakeview", "braeben"],
      dateWindow: [DATE],
    });

    const byCourse = new Map(result.targets.map((t) => [t.courseId, t]));
    expect(byCourse.get("lakeview")?.disposition).toBe("no-adapter");
    expect(byCourse.get("lakeview")?.backendId).toBe("ezlinks");
    expect(byCourse.get("braeben")?.disposition).toBe("no-adapter");
    expect(byCourse.get("braeben")?.backendId).toBe("ezlinks");
    expect(store.puts).toHaveLength(0);
    expect(result.written).toBe(0);
  });
});
