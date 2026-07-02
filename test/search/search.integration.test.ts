import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import type { AvailabilityStore, CoursePollTarget, DiffSnapshots, GetSlotsResult } from "../../src/store/store.js";
import type { Slot } from "../../src/core/slot.js";
import { search } from "../../src/search/search.js";
import { getCourse } from "../../src/core/courses.js";

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

/**
 * Spy wrapper counting every call made against the real store, so the test
 * can PROVE search() never triggers a write/poll path (putSnapshot,
 * listCoursesToPoll) and only ever performs reads (getSlots). This is the
 * runtime half of the load-bearing "never live-fetches" assertion — the
 * static half (search.ts imports no adapter code at all) is asserted below.
 */
function wrapWithCallCounts(store: AvailabilityStore) {
  const calls = {
    getSlots: 0,
    putSnapshot: 0,
    getSnapshotsForDiff: 0,
    listCoursesToPoll: 0,
    close: 0,
  };

  const proxy: AvailabilityStore = {
    getSlots(courseId: string, date: string): GetSlotsResult {
      calls.getSlots += 1;
      return store.getSlots(courseId, date);
    },
    putSnapshot(courseId: string, date: string, slots: Slot[], fetchedAt: number | Date): void {
      calls.putSnapshot += 1;
      store.putSnapshot(courseId, date, slots, fetchedAt);
    },
    getSnapshotsForDiff(courseId: string, date: string): DiffSnapshots {
      calls.getSnapshotsForDiff += 1;
      return store.getSnapshotsForDiff(courseId, date);
    },
    listCoursesToPoll(courseIds: readonly string[], dateWindow: readonly string[]): CoursePollTarget[] {
      calls.listCoursesToPoll += 1;
      return store.listCoursesToPoll(courseIds, dateWindow);
    },
    close(): void {
      calls.close += 1;
      store.close();
    },
  };

  return { proxy, calls };
}

// Real SqliteAvailabilityStore against a real temp DB FILE — not mocked. The
// point of this suite is to prove search() is served ENTIRELY from the store
// (tradeoff #4): mocking the database here would defeat that purpose.
describe("search (integration, real file-backed SqliteAvailabilityStore)", () => {
  let dir: string;
  let dbPath: string;
  const openStores: SqliteAvailabilityStore[] = [];
  const NOW = 1_800_000_000_000;
  const TTL_MS = 15 * 60 * 1000;

  function openStore(): SqliteAvailabilityStore {
    const store = new SqliteAvailabilityStore(dbPath, { ttlMs: TTL_MS, now: () => NOW });
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
    dir = mkdtempSync(join(tmpdir(), "tee-times-search-"));
    dbPath = join(dir, `availability-${randomUUID()}.sqlite3`);
  }

  it("differentiates healthy / stale / deep-link-only across 3 seeded course states, served entirely from the store (adapter-call-count === 0)", () => {
    freshDbPath();
    const store = openStore();
    const date = "2026-07-15";

    // (A) healthy: fresh snapshot, well within TTL.
    store.putSnapshot("lowville", date, [makeSlot({ courseId: "lowville", time: "08:00" })], NOW);

    // (B) stale: snapshot exists but is older than the configured TTL.
    store.putSnapshot(
      "granite",
      date,
      [makeSlot({ courseId: "granite", time: "09:00" })],
      NOW - TTL_MS - 1,
    );

    // (C) deep-link-only: "lakeview" is a registry EZLinks course — never
    // stored (Cloudflare-blocked, no live scrape per THE BRIGHT LINE), so the
    // store is MISS for it regardless of TTL.

    const { proxy, calls } = wrapWithCallCounts(store);

    const result = search({ date, courseIds: ["lowville", "granite", "lakeview"] }, proxy);

    // --- CRITICAL LOAD-BEARING ASSERTION (tradeoff #4) ---
    // search() never writes to or polls the store — it only reads. If it had
    // performed (or triggered) any live fetch, that fetch's result would have
    // to land in the store via putSnapshot/listCoursesToPoll; those counts
    // must be exactly zero.
    expect(calls.putSnapshot).toBe(0);
    expect(calls.listCoursesToPoll).toBe(0);
    expect(calls.getSnapshotsForDiff).toBe(0);
    expect(calls.getSlots).toBeGreaterThan(0); // it DOES read from the store

    // --- 3-state differentiation ---
    const byId = Object.fromEntries(result.courses.map((c) => [c.courseId, c]));
    expect(byId.lowville?.state).toBe("healthy");
    expect(byId.granite?.state).toBe("stale");
    expect(byId.lakeview?.state).toBe("deep-link-only");
    expect(byId.lakeview?.deepLinkUrl).toBeTruthy();
    expect(byId.lowville?.deepLinkUrl).toBeUndefined();
    expect(byId.granite?.deepLinkUrl).toBeUndefined();

    // fetchedAt (tee-times-npr staleness-age support): populated for
    // healthy/stale (real store-backed data), absent for deep-link-only
    // (no store data exists at all for that course).
    expect(byId.lowville?.fetchedAt).toBe(NOW);
    expect(byId.granite?.fetchedAt).toBe(NOW - TTL_MS - 1);
    expect(byId.lakeview?.fetchedAt).toBeUndefined();

    // Stale and healthy courses both still surface their real slots (never dropped).
    expect(result.slots.map((s) => s.courseId).sort()).toEqual(["granite", "lowville"]);
  });

  it("search.ts contains no import from the adapter module and never calls listSlots (structural half of the never-live-fetch invariant)", () => {
    const searchSrcPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "search",
      "search.ts",
    );
    const source = readFileSync(searchSrcPath, "utf8");

    // No import of the adapter module (by relative path) anywhere in this file.
    expect(source).not.toMatch(/from\s+["'][^"']*\/core\/adapter\.js["']/);
    // No adapter invocation.
    expect(source).not.toMatch(/\.listSlots\(/);
  });

  it("all-degraded across real store + registry: both EZLinks courses come back deep-link-only with an empty slot list", () => {
    freshDbPath();
    const store = openStore();

    const result = search({ date: "2026-07-15", courseIds: ["lakeview", "braeben"] }, store);

    expect(result.slots).toEqual([]);
    expect(result.courses.map((c) => c.state)).toEqual(["deep-link-only", "deep-link-only"]);
    for (const status of result.courses) {
      expect(status.deepLinkUrl).toBeTruthy();
      // tee-times-3rj: deepLinkUrl must be the course's REAL registry
      // bookingUrl, not just a truthy placeholder — never live-polled either
      // (proven above via calls.putSnapshot/listCoursesToPoll === 0).
      expect(status.deepLinkUrl).toBe(getCourse(status.courseId)!.bookingUrl);
    }
  });
});
