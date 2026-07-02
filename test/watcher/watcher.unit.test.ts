import { describe, it, expect } from "vitest";
import type { Slot } from "../../src/core/slot.js";
import type { DiffSnapshots, Snapshot } from "../../src/store/store.js";
import { matches, type AlertRule } from "../../src/watcher/rules.js";
import type { Alert, NotificationSink } from "../../src/watcher/sink.js";
import {
  createWatchState,
  deserializeWatchState,
  runWatch,
  serializeWatchState,
  type DiffSource,
  type WatchState,
} from "../../src/watcher/watcher.js";

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    courseId: "flemingdon",
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 2,
    bookingUrl: "https://example.com/book/flemingdon/2026-07-15/0730",
    ...overrides,
  };
}

function snap(slots: Slot[], fetchedAt = 0): Snapshot {
  return { slots, fetchedAt };
}

/** A fake DiffSource that returns a scripted sequence of DiffSnapshots per call, one per (courseId,date). */
class ScriptedStore implements DiffSource {
  private readonly script: Map<string, DiffSnapshots[]> = new Map();
  private readonly cursor: Map<string, number> = new Map();

  /** Queue up the DiffSnapshots this (courseId,date) should return on each successive call. */
  queue(courseId: string, date: string, ...diffs: DiffSnapshots[]): void {
    this.script.set(`${courseId}|${date}`, diffs);
  }

  getSnapshotsForDiff(courseId: string, date: string): DiffSnapshots {
    const key = `${courseId}|${date}`;
    const diffs = this.script.get(key) ?? [];
    const idx = this.cursor.get(key) ?? 0;
    this.cursor.set(key, idx + 1);
    // Once the script is exhausted, keep returning the last entry (steady state).
    return diffs[Math.min(idx, diffs.length - 1)] ?? {};
  }
}

class RecordingSink implements NotificationSink {
  calls: Alert[] = [];
  send(alert: Alert): void {
    this.calls.push(alert);
  }
}

function baseRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "rule-1",
    courseIds: ["flemingdon"],
    dates: ["2026-07-15"],
    ...overrides,
  };
}

describe("rules.matches()", () => {
  it("passes when every configured filter is satisfied", () => {
    const rule = baseRule({ timeWindow: { start: "07:00", end: "09:00" }, minSpots: 2, holes: 18 });
    expect(matches(rule, makeSlot(), "2026-07-15")).toBe(true);
  });

  it("gates on courseIds", () => {
    const rule = baseRule({ courseIds: ["other-course"] });
    expect(matches(rule, makeSlot({ courseId: "flemingdon" }), "2026-07-15")).toBe(false);
  });

  it("gates on the date window (explicit list)", () => {
    const rule = baseRule({ dates: ["2026-07-20"] });
    expect(matches(rule, makeSlot(), "2026-07-15")).toBe(false);
  });

  it("gates on the date window ({start,end} range)", () => {
    const rule = baseRule({ dates: { start: "2026-07-16", end: "2026-07-20" } });
    expect(matches(rule, makeSlot(), "2026-07-15")).toBe(false);
    expect(matches(rule, makeSlot(), "2026-07-17")).toBe(true);
  });

  it("gates on timeWindow (before start)", () => {
    const rule = baseRule({ timeWindow: { start: "08:00", end: "09:00" } });
    expect(matches(rule, makeSlot({ time: "07:30" }), "2026-07-15")).toBe(false);
  });

  it("gates on timeWindow (after end)", () => {
    const rule = baseRule({ timeWindow: { start: "06:00", end: "07:00" } });
    expect(matches(rule, makeSlot({ time: "07:30" }), "2026-07-15")).toBe(false);
  });

  it("gates on minSpots", () => {
    const rule = baseRule({ minSpots: 4 });
    expect(matches(rule, makeSlot({ spotsAvailable: 2 }), "2026-07-15")).toBe(false);
    expect(matches(rule, makeSlot({ spotsAvailable: 4 }), "2026-07-15")).toBe(true);
  });

  it("gates on minPlayers", () => {
    const rule = baseRule({ minPlayers: 3 });
    expect(matches(rule, makeSlot({ spotsAvailable: 2 }), "2026-07-15")).toBe(false);
    expect(matches(rule, makeSlot({ spotsAvailable: 3 }), "2026-07-15")).toBe(true);
  });

  it("gates on holes", () => {
    const rule = baseRule({ holes: 9 });
    expect(matches(rule, makeSlot({ holes: 18 }), "2026-07-15")).toBe(false);
    expect(matches(rule, makeSlot({ holes: 9 }), "2026-07-15")).toBe(true);
  });

  it("no filters configured beyond courseIds/dates -> matches anything on that course/date", () => {
    const rule = baseRule();
    expect(matches(rule, makeSlot({ spotsAvailable: 1, holes: 9, time: "23:59" }), "2026-07-15")).toBe(true);
  });
});

