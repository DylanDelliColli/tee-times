import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import { MISS } from "../../src/store/store.js";
import type { Slot } from "../../src/core/slot.js";

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

// Real better-sqlite3 against a real temp DB FILE — not :memory:, not mocked.
// Mocking the database here would defeat the point: we need to prove actual
// persistence, reopen, and rotation semantics against the real engine.
describe("SqliteAvailabilityStore (integration, real file DB)", () => {
  let dir: string;
  let dbPath: string;
  const openStores: SqliteAvailabilityStore[] = [];

  function openStore(config: ConstructorParameters<typeof SqliteAvailabilityStore>[1] = {}) {
    const store = new SqliteAvailabilityStore(dbPath, config);
    openStores.push(store);
    return store;
  }

  afterEach(() => {
    while (openStores.length > 0) {
      const store = openStores.pop()!;
      try {
        store.close();
      } catch {
        // already closed, ignore
      }
    }
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDbPath(): void {
    dir = mkdtempSync(join(tmpdir(), "tee-times-store-"));
    dbPath = join(dir, `availability-${randomUUID()}.sqlite3`);
  }

  it("put -> read-back equal", () => {
    freshDbPath();
    const store = openStore();
    const slots = [makeSlot({ time: "07:30" }), makeSlot({ time: "08:00", spotsAvailable: 2 })];
    const fetchedAt = 1_700_000_000_000;
    store.putSnapshot("courseA", "2026-07-15", slots, fetchedAt);

    const result = store.getSlots("courseA", "2026-07-15");
    expect(result).not.toBe(MISS);
    if (result === MISS) throw new Error("unreachable");
    expect(result.fetchedAt).toBe(fetchedAt);
    expect(result.slots).toEqual(slots);
  });

  it("advance clock past TTL -> stale flag flips", () => {
    freshDbPath();
    let now = 1_700_000_000_000;
    const store = openStore({ ttlMs: 60_000, now: () => now });
    store.putSnapshot("courseA", "2026-07-15", [makeSlot()], now);

    const fresh = store.getSlots("courseA", "2026-07-15");
    if (fresh === MISS) throw new Error("unreachable");
    expect(fresh.stale).toBe(false);

    now += 60_001;
    const stale = store.getSlots("courseA", "2026-07-15");
    if (stale === MISS) throw new Error("unreachable");
    expect(stale.stale).toBe(true);
    expect(stale.slots).toHaveLength(1); // still served
  });

  it("putSnapshot twice -> prior retained; third put -> oldest dropped (exactly 2-deep)", () => {
    freshDbPath();
    const store = openStore();

    store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 1 })], 1000);
    let diff = store.getSnapshotsForDiff("courseA", "2026-07-15");
    expect(diff.prev).toBeUndefined();
    expect(diff.curr?.fetchedAt).toBe(1000);

    store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 2 })], 2000);
    diff = store.getSnapshotsForDiff("courseA", "2026-07-15");
    expect(diff.prev?.fetchedAt).toBe(1000);
    expect(diff.curr?.fetchedAt).toBe(2000);

    store.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 3 })], 3000);
    diff = store.getSnapshotsForDiff("courseA", "2026-07-15");
    // oldest (fetchedAt: 1000) is gone; exactly 2-deep retained
    expect(diff.prev?.fetchedAt).toBe(2000);
    expect(diff.curr?.fetchedAt).toBe(3000);
  });

  it("REOPEN the DB file in a new store instance -> data persists", () => {
    freshDbPath();
    const store1 = openStore();
    store1.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 5 })], 5000);
    store1.putSnapshot("courseA", "2026-07-15", [makeSlot({ spotsAvailable: 6 })], 6000);
    store1.close();
    openStores.pop(); // already closed above; drop from cleanup list

    const store2 = openStore();
    const result = store2.getSlots("courseA", "2026-07-15");
    expect(result).not.toBe(MISS);
    if (result === MISS) throw new Error("unreachable");
    expect(result.fetchedAt).toBe(6000);
    expect(result.slots[0]?.spotsAvailable).toBe(6);

    const diff = store2.getSnapshotsForDiff("courseA", "2026-07-15");
    expect(diff.prev?.fetchedAt).toBe(5000);
    expect(diff.curr?.fetchedAt).toBe(6000);
  });

  it("a read during/after a write returns a consistent snapshot", () => {
    freshDbPath();
    const store = openStore();
    const slotsA = [makeSlot({ spotsAvailable: 1 }), makeSlot({ time: "08:00", spotsAvailable: 2 })];
    store.putSnapshot("courseA", "2026-07-15", slotsA, 1000);

    // better-sqlite3 is synchronous: putSnapshot's rotate+insert transaction
    // fully completes before returning, so any subsequent read (there is no
    // async interleaving window in this process) must see either the fully
    // old state or the fully new state — never a partial rotation.
    const readsBeforeSecondWrite = store.getSlots("courseA", "2026-07-15");
    if (readsBeforeSecondWrite === MISS) throw new Error("unreachable");
    expect(readsBeforeSecondWrite.slots).toEqual(slotsA);

    const slotsB = [makeSlot({ spotsAvailable: 9 })];
    store.putSnapshot("courseA", "2026-07-15", slotsB, 2000);

    const readsAfterSecondWrite = store.getSlots("courseA", "2026-07-15");
    if (readsAfterSecondWrite === MISS) throw new Error("unreachable");
    expect(readsAfterSecondWrite.slots).toEqual(slotsB);
    expect(readsAfterSecondWrite.fetchedAt).toBe(2000);

    // Prior snapshot (rank 1) is fully consistent too — the complete slotsA
    // array, not some half-rotated fragment.
    const diff = store.getSnapshotsForDiff("courseA", "2026-07-15");
    expect(diff.prev?.slots).toEqual(slotsA);
    expect(diff.curr?.slots).toEqual(slotsB);
  });

  it("MISS on never-stored key even with a real on-disk file present", () => {
    freshDbPath();
    const store = openStore();
    store.putSnapshot("courseA", "2026-07-15", [makeSlot()], 1000);
    expect(store.getSlots("courseZ", "2026-07-15")).toBe(MISS);
  });
});
