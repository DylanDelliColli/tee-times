import type { Slot } from "../core/slot.js";

/**
 * GROUP-WIDE alert rules (design constraint A2): there is deliberately no
 * per-user model here. A rule describes a standing "watch" over a set of
 * courses/dates/times that fires for anyone subscribed to it — user-level
 * subscription/opt-in is a layer above this module (out of scope for the
 * watcher itself).
 */

/** Inclusive course-local wall-clock window, both bounds "HH:MM" (24h). Mirrors search.ts's TimeWindow shape for consistency. */
export interface TimeWindow {
  start: string;
  end: string;
}

/** Inclusive calendar-day range, both bounds "YYYY-MM-DD". Mirrors search.ts's DateRange shape. */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * Which dates a rule watches: either an explicit list of "YYYY-MM-DD" dates,
 * or an inclusive {start, end} range (the "dayOrDateWindow" from the bead).
 */
export type DateSelector = string[] | DateRange;

/**
 * A group-wide watch rule. All fields besides courseIds/dates are optional
 * filters — an unset filter imposes no constraint (matches everything on
 * that dimension).
 */
export interface AlertRule {
  /** Stable identifier for this rule, referenced by Alert.ruleId. */
  id: string;
  /** Which registry courseIds this rule watches. */
  courseIds: string[];
  /** Which dates this rule watches — an explicit list or an inclusive range. */
  dates: DateSelector;
  /** Restrict to slots whose course-local time falls in [start, end] inclusive. */
  timeWindow?: TimeWindow;
  /** Minimum players the rule cares about — slot must have at least this many open spots. */
  minPlayers?: number;
  /** Minimum open spots the rule cares about (independent knob from minPlayers; both gate spotsAvailable). */
  minSpots?: number;
  /** Restrict to this exact hole count. */
  holes?: 9 | 18;
}

/** Inclusive list of "YYYY-MM-DD" dates from start to end. Treated as UTC calendar days to avoid DST drift. */
export function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= endDate.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Expands a rule's DateSelector into the explicit list of dates it watches. */
export function resolveRuleDates(rule: Pick<AlertRule, "dates">): string[] {
  if (Array.isArray(rule.dates)) {
    return [...rule.dates];
  }
  return enumerateDates(rule.dates.start, rule.dates.end);
}

/** Whether `date` falls within a rule's DateSelector, without needing to enumerate a range. */
function dateInSelector(selector: DateSelector, date: string): boolean {
  if (Array.isArray(selector)) {
    return selector.includes(date);
  }
  return date >= selector.start && date <= selector.end;
}

/**
 * Whether `slot` (observed on `date`) satisfies every filter configured on
 * `rule`. Every configured filter is an AND-gate; an unset filter passes
 * through. `date` is taken as an explicit parameter (rather than read off
 * `slot.date`) so callers who already know which (courseId, date) bucket
 * they're diffing don't need to trust the slot's own field.
 */
export function matches(rule: AlertRule, slot: Slot, date: string): boolean {
  if (!rule.courseIds.includes(slot.courseId)) {
    return false;
  }
  if (!dateInSelector(rule.dates, date)) {
    return false;
  }
  if (rule.timeWindow && (slot.time < rule.timeWindow.start || slot.time > rule.timeWindow.end)) {
    return false;
  }
  if (rule.holes !== undefined && slot.holes !== rule.holes) {
    return false;
  }
  if (rule.minSpots !== undefined && slot.spotsAvailable < rule.minSpots) {
    return false;
  }
  if (rule.minPlayers !== undefined && slot.spotsAvailable < rule.minPlayers) {
    return false;
  }
  return true;
}
