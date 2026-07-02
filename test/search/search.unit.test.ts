import { describe, it, expect, afterEach } from "vitest";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import type { AvailabilityStore, GetSlotsResult } from "../../src/store/store.js";
import { MISS } from "../../src/store/store.js";
import type { Slot } from "../../src/core/slot.js";
import { search, rankSlots, type SearchQuery } from "../../src/search/search.js";

/** Simple mutable fake clock injected as the store's `now`, matching store.unit.test.ts's convention. */
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
    courseId: "lowville",
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    bookingUrl: "https://example.com/book/lowville/2026-07-15/0730",
    ...overrides,
  };
}

describe("search (unit, in-memory sqlite store)", () => {
  const stores: AvailabilityStore[] = [];

  // Fixed default clock matching the fetchedAt (1000) used by most seeded
  // snapshots below, so those snapshots are fresh unless a test explicitly
  // advances a fake clock past the TTL (see "stale surfaced and flagged").
  function makeStore(ttlMs = 15 * 60 * 1000, now: () => number = () => 1000): AvailabilityStore {
    const store = new SqliteAvailabilityStore(":memory:", { ttlMs, now });
    stores.push(store);
    return store;
  }

  afterEach(() => {
    while (stores.length > 0) {
      stores.pop()!.close();
    }
  });

  describe("merge -> time-sorted", () => {
    it("merges slots across courses into one list ordered by (date, time)", () => {
      const store = makeStore();
      store.putSnapshot(
        "lowville",
        "2026-07-15",
        [makeSlot({ courseId: "lowville", time: "14:00" }), makeSlot({ courseId: "lowville", time: "07:00" })],
        1000,
      );
      store.putSnapshot("granite", "2026-07-15", [makeSlot({ courseId: "granite", time: "10:00" })], 1000);

      const result = search({ date: "2026-07-15", courseIds: ["lowville", "granite"] }, store);

      expect(result.slots.map((s) => `${s.courseId}@${s.time}`)).toEqual([
        "lowville@07:00",
        "granite@10:00",
        "lowville@14:00",
      ]);
    });
  });

  describe("filters", () => {
    it("date filter: only the queried date's slots are returned", () => {
      const store = makeStore();
      store.putSnapshot("lowville", "2026-07-15", [makeSlot({ date: "2026-07-15", time: "08:00" })], 1000);
      store.putSnapshot("lowville", "2026-07-16", [makeSlot({ date: "2026-07-16", time: "09:00" })], 1000);

      const result = search({ date: "2026-07-15", courseIds: ["lowville"] }, store);
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]?.date).toBe("2026-07-15");
    });

    it("dateRange filter: only dates within the inclusive range are read", () => {
      const store = makeStore();
      store.putSnapshot("lowville", "2026-07-15", [makeSlot({ date: "2026-07-15", time: "08:00" })], 1000);
      store.putSnapshot("lowville", "2026-07-16", [makeSlot({ date: "2026-07-16", time: "08:00" })], 1000);
      store.putSnapshot("lowville", "2026-07-17", [makeSlot({ date: "2026-07-17", time: "08:00" })], 1000);

      const result = search(
        { dateRange: { start: "2026-07-15", end: "2026-07-16" }, courseIds: ["lowville"] },
        store,
      );

      expect(result.slots.map((s) => s.date).sort()).toEqual(["2026-07-15", "2026-07-16"]);
    });

    it("timeWindow filter: keeps only slots within [start,end] inclusive", () => {
      const store = makeStore();
      store.putSnapshot(
        "lowville",
        "2026-07-15",
        [
          makeSlot({ time: "06:00" }),
          makeSlot({ time: "09:00" }),
          makeSlot({ time: "12:00" }),
          makeSlot({ time: "14:00" }),
        ],
        1000,
      );

      const result = search(
        { date: "2026-07-15", courseIds: ["lowville"], timeWindow: { start: "08:00", end: "12:00" } },
        store,
      );

      expect(result.slots.map((s) => s.time)).toEqual(["09:00", "12:00"]);
    });

    it("players filter: keeps slots with spotsAvailable >= players", () => {
      const store = makeStore();
      store.putSnapshot(
        "lowville",
        "2026-07-15",
        [
          makeSlot({ time: "06:00", spotsAvailable: 1 }),
          makeSlot({ time: "07:00", spotsAvailable: 2 }),
          makeSlot({ time: "08:00", spotsAvailable: 4 }),
        ],
        1000,
      );

      const result = search({ date: "2026-07-15", courseIds: ["lowville"], players: 2 }, store);

      expect(result.slots.map((s) => s.spotsAvailable)).toEqual([2, 4]);
    });

    it("holes filter: exact match only", () => {
      const store = makeStore();
      store.putSnapshot(
        "lowville",
        "2026-07-15",
        [makeSlot({ time: "06:00", holes: 9 }), makeSlot({ time: "07:00", holes: 18 })],
        1000,
      );

      const result = search({ date: "2026-07-15", courseIds: ["lowville"], holes: 18 }, store);

      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]?.holes).toBe(18);
    });
  });

  describe("rank ordering", () => {
    it("slots inside a preferred window rank ahead of earlier chronological slots", () => {
      const store = makeStore();
      store.putSnapshot(
        "lowville",
        "2026-07-15",
        [makeSlot({ time: "07:00" }), makeSlot({ time: "17:00" })],
        1000,
      );

      const result = search(
        { date: "2026-07-15", courseIds: ["lowville"] },
        store,
        { preferredWindows: [{ start: "16:00", end: "18:00" }] },
      );

      expect(result.slots.map((s) => s.time)).toEqual(["17:00", "07:00"]);
    });

    it("with no preferredWindows configured, ranking degenerates to chronological order", () => {
      const store = makeStore();
      store.putSnapshot(
        "lowville",
        "2026-07-15",
        [makeSlot({ time: "17:00" }), makeSlot({ time: "07:00" })],
        1000,
      );

      const result = search({ date: "2026-07-15", courseIds: ["lowville"] }, store);
      expect(result.slots.map((s) => s.time)).toEqual(["07:00", "17:00"]);
    });

    it("rankSlots is directly testable in isolation", () => {
      const slots = [makeSlot({ time: "07:00" }), makeSlot({ time: "17:00" }), makeSlot({ time: "12:00" })];
      const ranked = rankSlots(slots, [{ start: "11:00", end: "13:00" }]);
      expect(ranked.map((s) => s.time)).toEqual(["12:00", "07:00", "17:00"]);
    });
  });

  describe("overlapping identical times across courses", () => {
    it("both courses' slots at the same date+time are present, not deduped", () => {
      const store = makeStore();
      store.putSnapshot("lowville", "2026-07-15", [makeSlot({ courseId: "lowville", time: "08:00" })], 1000);
      store.putSnapshot("granite", "2026-07-15", [makeSlot({ courseId: "granite", time: "08:00" })], 1000);

      const result = search({ date: "2026-07-15", courseIds: ["lowville", "granite"] }, store);

      expect(result.slots).toHaveLength(2);
      expect(result.slots.map((s) => s.courseId).sort()).toEqual(["granite", "lowville"]);
    });
  });

  describe("empty results", () => {
    it("a real empty snapshot (store returned data, zero slots) is handled without error", () => {
      const store = makeStore();
      store.putSnapshot("lowville", "2026-07-15", [], 1000);

      const result = search({ date: "2026-07-15", courseIds: ["lowville"] }, store);

      expect(result.slots).toEqual([]);
      expect(result.courses).toEqual([
        { courseId: "lowville", displayName: expect.any(String), state: "healthy" },
      ]);
    });

    it("no courses in scope at all yields empty slots and empty course list", () => {
      const store = makeStore();
      const result = search({ date: "2026-07-15", courseIds: [] }, store);
      expect(result.slots).toEqual([]);
      expect(result.courses).toEqual([]);
    });
  });

  describe("ALL-degraded", () => {
    it("every course deep-link-only/MISS returns the per-course deep links + empty slot list, not an error", () => {
      const store = makeStore();
      // "lakeview" and "braeben" are the registry's EZLinks (deep-link-only backend) courses.
      const result = search({ date: "2026-07-15", courseIds: ["lakeview", "braeben"] }, store);

      expect(result.slots).toEqual([]);
      expect(result.courses).toHaveLength(2);
      for (const status of result.courses) {
        expect(status.state).toBe("deep-link-only");
        expect(status.deepLinkUrl).toBeTruthy();
      }
    });
  });

  describe("one-course-error isolation", () => {
    it("a MISS course doesn't drop the others from the merge", () => {
      const store = makeStore();
      store.putSnapshot("lowville", "2026-07-15", [makeSlot({ courseId: "lowville", time: "08:00" })], 1000);
      // "granite" is never stored -> MISS for this date.

      const result = search({ date: "2026-07-15", courseIds: ["lowville", "granite"] }, store);

      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]?.courseId).toBe("lowville");

      const graniteStatus = result.courses.find((c) => c.courseId === "granite");
      expect(graniteStatus?.state).toBe("deep-link-only");
      const lowvilleStatus = result.courses.find((c) => c.courseId === "lowville");
      expect(lowvilleStatus?.state).toBe("healthy");
    });

    it("a store that throws for one course is isolated, not propagated out of search()", () => {
      const store = makeStore();
      store.putSnapshot("lowville", "2026-07-15", [makeSlot({ courseId: "lowville", time: "08:00" })], 1000);
      store.putSnapshot("granite", "2026-07-15", [makeSlot({ courseId: "granite", time: "09:00" })], 1000);

      const throwingStore: AvailabilityStore = {
        ...store,
        getSlots(courseId: string, date: string): GetSlotsResult {
          if (courseId === "granite") {
            throw new Error("simulated store failure for granite");
          }
          return store.getSlots(courseId, date);
        },
      };

      const result = search({ date: "2026-07-15", courseIds: ["lowville", "granite"] }, throwingStore);

      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]?.courseId).toBe("lowville");
      expect(result.courses.find((c) => c.courseId === "granite")?.state).toBe("deep-link-only");
      expect(result.courses.find((c) => c.courseId === "lowville")?.state).toBe("healthy");
    });
  });

  describe("stale surfaced and flagged", () => {
    it("a stale snapshot's slots are still returned, with the course flagged stale", () => {
      const clock = fakeClock(1_000_000);
      const store = makeStore(60_000, clock.now);
      store.putSnapshot("lowville", "2026-07-15", [makeSlot({ time: "08:00" })], clock.now());
      clock.advance(60_001); // push past TTL

      const result = search({ date: "2026-07-15", courseIds: ["lowville"] }, store);

      expect(result.slots).toHaveLength(1); // still surfaced, not dropped
      expect(result.courses[0]?.state).toBe("stale");
    });
  });

  describe("bad query shape", () => {
    it("throws when neither date nor dateRange is given", () => {
      const store = makeStore();
      expect(() => search({} as SearchQuery, store)).toThrow();
    });
  });
});
