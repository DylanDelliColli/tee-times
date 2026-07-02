// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cleanup, render, screen } from "@testing-library/react";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import { getCourse } from "../../src/core/courses.js";
import type { Slot } from "../../src/core/slot.js";
import type { SearchResult } from "../../src/search/search.js";
import { SearchResultsView } from "../../web/components/SearchResultsView.js";

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    courseId: "lowville",
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    // Reuse the course's own REAL registry bookingUrl for realism, so the
    // "resolves to the correct course host" assertion below is meaningful
    // rather than a placeholder-example.com URL.
    bookingUrl: getCourse("lowville")!.bookingUrl,
    ...overrides,
  };
}

/**
 * Integration test (real temp-file SqliteAvailabilityStore, real API route
 * handler — nothing mocked): seeds a healthy course, a stale course, and
 * leaves a registry EZLinks course unstored (deep-link-only), points the
 * route's store at the temp DB via the TEE_TIMES_DB_PATH env seam, invokes
 * the GET route handler directly with a constructed Request, then renders
 * the resulting SearchResult JSON through SearchResultsView via Testing
 * Library.
 */
describe("web/app/api/search route -> real seeded sqlite -> rendered SearchResultsView (integration)", () => {
  let dir: string;
  let dbPath: string;
  let originalDbPathEnv: string | undefined;
  // The route always uses a real Date.now() clock (it takes no injectable
  // clock config) — so staleness must be seeded relative to REAL wall time,
  // not an arbitrary fixed epoch. Captured fresh per test.
  let NOW: number;
  const TTL_MS = 15 * 60 * 1000; // matches DEFAULT_TTL_MS used by the route's store (no ttlMs override)
  const DATE = "2026-07-15";
  const openStores: SqliteAvailabilityStore[] = [];

  beforeEach(() => {
    NOW = Date.now();
    dir = mkdtempSync(join(tmpdir(), "tee-times-web-e2e-"));
    dbPath = join(dir, `availability-${randomUUID()}.sqlite3`);
    originalDbPathEnv = process.env.TEE_TIMES_DB_PATH;
    process.env.TEE_TIMES_DB_PATH = dbPath;
  });

  afterEach(() => {
    cleanup();
    while (openStores.length > 0) {
      const store = openStores.pop()!;
      try {
        store.close();
      } catch {
        // already closed, ignore
      }
    }
    if (originalDbPathEnv === undefined) {
      delete process.env.TEE_TIMES_DB_PATH;
    } else {
      process.env.TEE_TIMES_DB_PATH = originalDbPathEnv;
    }
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedStore(): void {
    // Seeding uses its own store handle against the same temp DB file the
    // route will open per-request (better-sqlite3 supports concurrent
    // read/write handles against the same file via WAL mode, matching how
    // store.integration.test.ts's "REOPEN" case exercises real persistence).
    const seedingStore = new SqliteAvailabilityStore(dbPath, { ttlMs: TTL_MS, now: () => NOW });
    openStores.push(seedingStore);

    // (A) healthy: "lowville" (real tee-on registry course), fresh snapshot.
    seedingStore.putSnapshot(
      "lowville",
      DATE,
      [
        makeSlot({ courseId: "lowville", time: "07:00", bookingUrl: getCourse("lowville")!.bookingUrl }),
        makeSlot({ courseId: "lowville", time: "14:00", bookingUrl: getCourse("lowville")!.bookingUrl }),
      ],
      NOW,
    );

    // (B) stale: "granite" (real tee-on registry course), snapshot older than TTL.
    seedingStore.putSnapshot(
      "granite",
      DATE,
      [makeSlot({ courseId: "granite", time: "09:00", bookingUrl: getCourse("granite")!.bookingUrl })],
      NOW - TTL_MS - 60_000, // ~16 min past TTL
    );

    // (C) deep-link-only: "lakeview" (real EZLinks registry course) is
    // deliberately left UNSTORED — MISS from the store, backend is
    // Cloudflare-blocked deep-link-only regardless.
  }

  it("merges healthy + stale real store data, sorted by time, with Book links resolving to the correct course host; deep-link-only course is never dropped; no auth UI", async () => {
    seedStore();

    // Dynamic import AFTER TEE_TIMES_DB_PATH is set, so the route module
    // reads the env var (via resolveDbPath()) fresh for this test rather
    // than picking up a stale value cached from a prior import.
    const { GET } = await import("../../web/app/api/search/route.js");

    const request = new Request(
      `http://localhost/api/search?date=${DATE}&courseIds=lowville,granite,lakeview`,
    );
    const response = await GET(request);
    expect(response.status).toBe(200);

    const result = (await response.json()) as SearchResult;

    // --- merged, time-sorted ---
    expect(result.slots.map((s) => `${s.courseId}@${s.time}`)).toEqual([
      "lowville@07:00",
      "granite@09:00",
      "lowville@14:00",
    ]);

    // --- Book links resolve to the correct course host ---
    for (const slot of result.slots) {
      const expectedHost = new URL(getCourse(slot.courseId)!.bookingUrl).hostname;
      const actualHost = new URL(slot.bookingUrl).hostname;
      expect(actualHost).toBe(expectedHost);
    }

    // --- per-course status: healthy / stale / deep-link-only ---
    const byId = Object.fromEntries(result.courses.map((c) => [c.courseId, c]));
    expect(byId.lowville?.state).toBe("healthy");
    expect(byId.granite?.state).toBe("stale");
    expect(byId.lakeview?.state).toBe("deep-link-only");
    expect(byId.lakeview?.deepLinkUrl).toBe(getCourse("lakeview")!.bookingUrl);

    // --- render the real API response through the actual view component ---
    render(<SearchResultsView result={result} now={NOW} />);

    const rows = screen.getAllByTestId("slot-row");
    expect(rows).toHaveLength(3);

    const bookLinks = screen.getAllByRole("link", { name: /book/i });
    expect(bookLinks.map((l) => l.getAttribute("href"))).toEqual(result.slots.map((s) => s.bookingUrl));

    // Stale badge present for granite.
    expect(screen.getByTestId("stale-badge").textContent).toMatch(/stale/i);

    // Deep-link-only ("check times ->") present for lakeview — never dropped.
    const deepLink = screen.getByRole("link", { name: /check times/i });
    expect(deepLink.getAttribute("href")).toBe(getCourse("lakeview")!.bookingUrl);

    // No auth/login UI anywhere in the rendered output.
    const { container } = render(<SearchResultsView result={result} now={NOW} />);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toMatch(/log in|log out|sign in|sign up|password|account/);
  });

  it("store-missing case: a fresh (never-seeded) DB path degrades to an empty-but-valid SearchResult, never a 500", async () => {
    // Point at a path whose parent directory doesn't exist yet AND has never
    // been seeded — exercises the route's mkdirSync + graceful-degrade path.
    const freshDir = mkdtempSync(join(tmpdir(), "tee-times-web-e2e-empty-"));
    const freshDbPath = join(freshDir, "nested", "availability.sqlite3");
    process.env.TEE_TIMES_DB_PATH = freshDbPath;

    try {
      const { GET } = await import("../../web/app/api/search/route.js");
      const request = new Request(`http://localhost/api/search?date=${DATE}`);
      const response = await GET(request);

      expect(response.status).toBe(200);
      const result = (await response.json()) as SearchResult;

      // Every registry course comes back deep-link-only (nothing ever
      // polled into this brand-new store) — a valid, non-empty course list
      // with an empty slot list, never a 500.
      expect(result.slots).toEqual([]);
      expect(result.courses.length).toBeGreaterThan(0);
      for (const status of result.courses) {
        expect(status.state).toBe("deep-link-only");
      }

      render(<SearchResultsView result={result} now={NOW} />);
      expect(screen.getByTestId("empty-state")).toBeTruthy();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
