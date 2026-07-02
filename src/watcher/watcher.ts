import { classifyChange, slotKey, type Slot } from "../core/slot.js";
import type { DiffSnapshots } from "../store/store.js";
import { matches, resolveRuleDates, type AlertRule } from "./rules.js";
import type { Alert, AlertTransition, NotificationSink } from "./sink.js";

/**
 * THE BRIGHT LINE: this module does NO network I/O. It only reads snapshots
 * the store already holds (via getSnapshotsForDiff) and never re-polls a
 * backend. Politeness/rate-limiting is enforced upstream, in the poller.
 *
 * The only store capability the watcher needs is getSnapshotsForDiff, so the
 * store parameter below is typed as that minimal slice rather than the full
 * AvailabilityStore — this makes the "read-only, diff-only" contract explicit
 * and keeps unit tests free of an unrelated stub surface.
 */
export interface DiffSource {
  getSnapshotsForDiff(courseId: string, date: string): DiffSnapshots;
}

/**
 * Idempotency state: the set of "slotKey::transition" strings already
 * emitted, ever. A slot transition is alerted AT MOST ONCE across the
 * lifetime of this state object, regardless of how many runWatch cycles
 * observe it.
 *
 * PERSISTENCE: the caller owns this object's lifetime, not the watcher.
 * - Within one long-lived process (e.g. a cron-driven loop that keeps a
 *   module-level WatchState), just keep reusing the same object across calls
 *   — runWatch mutates it in place.
 * - Across process restarts, serialize `Array.from(state.emitted)` to
 *   wherever you persist cross-run state (a DB row, a JSON file, etc.) and
 *   rehydrate with `deserializeWatchState(...)` on the next boot. See the
 *   `serializeWatchState` / `deserializeWatchState` helpers below.
 */
export interface WatchState {
  emitted: Set<string>;
}

/** Fresh, empty watch state — no transitions emitted yet. */
export function createWatchState(): WatchState {
  return { emitted: new Set() };
}

/** Flatten a WatchState into a plain string array for persistence (JSON, DB row, etc.). */
export function serializeWatchState(state: WatchState): string[] {
  return Array.from(state.emitted);
}

/** Rehydrate a WatchState from a previously-serialized string array. */
export function deserializeWatchState(keys: readonly string[]): WatchState {
  return { emitted: new Set(keys) };
}

export interface WatchOptions {
  /** Idempotency state to read/mutate across calls. Defaults to a fresh (empty) state if omitted. */
  state?: WatchState;
}

export interface WatchError {
  courseId: string;
  date: string;
  error: unknown;
}

export interface WatchResult {
  alertsEmitted: number;
  /** Per-(courseId,date) failures that were isolated rather than sinking the whole cycle. */
  errors: WatchError[];
}

/**
 * Run one watch cycle: for every (courseId, date) implied by `rules`, diff
 * the store's prev/curr snapshot pair, and alert on NEW/FREED slots that
 * match at least one rule — subject to the cold-start guard, the
 * broken-curr guard, and cross-cycle idempotency.
 */
export async function runWatch(
  store: DiffSource,
  rules: AlertRule[],
  sink: NotificationSink,
  opts: WatchOptions = {},
): Promise<WatchResult> {
  const state = opts.state ?? createWatchState();
  const pairs = watchedPairs(rules);

  let alertsEmitted = 0;
  const errors: WatchError[] = [];

  for (const { courseId, date } of pairs) {
    try {
      const emittedHere = await processPair(store, rules, sink, state, courseId, date);
      alertsEmitted += emittedHere;
    } catch (error) {
      // One (course,date)'s broken/errored data must never sink the rest of
      // the watch cycle — isolate it and keep going.
      errors.push({ courseId, date, error });
    }
  }

  return { alertsEmitted, errors };
}

/** Every distinct (courseId, date) pair any rule watches, deduplicated. */
function watchedPairs(rules: AlertRule[]): Array<{ courseId: string; date: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ courseId: string; date: string }> = [];
  for (const rule of rules) {
    const dates = resolveRuleDates(rule);
    for (const courseId of rule.courseIds) {
      for (const date of dates) {
        const key = `${courseId}|${date}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ courseId, date });
        }
      }
    }
  }
  return pairs;
}

/** Diff + alert for a single (courseId, date). Returns the number of alerts emitted. */
async function processPair(
  store: DiffSource,
  rules: AlertRule[],
  sink: NotificationSink,
  state: WatchState,
  courseId: string,
  date: string,
): Promise<number> {
  const diff = store.getSnapshotsForDiff(courseId, date);

  // BROKEN-CURR GUARD: no curr snapshot this cycle (poll failed/errored and
  // the store left the prior snapshot intact). No curr => no NEW/FREED is
  // even possible, so bail out explicitly rather than ever treating every
  // prev slot as vanished/cancelled.
  if (!diff.curr) {
    return 0;
  }

  // COLD-START GUARD: no prev snapshot means this is the very first snapshot
  // ever stored for this (courseId, date). curr IS the baseline — do not
  // alert on the whole current sheet as if every slot just appeared.
  if (!diff.prev) {
    return 0;
  }

  const prevByKey = indexByKey(diff.prev.slots);
  const currByKey = indexByKey(diff.curr.slots);

  let emitted = 0;
  for (const [key, currSlot] of currByKey) {
    const prevSlot = prevByKey.get(key);
    const transition = classifyChange(prevSlot, currSlot);
    if (transition !== "NEW" && transition !== "FREED") {
      continue;
    }

    const matchedRule = rules.find((rule) => matches(rule, currSlot, date));
    if (!matchedRule) {
      continue;
    }

    const emittedKey = `${key}::${transition}`;
    if (state.emitted.has(emittedKey)) {
      // IDEMPOTENCY: this exact (slotKey, transition) already fired in a
      // prior cycle. Never emit it twice — this is also what keeps a
      // ghost (appear then disappear then reappear identically) from
      // producing a dangling/duplicate alert.
      continue;
    }

    const alert: Alert = {
      courseId,
      date,
      slot: currSlot,
      transition,
      ruleId: matchedRule.id,
      message: buildMessage(currSlot, transition),
    };

    await sink.send(alert);
    state.emitted.add(emittedKey);
    emitted += 1;
  }

  return emitted;
}

function indexByKey(slots: Slot[]): Map<string, Slot> {
  const map = new Map<string, Slot>();
  for (const slot of slots) {
    map.set(slotKey(slot), slot);
  }
  return map;
}

function buildMessage(slot: Slot, transition: AlertTransition): string {
  const verb = transition === "NEW" ? "New tee time available" : "Spot opened up (cancellation)";
  return `${verb}: ${slot.courseId} on ${slot.date} at ${slot.time} (${slot.holes} holes, ${slot.spotsAvailable} spot${slot.spotsAvailable === 1 ? "" : "s"} open)`;
}