describe("runWatch: NEW / FREED detection", () => {
  it("emits an alert for a NEW slot (prev absent for that key, curr has spots)", async () => {
    const store = new ScriptedStore();
    const prevSlots = [makeSlot({ time: "07:30", spotsAvailable: 2 })];
    const currSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 2 }),
      makeSlot({ time: "08:00", spotsAvailable: 4 }), // brand new key
    ];
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    const rules = [baseRule()];
    const result = await runWatch(store, rules, sink);

    expect(result.alertsEmitted).toBe(1);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.transition).toBe("NEW");
    expect(sink.calls[0]?.slot.time).toBe("08:00");
  });

  it("emits an alert for a FREED slot (spots increased on an existing key)", async () => {
    const store = new ScriptedStore();
    const prevSlots = [makeSlot({ time: "07:30", spotsAvailable: 1 })];
    const currSlots = [makeSlot({ time: "07:30", spotsAvailable: 3 })];
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    const result = await runWatch(store, [baseRule()], sink);

    expect(result.alertsEmitted).toBe(1);
    expect(sink.calls[0]?.transition).toBe("FREED");
  });

  it("does NOT alert on FILLED, REMOVED, or SAME transitions", async () => {
    const store = new ScriptedStore();
    const prevSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 4 }), // -> FILLED
      makeSlot({ time: "08:00", spotsAvailable: 2 }), // -> REMOVED (absent in curr)
      makeSlot({ time: "08:30", spotsAvailable: 2 }), // -> SAME
    ];
    const currSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 2 }),
      makeSlot({ time: "08:30", spotsAvailable: 2 }),
    ];
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    const result = await runWatch(store, [baseRule()], sink);

    expect(result.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(0);
  });

  it("only alerts when the slot matches at least one rule (e.g. timeWindow gate)", async () => {
    const store = new ScriptedStore();
    const prevSlots: Slot[] = [];
    const currSlots = [makeSlot({ time: "23:00", spotsAvailable: 2 })];
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    const rule = baseRule({ timeWindow: { start: "06:00", end: "12:00" } });
    const result = await runWatch(store, [rule], sink);

    expect(result.alertsEmitted).toBe(0);
  });
});

