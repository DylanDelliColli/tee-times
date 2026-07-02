import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import { MISS } from "../../src/store/store.js";
import { Poller, type AdapterMap } from "../../src/poller/poller.js";
import { RateLimiter } from "../../src/poller/rate-limiter.js";
import type { AvailabilityAdapter, BackendId } from "../../src/core/adapter.js";
import { AdapterError } from "../../src/core/errors.js";
import type { Slot } from "../../src/core/slot.js";

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

function stubAdapter(backendId: BackendId, impl: () => Promise<Slot[]>): AvailabilityAdapter {
  return { backendId, listSlots: impl };
}

// REAL SqliteAvailabilityStore against a temp file — not :memory:, not mocked.
// Mocking the DB here would defeat the point: we must prove empty-vs-broken and
// suppression semantics against the real persistence engine.
describe("Poller + real SqliteAvailabilityStore (integration)", () => {
  let dir: string;
  let dbPath: string;
  const openStores: SqliteAvailabilityStore[] = [];

  function openStore(): SqliteAvailabilityStore {
    const store = new SqliteAvailabilityStore(dbPath, { now: () => BASE });
    openStores.push(store);
    return store;
  }

  afterEach(() => {
    while (openStores.length > 0) {
      const s = openStores.pop()!;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDbPath(): void {
    dir = mkdtempSync(join(tmpdir(), "tee-times-poller-"));
    dbPath = join(dir, `availability-${randomUUID()}.sqlite3`);
  }

  function makePoller() {
    let clock = BASE;
    const limiter = new RateLimiter(
      { now: () => clock, sleep: async () => {}, jitter: () => 0 },
      {},
    );
    const poller = new Poller({ limiter, now: () => clock });
    return { poller, advance: (ms: number) => (clock += ms) };
  }

  it("full cycle: OK written, thrower's prior intact, blocked recorded, real [] distinct from MISS; blocked stays suppressed next cycle", async () => {
    freshDbPath();
    const store = openStore();
    const { poller } = makePoller();

    // Pre-seed a PRIOR snapshot for the course whose adapter will throw. We must
    // prove the failed poll leaves this untouched (never overwritten with []).
    const priorSlots = [makeSlot("glen-abbey", "tei-unify", { time: "06:00", spotsAvailable: 2 })];
    const PRIOR_FETCHED_AT = BASE - 60_000;
    store.putSnapshot("glen-abbey", DATE, priorSlots, PRIOR_FETCHED_AT);

    const okSlots = [makeSlot("lowville", "tee-on"), makeSlot("lowville", "tee-on", { time: "08:00" })];

    const teeOn = vi.fn(async () => okSlots); // OK
    const teiUnify = vi.fn(async () => {
      throw new AdapterError({ backendId: "tei-unify", courseId: "glen-abbey", kind: "parse", retryable: false });
    });
    const chronogolf = vi.fn(async () => {
      throw new AdapterError({ backendId: "chronogolf", courseId: "bantys-roost", kind: "blocked", retryable: false });
    });
    const clubhouse = vi.fn(async () => [] as Slot[]); // real "no tee times"

    const adapters: AdapterMap = {
      "tee-on": stubAdapter("tee-on", teeOn),
      "tei-unify": stubAdapter("tei-unify", teiUnify),
      chronogolf: stubAdapter("chronogolf", chronogolf),
      clubhouse: stubAdapter("clubhouse", clubhouse),
    };

    const courseIds = ["lowville", "glen-abbey", "bantys-roost", "upper-unionville"];
    const cycle1 = await poller.runCycle(adapters, store, { courseIds, dateWindow: [DATE] });

    // --- OK backend: healthy snapshot written ---
    const low = store.getSlots("lowville", DATE);
    expect(low).not.toBe(MISS);
    if (low === MISS) throw new Error("unreachable");
    expect(low.slots).toEqual(okSlots);
    expect(low.fetchedAt).toBe(BASE);
    expect(cycle1.health.get("tee-on")?.status).toBe("healthy");

    // --- Thrower (parse): PRIOR snapshot left completely intact ---
    const abbey = store.getSlots("glen-abbey", DATE);
    if (abbey === MISS) throw new Error("unreachable");
    expect(abbey.slots).toEqual(priorSlots);
    expect(abbey.fetchedAt).toBe(PRIOR_FETCHED_AT); // NOT overwritten
    expect(cycle1.health.get("tei-unify")?.status).toBe("unhealthy");

    // --- Blocked backend: recorded, nothing written (still MISS) ---
    expect(store.getSlots("bantys-roost", DATE)).toBe(MISS);
    expect(cycle1.health.get("chronogolf")?.status).toBe("blocked");

    // --- Real empty []: a genuine empty snapshot, DISTINCT from MISS ---
    const uu = store.getSlots("upper-unionville", DATE);
    expect(uu).not.toBe(MISS);
    if (uu === MISS) throw new Error("unreachable");
    expect(uu.slots).toEqual([]);
    expect(uu.fetchedAt).toBe(BASE);

    expect(teeOn).toHaveBeenCalledTimes(1);
    expect(chronogolf).toHaveBeenCalledTimes(1);

    // --- SECOND cycle, same day: blocked backend stays suppressed ---
    const cycle2 = await poller.runCycle(adapters, store, { courseIds, dateWindow: [DATE] });

    // The blocked backend's adapter is NOT called again (still 1 total).
    expect(chronogolf).toHaveBeenCalledTimes(1);
    const bantyDisp = cycle2.targets.find((t) => t.courseId === "bantys-roost")?.disposition;
    expect(bantyDisp).toBe("suppressed");
    expect(store.getSlots("bantys-roost", DATE)).toBe(MISS);

    // Healthy/empty backends keep polling normally on the second cycle.
    expect(teeOn).toHaveBeenCalledTimes(2);
    expect(clubhouse).toHaveBeenCalledTimes(2);
  });
});
