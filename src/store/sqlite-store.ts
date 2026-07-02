import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Slot } from "../core/slot.js";
import {
  MISS,
  DEFAULT_TTL_MS,
  crossCoursesWithDateWindow,
  type AvailabilityStore,
  type AvailabilityStoreConfig,
  type CoursePollTarget,
  type DiffSnapshots,
  type GetSlotsResult,
  type Snapshot,
} from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

interface SnapshotRow {
  course_id: string;
  date: string;
  rank: number;
  slots_json: string;
  fetched_at: number;
}

/**
 * better-sqlite3-backed AvailabilityStore. better-sqlite3 is synchronous, so
 * every method here runs to completion (including the multi-statement
 * rotate-and-insert in putSnapshot, wrapped in a transaction) before
 * returning control — there is no interleaving window where a concurrent
 * read could observe a half-written snapshot.
 */
export class SqliteAvailabilityStore implements AvailabilityStore {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private readonly stmtDeletePrior: Database.Statement;
  private readonly stmtRotateCurrentToPrior: Database.Statement;
  private readonly stmtInsertCurrent: Database.Statement;
  private readonly stmtSelectByRank: Database.Statement;
  private readonly stmtSelectBoth: Database.Statement;
  private readonly putTxn: (courseId: string, date: string, slotsJson: string, fetchedAt: number) => void;

  constructor(dbPath: string, config: AvailabilityStoreConfig = {}) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.now = config.now ?? Date.now;

    const schema = readFileSync(SCHEMA_PATH, "utf8");
    this.db.exec(schema);

    this.stmtDeletePrior = this.db.prepare(
      "DELETE FROM snapshots WHERE course_id = ? AND date = ? AND rank = 1",
    );
    this.stmtRotateCurrentToPrior = this.db.prepare(
      "UPDATE snapshots SET rank = 1 WHERE course_id = ? AND date = ? AND rank = 0",
    );
    this.stmtInsertCurrent = this.db.prepare(
      "INSERT INTO snapshots (course_id, date, rank, slots_json, fetched_at) VALUES (?, ?, 0, ?, ?)",
    );
    this.stmtSelectByRank = this.db.prepare(
      "SELECT course_id, date, rank, slots_json, fetched_at FROM snapshots WHERE course_id = ? AND date = ? AND rank = ?",
    );
    this.stmtSelectBoth = this.db.prepare(
      "SELECT course_id, date, rank, slots_json, fetched_at FROM snapshots WHERE course_id = ? AND date = ? ORDER BY rank ASC",
    );

    this.putTxn = this.db.transaction((courseId: string, date: string, slotsJson: string, fetchedAt: number) => {
      // Drop the oldest retained snapshot (the current prior), rotate the
      // current snapshot into the prior slot, then insert the new current.
      // Net effect across repeated calls: exactly 2-deep retention (G6).
      this.stmtDeletePrior.run(courseId, date);
      this.stmtRotateCurrentToPrior.run(courseId, date);
      this.stmtInsertCurrent.run(courseId, date, slotsJson, fetchedAt);
    });
  }

  putSnapshot(courseId: string, date: string, slots: Slot[], fetchedAt: number | Date): void {
    const fetchedAtMs = fetchedAt instanceof Date ? fetchedAt.getTime() : fetchedAt;
    const slotsJson = JSON.stringify(slots);
    this.putTxn(courseId, date, slotsJson, fetchedAtMs);
  }

  getSlots(courseId: string, date: string): GetSlotsResult {
    const row = this.stmtSelectByRank.get(courseId, date, 0) as SnapshotRow | undefined;
    if (!row) {
      return MISS;
    }
    const slots = JSON.parse(row.slots_json) as Slot[];
    const stale = this.now() - row.fetched_at > this.ttlMs;
    return { slots, fetchedAt: row.fetched_at, stale };
  }

  getSnapshotsForDiff(courseId: string, date: string): DiffSnapshots {
    const rows = this.stmtSelectBoth.all(courseId, date) as SnapshotRow[];
    const result: DiffSnapshots = {};
    for (const row of rows) {
      const snapshot: Snapshot = {
        slots: JSON.parse(row.slots_json) as Slot[],
        fetchedAt: row.fetched_at,
      };
      if (row.rank === 0) {
        result.curr = snapshot;
      } else if (row.rank === 1) {
        result.prev = snapshot;
      }
    }
    return result;
  }

  listCoursesToPoll(courseIds: readonly string[], dateWindow: readonly string[]): CoursePollTarget[] {
    return crossCoursesWithDateWindow(courseIds, dateWindow);
  }

  close(): void {
    this.db.close();
  }
}
