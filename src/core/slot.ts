import { z } from "zod";
import type { BackendId } from "./adapter.js";

/**
 * A normalized, bookable tee-time slot. This is the ONE shape every adapter
 * emits and every store/UI consumes — no backend-shaped data escapes an adapter
 * (invariant I1 in adapter.ts).
 *
 * Fields:
 * - courseId        : our stable registry id for the course (not the backend's).
 * - backendId       : which backend produced this slot.
 * - date            : course-local calendar date, "YYYY-MM-DD".
 * - time            : course-local wall-clock start time, "HH:MM" (24h, zero-padded).
 * - holes           : 9 or 18.
 * - spotsAvailable  : integer count of open player spots. An ATTRIBUTE, not part
 *                     of slot identity (gap G1). 0 means the slot is no longer
 *                     bookable (treated as REMOVED by classifyChange).
 * - price           : optional price in the course's currency (major units).
 * - bookingUrl      : deep link to THIS course's own booking page (invariant I3).
 * - raw             : optional opaque backend payload, retained for debugging.
 */
const backendIdSchema = z.enum([
  "tee-on",
  "ezlinks",
  "chronogolf",
  "tei-unify",
  "clubhouse",
]);

export const SlotSchema = z
  .object({
    courseId: z.string().min(1),
    backendId: backendIdSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
    time: z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM (24h)"),
    holes: z.union([z.literal(9), z.literal(18)]),
    spotsAvailable: z.number().int().nonnegative(),
    price: z.number().nonnegative().optional(),
    bookingUrl: z.string().url(),
    raw: z.unknown().optional(),
  })
  .strict();

export type Slot = z.infer<typeof SlotSchema>;

// Compile-time assurance that Slot.backendId stays in lockstep with BackendId.
const _backendIdAlign: BackendId = "tee-on" satisfies Slot["backendId"];
void _backendIdAlign;

/**
 * Identity of a slot. spotsAvailable, price, bookingUrl and raw are attributes,
 * NOT identity (gap G1): the same physical tee time keeps its key as spots fill
 * and free. Two slots with the same key are "the same slot" for change tracking.
 */
export function slotKey(slot: Pick<Slot, "courseId" | "date" | "time" | "holes">): string {
  return `${slot.courseId}|${slot.date}|${slot.time}|${slot.holes}`;
}

/**
 * The classification of how a slot changed between two poll snapshots.
 * - NEW     : key appeared (prev absent, curr present).
 * - REMOVED : key disappeared (curr absent) OR spotsAvailable dropped to 0.
 * - FREED   : spotsAvailable increased (a spot opened up).
 * - FILLED  : spotsAvailable decreased but is still > 0 (still bookable).
 * - SAME    : spotsAvailable unchanged.
 */
export type SlotChange = "NEW" | "REMOVED" | "FREED" | "FILLED" | "SAME";

/**
 * Classify the change for a single slot key between the previous and current
 * poll (gap G1 semantics). Callers pair prev/curr by slotKey before calling.
 *
 * - prev present, curr absent  -> REMOVED
 * - prev absent,  curr present -> NEW (if curr has spots) / REMOVED (curr spots 0)
 * - both absent                -> SAME (nothing to report)
 * - curr spots 0               -> REMOVED (no longer bookable)
 * - spots increased            -> FREED
 * - spots decreased (still >0)  -> FILLED
 * - spots unchanged            -> SAME
 */
export function classifyChange(prev?: Slot, curr?: Slot): SlotChange {
  if (!curr) {
    // Nothing there now. If there was something before, it's gone.
    return prev ? "REMOVED" : "SAME";
  }

  // curr is present. A slot with no open spots is not bookable -> REMOVED.
  if (curr.spotsAvailable <= 0) {
    return "REMOVED";
  }

  if (!prev) {
    // Newly-seen bookable key.
    return "NEW";
  }

  if (curr.spotsAvailable > prev.spotsAvailable) {
    return "FREED";
  }
  if (curr.spotsAvailable < prev.spotsAvailable) {
    return "FILLED";
  }
  return "SAME";
}