describe("runWatch: idempotency across cycles", () => {
  it("the same curr snapshot on a second cycle does not re-emit", async () => {
    const store = new ScriptedStore();
    const prevSlots = [makeSlot({ time: "07:30", spotsAvailable: 1 })];
    const currSlots = [makeSlot({ time: "07:30", spotsAvailable: 3 })];
    // Same diff returned every call (steady state) -> exercises multi-cycle dedupe.
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    const rules = [baseRule()];
    const state = createWatchState();

    const r1 = await runWatch(store, rules, sink, { state });
    const r2 = await runWatch(store, rules, sink, { state });

    expect(r1.alertsEmitted).toBe(1);
    expect(r2.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(1);
  });

  it("state persisted via serialize/deserialize still suppresses a repeat alert", async () => {
    const store = new ScriptedStore();
    const prevSlots = [makeSlot({ time: "07:30", spotsAvailable: 1 })];
    const currSlots = [makeSlot({ time: "07:30", spotsAvailable: 3 })];
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    const rules = [baseRule()];

    const state1 = createWatchState();
    await runWatch(store, rules, sink, { state: state1 });
    const persisted = serializeWatchState(state1);

    // Simulate a fresh process rehydrating state from persisted storage.
    const state2: WatchState = deserializeWatchState(persisted);
    const result2 = await runWatch(store, rules, sink, { state: state2 });

    expect(result2.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(1);
  });
});

describe("runWatch: ghost slot (appear then disappear across cycles)", () => {
  it("does not leave a dangling or duplicate alert", async () => {
    const store = new ScriptedStore();
    // Cycle 1: cold start (prev absent) -> no alert, baseline seeded.
    const cycle1Curr = [makeSlot({ time: "07:30", spotsAvailable: 2 })];
    // Cycle 2: a ghost key appears (NEW) alongside the baseline slot.
    const cycle2Prev = cycle1Curr;
    const cycle2Curr = [
      makeSlot({ time: "07:30", spotsAvailable: 2 }),
      makeSlot({ time: "09:00", spotsAvailable: 1 }), // ghost
    ];
    // Cycle 3: the ghost vanishes again (REMOVED -> no alert transition).
    const cycle3Prev = cycle2Curr;
    const cycle3Curr = [makeSlot({ time: "07:30", spotsAvailable: 2 })];

    store.queue(
      "flemingdon",
      "2026-07-15",
      { curr: snap(cycle1Curr) }, // prev absent entirely (cold start)
      { prev: snap(cycle2Prev), curr: snap(cycle2Curr) },
      { prev: snap(cycle3Prev), curr: snap(cycle3Curr) },
    );

    const sink = new RecordingSink();
    const rules = [baseRule()];
    const state = createWatchState();

    const r1 = await runWatch(store, rules, sink, { state });
    const r2 = await runWatch(store, rules, sink, { state });
    const r3 = await runWatch(store, rules, sink, { state });

    expect(r1.alertsEmitted).toBe(0); // cold start
    expect(r2.alertsEmitted).toBe(1); // ghost's NEW
    expect(r3.alertsEmitted).toBe(0); // ghost's disappearance is REMOVED, not alerted

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.slot.time).toBe("09:00");

    // Running a 4th identical cycle (ghost still gone) must not resurrect anything.
    const r4 = await runWatch(store, rules, sink, { state });
    expect(r4.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(1);
  });
});

describe("runWatch: broken-curr guard", () => {
  it("curr undefined -> zero alerts, no mass-cancel storm", async () => {
    const store = new ScriptedStore();
    const prevSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 2 }),
      makeSlot({ time: "08:00", spotsAvailable: 3 }),
      makeSlot({ time: "08:30", spotsAvailable: 1 }),
    ];
    // curr is entirely absent this cycle (poll failed; store left prior snapshot intact,
    // but getSnapshotsForDiff for THIS call reports no curr).
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: undefined });

    const sink = new RecordingSink();
    const result = await runWatch(store, [baseRule()], sink);

    expect(result.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("curr and prev both undefined -> zero alerts", async () => {
    const store = new ScriptedStore();
    store.queue("flemingdon", "2026-07-15", {});

    const sink = new RecordingSink();
    const result = await runWatch(store, [baseRule()], sink);

    expect(result.alertsEmitted).toBe(0);
  });
});

describe("runWatch: cold-start guard", () => {
  it("prev undefined (first ever snapshot) -> zero alerts, baseline seeded (no NEW storm)", async () => {
    const store = new ScriptedStore();
    const currSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 2 }),
      makeSlot({ time: "08:00", spotsAvailable: 4 }),
      makeSlot({ time: "08:30", spotsAvailable: 1 }),
    ];
    store.queue("flemingdon", "2026-07-15", { curr: snap(currSlots) }); // prev absent

    const sink = new RecordingSink();
    const result = await runWatch(store, [baseRule()], sink);

    expect(result.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(0);
  });
});

