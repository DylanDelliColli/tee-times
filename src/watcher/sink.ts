import type { Slot } from "../core/slot.js";

/**
 * The only slot transitions the watcher ever alerts on. FREED is the whole
 * point of the scarcity hunt (G1): a spotsAvailable increase on an already-
 * seen slot means a cancellation opened up. NEW is a slot appearing for the
 * first time with open spots. REMOVED/FILLED/SAME never produce an alert.
 */
export type AlertTransition = "NEW" | "FREED";

/**
 * One outbound alert: a single slot, on a single (courseId, date), that just
 * transitioned in a way a rule cares about.
 */
export interface Alert {
  courseId: string;
  date: string;
  /** The current (post-transition) slot that triggered this alert. */
  slot: Slot;
  transition: AlertTransition;
  /** id of the AlertRule (see rules.ts) that matched this slot. */
  ruleId: string;
  /** Human-readable summary, suitable for direct display in a notification. */
  message: string;
}

/**
 * Abstract delivery channel for alerts. INTERFACE ONLY — no concrete
 * implementation lives here. The concrete channel (email/SMS/push/etc.) is a
 * separate bead (tee-times-6i1); this module and its tests only ever use a
 * stub/fake sink.
 */
export interface NotificationSink {
  send(alert: Alert): Promise<void> | void;
}
