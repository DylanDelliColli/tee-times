import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteAvailabilityStore } from "../../src/store/sqlite-store.js";
import type { AvailabilityStore } from "../../src/store/store.js";
import type { SearchQuery } from "../../src/search/search.js";

/**
 * Helpers for web/app/api/search/route.ts, kept in a separate module
 * (rather than exported from route.ts itself) because Next.js's App Router
 * route-handler type validator only allows a fixed set of named exports
 * (GET/POST/etc. plus `runtime`/`dynamic`/...) from a route.ts file — any
 * other named export fails `next build`'s type check with "... is not a
 * valid Route export field".
 */

const DEFAULT_DB_PATH = "./data/availability.sqlite3";

/**
 * DB path is configurable via env (TEE_TIMES_DB_PATH) rather than hardcoded,
 * so tests (and the eventual deploy bead, tee-times-4z7) can point the route
 * at any SqliteAvailabilityStore file without touching source.
 */
export function resolveDbPath(): string {
  const configured = process.env.TEE_TIMES_DB_PATH?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_DB_PATH;
}

export function openStore(): AvailabilityStore {
  const dbPath = resolveDbPath();
  if (dbPath !== ":memory:") {
    // better-sqlite3 creates the DB FILE itself if missing, but not missing
    // parent directories — ensure those exist so a fresh checkout / first
    // deploy (no poller has ever run yet) opens an empty, valid, readable
    // store rather than throwing ENOENT.
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  return new SqliteAvailabilityStore(dbPath);
}

/**
 * Parses URL search params into a SearchQuery.
 *
 * PRODUCT DEFAULT (documented, not blocking): search() requires exactly one
 * of `date` / `dateRange`. Rather than 400 when a caller (e.g. the bare page
 * load, before the user has touched the form) supplies neither, this
 * defaults to "today" (UTC calendar date) — a sensible default for a
 * same-day tee-time search tool.
 */
export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const query: SearchQuery = {};

  const date = params.get("date");
  const rangeStart = params.get("rangeStart");
  const rangeEnd = params.get("rangeEnd");

  if (date) {
    query.date = date;
  } else if (rangeStart && rangeEnd) {
    query.dateRange = { start: rangeStart, end: rangeEnd };
  } else {
    query.date = new Date().toISOString().slice(0, 10);
  }

  const timeStart = params.get("timeStart");
  const timeEnd = params.get("timeEnd");
  if (timeStart && timeEnd) {
    query.timeWindow = { start: timeStart, end: timeEnd };
  }

  const playersParam = params.get("players");
  if (playersParam) {
    const players = Number(playersParam);
    if (Number.isFinite(players) && players > 0) {
      query.players = players;
    }
  }

  const holesParam = params.get("holes");
  if (holesParam === "9" || holesParam === "18") {
    query.holes = Number(holesParam) as 9 | 18;
  }

  const courseIdsParam = params.get("courseIds");
  if (courseIdsParam) {
    const courseIds = courseIdsParam
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (courseIds.length > 0) {
      query.courseIds = courseIds;
    }
  }

  return query;
}
