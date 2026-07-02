import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import type { Slot } from "../../src/core/slot.js";
import type { AlertRule } from "../../src/watcher/rules.js";
import type { Alert, NotificationSink } from "../../src/watcher/sink.js";
import { createWatchState, runWatch } from "../../src/watcher/watcher.js";

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

class RecordingSink implements NotificationSink {
  calls: Alert[] = [];
  send(alert: Alert): void {
    this.calls.push(alert);
  }
}

// REAL SqliteAvailabilityStore against a real temp DB file (not mocked, not
// :memory:) + a stub sink that records calls. This exercises runWatch against
// the actual storage engine's rotate/retain semantics, not a fake.
describe("watcher (integration, real SqliteAvailabilityStore + stub sink)", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteAvailabilityStore;

  function freshStore(): SqliteAvailabilityStore {
    dir = mkdtempSync(join(tmpdir(), "tee-times-watcher-"));
    dbPath = join(dir, `availability-${randomUUID()}.sqlite3`);
    store = new SqliteAvailabilityStore(dbPath);
    return store;
  }

  afterEach(() => {
    try {
      store?.close();
    } catch {
      // already closed, ignore
    }
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("putSnapshot prev then curr with a genuine NEW and a genuine FREED slot -> sink.send called exactly for the matching slots", async () => {
    const s = freshStore();

    // prev: two existing bookable slots.
    const prevSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 1 }), // will FREE to 3
      makeSlot({ time: "08:00", spotsAvailable: 2 }), // will stay SAME
    ];
    s.putSnapshot("flemingdon", "2026-07-15", prevSlots, 1_000);

    // curr: 07:30 freed up, 08:00 unchanged, 09:00 is a brand new key.
    const currSlots = [
      makeSlot({ time: "07:30", spotsAvailable: 3 }), // FREED
      makeSlot({ time: "08:00", spotsAvailable: 2 }), // SAME
      makeSlot({ time: "09:00", spotsAvailable: 4 }), // NEW
    ];
    s.putSnapshot("flemingdon", "2026-07-15", currSlots, 2_000);

    const sink = new RecordingSink();
    const rules: AlertRule[] = [{ id: "watch-flemingdon", courseIds: ["flemingdon"], dates: ["2026-07-15"] }];
    const state = createWatchState();

    const result = await runWatch(s, rules, sink, { state });

    expect(result.alertsEmitted).toBe(2);
    expect(sink.calls).toHaveLength(2);

    const byTime = new Map(sink.calls.map((a) => [a.slot.time, a]));
    expect(byTime.get("07:30")?.transition).toBe("FREED");
    expect(byTime.get("09:00")?.transition).toBe("NEW");
    expect(byTime.has("08:00")).toBe(false); // SAME never alerted

    const expectedKeys = new Set(["flemingdon|2026-07-15|07:30|18", "flemingdon|2026-07-15|09:00|18"]);
    const gotKeys = new Set(
      sink.calls.map((a) => `${a.slot.courseId}|${a.slot.date}|${a.slot.time}|${a.slot.holes}`),
    );
    expect(gotKeys).toEqual(expectedKeys);

    // Second cycle with the SAME curr (no new putSnapshot) -> no new sink calls;
    // multi-cycle dedupe holds against the real store.
    const result2 = await runWatch(s, rules, sink, { state });
    expect(result2.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(2);
  });

  it("cold start against the real store: a single putSnapshot never produces alerts", async () => {
    const s = freshStore();
    s.putSnapshot(
      "flemingdon",
      "2026-07-16",
      [makeSlot({ date: "2026-07-16", time: "07:30", spotsAvailable: 4 })],
      1_000,
    );

    const sink = new RecordingSink();
    const rules: AlertRule[] = [{ id: "watch-flemingdon", courseIds: ["flemingdon"], dates: ["2026-07-16"] }];
    const result = await runWatch(s, rules, sink);

    expect(result.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(0);
  });

  it("broken-curr guard against the real store: MISS-shaped (courseId,date) with no snapshots at all yields zero alerts", async () => {
    const s = freshStore();
    const sink = new RecordingSink();
    const rules: AlertRule[] = [{ id: "watch-none", courseIds: ["never-polled"], dates: ["2026-07-15"] }];

    const result = await runWatch(s, rules, sink);

    expect(result.alertsEmitted).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("a third putSnapshot (store rotates to exactly 2-deep) still diffs correctly and stays idempotent", async () => {
    const s = freshStore();
    s.putSnapshot("flemingdon", "2026-07-15", [makeSlot({ time: "07:30", spotsAvailable: 1 })], 1_000);
    s.putSnapshot("flemingdon", "2026-07-15", [makeSlot({ time: "07:30", spotsAvailable: 1 })], 2_000);

    const sink = new RecordingSink();
    const rules: AlertRule[] = [{ id: "watch-flemingdon", courseIds: ["flemingdon"], dates: ["2026-07-15"] }];
    const state = createWatchState();

    // prev=1@1000 curr=1@2000 -> SAME, no alert.
    const r1 = await runWatch(s, rules, sink, { state });
    expect(r1.alertsEmitted).toBe(0);

    // Third put: rotates again -> prev=1@2000, curr=3@3000 -> FREED.
    s.putSnapshot("flemingdon", "2026-07-15", [makeSlot({ time: "07:30", spotsAvailable: 3 })], 3_000);
    const r2 = await runWatch(s, rules, sink, { state });
    expect(r2.alertsEmitted).toBe(1);
    expect(sink.calls[0]?.transition).toBe("FREED");

    // Re-running against the same (unchanged) curr must not re-emit.
    const r3 = await runWatch(s, rules, sink, { state });
    expect(r3.alertsEmitted).toBe(0);
    expect(sink.calls).toHaveLength(1);
  });
});
