import type { Slot } from "../core/slot.js";

/**
 * A single poll's worth of normalized slots for one (courseId, date), plus
 * when it was fetched. This is what gets written on every poll and read back
 * by both search (fresh reads) and the watcher (diffing).
 */
export interface Snapshot {
  /** Normalized slots as returned by the adapter for this course/date. */
  slots: Slot[];
  /** Epoch-ms timestamp of when this snapshot was fetched. */
  fetchedAt: number;
}

/**
 * getSlots() result for a snapshot that DOES exist. `stale` is derived from
 * the store's configured TTL at read time — a stale snapshot is still
 * returned (never silently dropped); callers decide what to do with it.
 */
export interface SnapshotResult extends Snapshot {
  stale: boolean;
}

/**
 * Sentinel for "no snapshot has EVER been stored for this (courseId, date)".
 * This is deliberately a distinct, unique-symbol value — never `null`,
 * `undefined`, or an empty-slots snapshot — because an empty snapshot
 * ({slots: [], fetchedAt, stale}) is a legitimate, meaningful result: it means
 * "we polled and there really are no tee times." Conflating the two would
 * make it impossible for the watcher/search layer to tell "never checked"
 * apart from "checked, found nothing."
 *
 * A unique symbol (rather than a `{kind: 'miss'}` object) is used deliberately
 * so `result === MISS` narrows `GetSlotsResult` correctly under TypeScript's
 * control-flow analysis — plain-object equality does not narrow unions.
 *
 * Usage: `const r = store.getSlots(c, d); if (r === MISS) { ... }`
 */
export const MISS: unique symbol = Symbol("AvailabilityStore.MISS");
export type Miss = typeof MISS;

/** Result type for getSlots(): either a real snapshot result, or the MISS sentinel. */
export type GetSlotsResult = SnapshotResult | Miss;

/**
 * The two-deep view of a (courseId, date)'s history that the watcher diffs.
 * `curr` is the latest snapshot; `prev` is the one immediately before it
 * (if any). Both may be absent if nothing has been stored yet, and `prev`
 * will be absent after exactly one putSnapshot call.
 *
 * The slots in `curr`/`prev` round-trip exactly as passed to putSnapshot, so
 * pairing them by slotKey and calling classifyChange(prevSlot, currSlot)
 * (see src/core/slot.ts) works directly off this output.
 */
export interface DiffSnapshots {
  prev?: Snapshot;
  curr?: Snapshot;
}

/** One (courseId, date) pair the poller should fetch. */
export interface CoursePollTarget {
  courseId: string;
  date: string;
}

/**
 * Constructor options for an AvailabilityStore implementation.
 * TTL is config-driven (gap G5) rather than hardcoded, so callers (and tests)
 * can tune/override it; `now` is an injectable clock for deterministic TTL
 * tests without real sleeps.
 */
export interface AvailabilityStoreConfig {
  /** Snapshot freshness window in ms. A snapshot older than this is `stale`. Default: 15 minutes. */
  ttlMs?: number;
  /** Clock override, defaults to Date.now. Inject a fake clock in tests. */
  now?: () => number;
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * The poll-cache spine both search (fresh/stale reads) and the watcher
 * (snapshot diffing) read from. Implementations must retain EXACTLY 2 deep
 * (current + prior) per (courseId, date) — gap G6 — and must distinguish
 * MISS from an empty snapshot (see {@link MISS}).
 */
export interface AvailabilityStore {
  /**
   * Write the current snapshot for (courseId, date), rotating the previous
   * "current" into "prior". Retains exactly 2 deep per (courseId, date): a
   * third put drops the oldest (the prior one before rotation).
   */
  putSnapshot(courseId: string, date: string, slots: Slot[], fetchedAt: number | Date): void;

  /**
   * Read the latest snapshot for (courseId, date).
   * Returns {@link MISS} if nothing has ever been stored for this key.
   * Returns a SnapshotResult (possibly with slots: []) otherwise, with
   * `stale` set if `fetchedAt` is older than the configured TTL. Stale
   * snapshots are still returned, never dropped.
   */
  getSlots(courseId: string, date: string): GetSlotsResult;

  /**
   * Read the two-deep history (prev/curr) for (courseId, date), for the
   * watcher to diff via classifyChange. Both fields are optional: absent
   * entirely before any put, `prev` absent after exactly one put.
   */
  getSnapshotsForDiff(courseId: string, date: string): DiffSnapshots;

  /**
   * Cross the given course id set with the given date window to produce the
   * poll worklist.
   *
   * DI SEAM: src/core/courses.ts (the course registry) is owned by a
   * parallel worker and may not exist in this worktree yet. Rather than
   * import it here and create a hard build dependency, this method takes
   * the course id list and date window as explicit parameters — the caller
   * (eventually the real poller, wired against courses.ts) is responsible
   * for sourcing them. This keeps AvailabilityStore testable standalone and
   * decoupled from the registry's shape.
   */
  listCoursesToPoll(courseIds: readonly string[], dateWindow: readonly string[]): CoursePollTarget[];

  /** Release underlying resources (e.g. close the DB handle). */
  close(): void;
}

/**
 * Pure cross-product helper backing `listCoursesToPoll` on implementations.
 * Exported standalone so it can be unit-tested and reused without a store
 * instance. See the DI SEAM note on {@link AvailabilityStore.listCoursesToPoll}.
 */
export function crossCoursesWithDateWindow(
  courseIds: readonly string[],
  dateWindow: readonly string[],
): CoursePollTarget[] {
  const out: CoursePollTarget[] = [];
  for (const courseId of courseIds) {
    for (const date of dateWindow) {
      out.push({ courseId, date });
    }
  }
  return out;
}