describe("runWatch: alert message shape", () => {
  it("message is human-readable and names the transition, course, date, time", async () => {
    const store = new ScriptedStore();
    const currSlots = [makeSlot({ time: "07:30", spotsAvailable: 3 })];
    const prevSlots = [makeSlot({ time: "07:30", spotsAvailable: 1 })];
    store.queue("flemingdon", "2026-07-15", { prev: snap(prevSlots), curr: snap(currSlots) });

    const sink = new RecordingSink();
    await runWatch(store, [baseRule()], sink);

    const alert = sink.calls[0];
    expect(alert).toBeDefined();
    expect(alert!.message).toContain("flemingdon");
    expect(alert!.message).toContain("2026-07-15");
    expect(alert!.message).toContain("07:30");
    expect(alert!.courseId).toBe("flemingdon");
    expect(alert!.date).toBe("2026-07-15");
    expect(alert!.ruleId).toBe("rule-1");
  });
});

describe("runWatch: multiple rules / multiple courses isolation", () => {
  it("only watches (courseId,date) pairs implied by the rules, and matches per-rule", async () => {
    const store = new ScriptedStore();
    store.queue("flemingdon", "2026-07-15", {
      prev: snap([makeSlot({ courseId: "flemingdon", time: "07:30", spotsAvailable: 1 })]),
      curr: snap([makeSlot({ courseId: "flemingdon", time: "07:30", spotsAvailable: 5 })]),
    });
    store.queue("granite", "2026-07-16", {
      prev: snap([makeSlot({ courseId: "granite", date: "2026-07-16", time: "10:00", spotsAvailable: 1 })]),
      curr: snap([makeSlot({ courseId: "granite", date: "2026-07-16", time: "10:00", spotsAvailable: 6 })]),
    });

    const sink = new RecordingSink();
    const rules = [
      baseRule({ id: "rule-flemingdon", courseIds: ["flemingdon"], dates: ["2026-07-15"], minSpots: 2 }),
      baseRule({ id: "rule-granite", courseIds: ["granite"], dates: ["2026-07-16"], minSpots: 10 }),
    ];
    const result = await runWatch(store, rules, sink);

    // flemingdon's FREED (1->5) clears minSpots:2; granite's FREED (1->6) does NOT clear minSpots:10.
    expect(result.alertsEmitted).toBe(1);
    expect(sink.calls[0]?.courseId).toBe("flemingdon");
    expect(sink.calls[0]?.ruleId).toBe("rule-flemingdon");
  });
});

describe("runWatch: one broken (course,date) does not sink the rest of the cycle", () => {
  it("isolates a throwing pair and still processes the others", async () => {
    class ThrowingThenScriptedStore implements DiffSource {
      getSnapshotsForDiff(courseId: string, date: string): DiffSnapshots {
        if (courseId === "broken-course") {
          throw new Error("simulated store failure");
        }
        if (courseId === "flemingdon" && date === "2026-07-15") {
          return {
            prev: snap([makeSlot({ time: "07:30", spotsAvailable: 1 })]),
            curr: snap([makeSlot({ time: "07:30", spotsAvailable: 5 })]),
          };
        }
        return {};
      }
    }

    const store = new ThrowingThenScriptedStore();
    const sink = new RecordingSink();
    const rules = [
      baseRule({ id: "rule-broken", courseIds: ["broken-course"], dates: ["2026-07-15"] }),
      baseRule({ id: "rule-ok", courseIds: ["flemingdon"], dates: ["2026-07-15"] }),
    ];

    const result = await runWatch(store, rules, sink);

    expect(result.alertsEmitted).toBe(1);
    expect(sink.calls).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.courseId).toBe("broken-course");
  });
});
