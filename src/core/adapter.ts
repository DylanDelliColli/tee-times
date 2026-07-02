import type { Slot } from "./slot.js";
import type { AdapterError } from "./errors.js";

/**
 * The set of booking backends we know how to normalize. 'tei-unify' generalizes
 * the former 'linkline' backend: one adapter serves both
 * gateway.linklineonline.ca and gateway.golfthe6ix.com.
 */
export type BackendId =
  | "tee-on"
  | "ezlinks"
  | "chronogolf"
  | "tei-unify"
  | "clubhouse";

/** Tee-On backend course reference. */
export interface TeeOnRef {
  backend: "tee-on";
  courseCode: string;
  courseGroupId: string;
}

/** EZLinks backend course reference. */
export interface EzlinksRef {
  backend: "ezlinks";
  subdomain: string;
  facilityId: string;
}

/** Chronogolf backend course reference. */
export interface ChronogolfRef {
  backend: "chronogolf";
  clubId: string;
  courseId: string;
  affiliationTypeId: string;
}

/**
 * TEE Unify backend course reference (formerly LinklineRef). `host` distinguishes
 * the concrete gateway, e.g. gateway.linklineonline.ca or gateway.golfthe6ix.com.
 */
export interface TeiUnifyRef {
  backend: "tei-unify";
  host: string;
  courseId: string;
}

/** Clubhouse backend course reference. */
export interface ClubhouseRef {
  backend: "clubhouse";
  host: string;
  courseId: string;
  externalId: string;
}

/**
 * Discriminated union (on `backend`) of every backend-specific course reference.
 * An adapter receives the variant matching its own backendId.
 */
export type CourseRef =
  | TeeOnRef
  | EzlinksRef
  | ChronogolfRef
  | TeiUnifyRef
  | ClubhouseRef;

/** Query knobs a caller passes when listing slots. */
export interface ListQuery {
  players?: number;
  holes?: 9 | 18;
}

/**
 * An adapter that lists bookable tee-time slots for one backend.
 *
 * INVARIANT I1: listSlots MUST return a normalized Slot[] OR throw an
 * {@link AdapterError}. It must NEVER return [] to signal that it is broken
 * (an empty array means "genuinely no slots for this query"), and it must
 * NEVER return backend-shaped/raw data — only normalized {@link Slot} objects.
 *
 * INVARIANT I3: every returned Slot.bookingUrl MUST deep-link to the course's
 * own booking page for that slot, not to a generic backend landing page.
 */
export interface AvailabilityAdapter {
  readonly backendId: BackendId;

  /**
   * List normalized slots for a course on a given date.
   * @throws {AdapterError} on any failure (blocked/parse/network/auth) — see I1.
   */
  listSlots(courseRef: CourseRef, date: string, query: ListQuery): Promise<Slot[]>;
}
