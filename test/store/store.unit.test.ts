import { describe, it, expect, afterEach } from "vitest";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import { MISS, crossCoursesWithDateWindow, type AvailabilityStore } from "../../src/store/store.js";
import { classifyChange, type Slot } from "../../src/core/slot.js";

/** Simple mutable fake clock injected as the store's `now`. */
function fakeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    courseId: "flemingdon",
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    bookingUrl: "https://example.com/book/flemingdon/2026-07-15/0730",
    ...overrides,
  };
}

// Unit tests exercise store logic (TTL math, MISS semantics, diff shape,
// isolation) using an in-memory sqlite handle — fast and disposable. Real
// on-disk persistence, reopen, and concurrent-write behavior are covered by
// test/store/store.integration.test.ts against a real temp DB file.
describe("AvailabilityStore (unit, in-memory sqlite)", () => {
  const stores: AvailabilityStore[] = [];

  function makeStore(ttlMs: number, now: () => number): AvailabilityStore {
    const store = new SqliteAvailabilityStore(":memory:", { ttlMs, now });
    stores.push(store);
    return store;
  }

  afterEach(() => {
    while (stores.length > 0) {
      stores.pop()!.close();
    }
  });

  describe("TTL boundary", () => {
    it("age just-under TTL => fresh (stale: false)", () => {
      const clock = fakeClock(1_000_000);
      const store = makeStore(15 * 60 * 1000, clock.now);
      store.putSnapshot("courseA", "2026-07-15", [makeSlot()], clock.now());

      clock.advance(15 * 60 * 1000 - 1); // 1ms under TTL
      const result = store.getSlots("courseA", "2026-07-15");
      expect(result).not.toBe(MISS);
      if (result === MISS) throw new Error("unreachable");
      expect(result.stale).toBe(false);
      expect(result.slots).toHaveLength(1);
    });

    it("age just-over TTL => stale:true but STILL SERVED", () => {
      const clock = fakeClock(1_000_000);
      const store = makeStore(15 * 60 * 1000, clock.now);
      store.putSnapshot("courseA", "2026-07-15", [makeSlot()], clock.now());

      clock.advance(15 * 60 * 1000 + 1); // 1ms over TTL
      const result = store.getSlots("courseA", "2026-07-15");
      expect(result).not.toBe(MISS);
      if (result === MISS) throw new Error("unreachable");
      expect(result.stale).toBe(true);
      // Still served, not dropped:
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]?.courseId).toBe("flemingdon");
    });

    it("TTL is config-driven per store instance (gap G5)", () => {
      const clock = fakeClock(1_000_000);
      const shortTtlStore = makeStore(1_000, clock.now);
      shortTtlStore.putSnapshot("courseA", "2026-07-15", [makeSlot()], clock.now());
      clock.advance(1_001);
      const result = shortTtlStore.getSlots("courseA", "2026-07-15");
      if (result === MISS) throw new Error("unreachable");
      expect(result.stale).toBe(true);
    });
  });

  describe("MISS vs empty snapshot", () => {
    it("getSlots on never-stored (courseId,date) returns MISS", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);
      expect(store.getSlots("neverSeen", "2026-07-15")).toBe(MISS);
    });

    it("getSlots after putSnapshot with [] returns a real result, NOT MISS", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);
      store.putSnapshot("courseA", "2026-07-15", [], clock.now());

      const result = store.getSlots("courseA", "2026-07-15");
      expect(result).not.toBe(MISS);
      if (result === MISS) throw new Error("unreachable");
      expect(result.slots).toEqual([]);
      expect(result.stale).toBe(false);
    });
  });

  describe("getSnapshotsForDiff -> classifyChange", () => {
    it("feeds a NEW case end-to-end (prev absent, curr present with spots)", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);
      const slot = makeSlot({ spotsAvailable: 2 });
      store.putSnapshot("courseA", "2026-07-15", [slot], clock.now());

      const { prev, curr } = store.getSnapshotsForDiff("courseA", "2026-07-15");
      expect(prev).toBeUndefined();
      expect(curr?.slots).toHaveLength(1);
      expect(classifyChange(undefined, curr?.slots[0])).toBe("NEW");
    });

    it("feeds a FILLED case end-to-end (spots decreased, still bookable)", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);
      store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 4 })], clock.now());
      clock.advance(1000);
      store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 2 })], clock.now());

      const { prev, curr } = store.getSnapshotsForDiff("courseA", "2026-07-15");
      expect(prev?.slots).toHaveLength(1);
      expect(curr?.slots).toHaveLength(1);
      expect(classifyChange(prev?.slots[0], curr?.slots[0])).toBe("FILLED");
    });

    it("feeds a FREED case end-to-end (spots increased)", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);
      store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 1 })], clock.now());
      clock.advance(1000);
      store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 3 })], clock.now());

      const { prev, curr } = store.getSnapshotsForDiff("courseA", "2026-07-15");
      expect(classifyChange(prev?.slots[0], curr?.slots[0])).toBe("FREED");
    });
  });

  describe("per-(course,date) isolation", () => {
    it("writing courseA/date1 doesn't affect courseB/date1 or courseA/date2", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);

      store.putSnapshot("courseA", "2026-07-15", [makeSlot({ courseId: "courseA" })], clock.now());

      expect(store.getSlots("courseB", "2026-07-15")).toBe(MISS);
      expect(store.getSlots("courseA", "2026-07-16")).toBe(MISS);

      const own = store.getSlots("courseA", "2026-07-15");
      expect(own).not.toBe(MISS);
      if (own === MISS) throw new Error("unreachable");
      expect(own.slots).toHaveLength(1);
    });
  });

  describe("listCoursesToPoll DI seam", () => {
    it("crosses injected course ids with an injected date window", () => {
      const clock = fakeClock(0);
      const store = makeStore(15 * 60 * 1000, clock.now);
      const targets = store.listCoursesToPoll(["a", "b"], ["2026-07-15", "2026-07-16"]);
      expect(targets).toEqual([
        { courseId: "a", date: "2026-07-15" },
        { courseId: "a", date: "2026-07-16" },
        { courseId: "b", date: "2026-07-15" },
        { courseId: "b", date: "2026-07-16" },
      ]);
    });

    it("the standalone pure helper produces the same result with no store instance", () => {
      expect(crossCoursesWithDateWindow(["a"], ["2026-07-15"])).toEqual([
        { courseId: "a", date: "2026-07-15" },
      ]);
    });

    it("empty course list or date window yields an empty worklist", () => {
      expect(crossCoursesWithDateWindow([], ["2026-07-15"])).toEqual([]);
      expect(crossCoursesWithDateWindow(["a"], [])).toEqual([]);
    });
  });
});
