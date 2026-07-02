import type { AvailabilityAdapter, ClubhouseRef, CourseRef, ListQuery } from "../core/adapter.js";
import { getCoursesByBackend } from "../core/courses.js";
import { SlotSchema, type Slot } from "../core/slot.js";
import { makeAdapterError, politeFetch, type PoliteFetchOptions, type RequestContext } from "./http.js";

/**
 * ClubHouse Online / Jonas e3 adapter — anonymous JSON REST. Mirrors the shape
 * of the REFERENCE adapter (./tee-on.ts) + the shared {@link ./http.ts} scaffold.
 *
 * THE BRIGHT LINE (see http.ts): anonymous only, honest UA, no auth header, no
 * login, back off on 403/captcha. Empty tee sheet -> [] (a REAL "no times");
 * NEVER conflated with 'blocked' or a thrown error (invariant I1).
 *
 * Flow (confirmed, tee-times-j0v CAPTURE SPIKE notes):
 *   ONE anonymous GET, path-style params (NOT query-string):
 *     GET https://{host}/api/v1/teetimes/GetAvailableTeeTimes/
 *         {date:YYYYMMDD}/{courseList}/{timeOfDay}/{players}/{filterAvailableOnly}
 *   Verified live (200 OK, anonymous, no auth header/cookie):
 *     GET https://upperunionville.clubhouseonline-e3.net/api/v1/teetimes/
 *         GetAvailableTeeTimes/20260710/1258/0/1/false
 *
 * Every endpoint shares one envelope:
 *   { retCode, title, infoMsg, errorMessage, displayMessage, serverStackTrace,
 *     data, result }
 * retCode:0 = success. For GetAvailableTeeTimes, `data` is an OBJECT (not a
 * bare array): { availability: [], teeSheet: TeeSheetRow[] }. Per-slot rows
 * live in data.teeSheet[]; a PUBLIC-BOOKABLE row is availableToPublic===true
 * AND isBookable===true (tee-times-j0v NOTES).
 *
 * We always request filterAvailableOnly=false — that is the exact param
 * combination verified live in the capture spike; whether the server actually
 * honors filterAvailableOnly=true (and would let us shrink the payload) is an
 * explicit open follow-up in tee-times-j0v, not yet verified. We filter
 * client-side regardless, so this choice only affects payload size, not
 * correctness.
 */

/** Fully-qualified ClubHouse Online tenant suffix. */
const CLUBHOUSE_HOST_SUFFIX = ".clubhouseonline-e3.net";

export interface ClubhouseAdapterDeps {
  /** Options forwarded to politeFetch (fetchImpl cassette, jitter, etc.). */
  fetch?: Pick<PoliteFetchOptions, "fetchImpl" | "jitterMs" | "sleep" | "random">;
}

export class ClubhouseAdapter implements AvailabilityAdapter {
  readonly backendId = "clubhouse" as const;

  constructor(private readonly deps: ClubhouseAdapterDeps = {}) {}

  async listSlots(courseRef: CourseRef, date: string, query: ListQuery): Promise<Slot[]> {
    if (courseRef.backend !== "clubhouse") {
      throw new Error(`ClubhouseAdapter received non-clubhouse courseRef: ${courseRef.backend}`);
    }
    const ref = courseRef;
    const courseId = resolveCourseId(ref);
    const ctx: RequestContext = { backendId: this.backendId, courseId };

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw makeAdapterError(ctx, "parse", `invalid date '${date}', expected YYYY-MM-DD`);
    }

    const url = clubhouseAvailabilityUrl(ref, date, query);
    const fetchOpts = this.deps.fetch ?? {};

    // ONE anonymous GET. No auth header, no login, no cookie jar needed — the
    // endpoint is confirmed stateless/anonymous (tee-times-j0v NOTES).
    const res = await politeFetch(url, ctx, {
      ...fetchOpts,
      method: "GET",
      headers: { Accept: "application/json" },
    });

    return parseResults(res.text, ref, date, courseId, ctx, query);
  }
}

/**
 * Build the GetAvailableTeeTimes URL (public for tests/inspection). Path-style
 * positional segments, exact order confirmed from the Angular bundle + a live
 * 200 capture (tee-times-j0v NOTES) — do not reorder.
 */
export function clubhouseAvailabilityUrl(ref: ClubhouseRef, date: string, query: ListQuery = {}): string {
  const host = resolveHost(ref.host);
  const pathDate = date.replace(/-/g, ""); // "2026-07-10" -> "20260710"
  const playersSeg = resolvePlayersSegment(query.players);
  return (
    `https://${host}/api/v1/teetimes/GetAvailableTeeTimes/` +
    `${pathDate}/${enc(ref.courseId)}/0/${playersSeg}/false`
  );
}

/**
 * Parse a GetAvailableTeeTimes JSON body into normalized Slots (public entry
 * for unit tests). Resolves the registry courseId from the ref. Empty
 * data.teeSheet (or zero bookable rows) -> []; unrecognizable envelope shape
 * -> AdapterError 'parse' (invariant I1).
 */
export function parseClubhouseResults(
  json: string,
  ref: ClubhouseRef,
  date: string,
  query: ListQuery = {},
): Slot[] {
  const courseId = resolveCourseId(ref);
  const ctx: RequestContext = { backendId: "clubhouse", courseId };
  return parseResults(json, ref, date, courseId, ctx, query);
}

/**
 * Deep link to THIS course's own ClubHouse Online public booking page
 * (invariant I3) — the club's own subdomain widget, NOT a generic
 * clubhouseonline-e3.net landing page. The widget is an Angular SPA whose
 * routing state lives client-side after the hash, so every slot for a course
 * shares the same course-specific deep link (tee-times-j0v NOTES).
 */
export function courseBookingUrl(ref: ClubhouseRef): string {
  const host = resolveHost(ref.host);
  return `https://${host}/CMSModules/CHO/TeeTimes/PublicTeeTimes.aspx#!/`;
}

/**
 * Normalize a ClubHouse "HH:MM:SS" tee time to course-local "HH:MM". ClubHouse
 * times are already course-local (I2) — pure string reformatting, no tz math.
 * Returns null if the input is not a well-formed 24h clock time.
 */
export function normalizeTeeTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2}):(\d{2}):\d{2}$/);
  if (!m) return null;
  const hour = parseInt(m[1] ?? "", 10);
  const minute = parseInt(m[2] ?? "", 10);
  if (Number.isNaN(hour) || hour > 23 || Number.isNaN(minute) || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Resolve our registry courseId from a ClubHouse courseRef (fall back to externalId). */
function resolveCourseId(ref: ClubhouseRef): string {
  const entry = getCoursesByBackend()["clubhouse"].find(
    (c) =>
      c.courseRef.backend === "clubhouse" &&
      c.courseRef.host === ref.host &&
      c.courseRef.courseId === ref.courseId,
  );
  return entry?.courseId ?? ref.externalId.trim().toLowerCase();
}

/**
 * Accept either host form seen in the notes ("upperunionville" or the fully
 * qualified "upperunionville.clubhouseonline-e3.net") and always return the
 * network-dialable FQDN.
 */
function resolveHost(host: string): string {
  return host.includes(".") ? host : `${host}${CLUBHOUSE_HOST_SUFFIX}`;
}

/**
 * The `players` path segment. The front-end's own default (per the captured
 * Angular bundle) is `null`, stringified literally as the segment "null" when
 * the caller doesn't specify a player count — a widened, all-players search.
 * When a count IS given we clamp to a real foursome (1-4), matching the
 * fixture's maxPlayers:4.
 */
function resolvePlayersSegment(players: number | undefined): string {
  if (players === undefined) return "null";
  const n = Math.trunc(players);
  return String(Math.min(4, Math.max(1, n)));
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Minimal shape-guarded view of one data.teeSheet[] row we actually read. */
interface TeeSheetRowLike {
  availableToPublic?: unknown;
  isBookable?: unknown;
  nineAllowed?: unknown;
  eighteenAllowed?: unknown;
  teeTime?: unknown;
  availPlayers?: unknown;
  playerCost?: unknown;
}

/**
 * Parse a GetAvailableTeeTimes response body into normalized Slots.
 *
 * Empty-vs-broken discipline (invariant I1):
 *  - envelope parses, retCode:0, data.teeSheet is an array with zero bookable
 *    rows -> [] (REAL "no times")
 *  - body is not JSON (e.g. an HTML 404 page), envelope shape is wrong,
 *    retCode!=0, or errorMessage is present -> throw 'parse'
 */
function parseResults(
  json: string,
  ref: ClubhouseRef,
  date: string,
  courseId: string,
  ctx: RequestContext,
  query: ListQuery,
): Slot[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(json);
  } catch (cause) {
    throw makeAdapterError(
      ctx,
      "parse",
      "response body is not valid JSON (expected ClubHouse envelope) — likely an HTML error page",
      cause,
    );
  }

  if (typeof envelope !== "object" || envelope === null) {
    throw makeAdapterError(ctx, "parse", "envelope is not a JSON object");
  }
  const env = envelope as {
    retCode?: unknown;
    errorMessage?: unknown;
    displayMessage?: unknown;
    data?: unknown;
  };

  if (typeof env.retCode !== "number") {
    throw makeAdapterError(ctx, "parse", "envelope missing numeric retCode — upstream shape changed");
  }
  if (env.retCode !== 0) {
    const detail = typeof env.displayMessage === "string" && env.displayMessage ? `: ${env.displayMessage}` : "";
    throw makeAdapterError(ctx, "parse", `backend returned retCode ${env.retCode}${detail}`);
  }
  if (typeof env.errorMessage === "string" && env.errorMessage.length > 0) {
    throw makeAdapterError(ctx, "parse", `backend returned errorMessage: ${env.errorMessage}`);
  }

  if (typeof env.data !== "object" || env.data === null) {
    throw makeAdapterError(ctx, "parse", "envelope missing 'data' object — upstream shape changed");
  }
  const data = env.data as { teeSheet?: unknown };
  if (!Array.isArray(data.teeSheet)) {
    throw makeAdapterError(ctx, "parse", "envelope.data.teeSheet is missing or not an array");
  }

  const bookingUrl = courseBookingUrl(ref);
  const slots: Slot[] = [];

  for (const rawRow of data.teeSheet) {
    if (typeof rawRow !== "object" || rawRow === null) continue;
    const row = rawRow as TeeSheetRowLike;

    // BOOKABLE-SLOT FILTER (tee-times-j0v NOTES): public + bookable only.
    if (row.availableToPublic !== true || row.isBookable !== true) continue;

    const holes = resolveHoles(row, query.holes);
    if (holes === null) continue;

    const time = typeof row.teeTime === "string" ? normalizeTeeTime(row.teeTime) : null;
    if (!time) continue;

    const spotsAvailable = typeof row.availPlayers === "number" ? row.availPlayers : 0;
    const price = typeof row.playerCost === "number" ? row.playerCost : undefined;

    const slot: Slot = {
      courseId,
      backendId: "clubhouse",
      date,
      time,
      holes,
      spotsAvailable,
      ...(price !== undefined ? { price } : {}),
      bookingUrl,
    };

    const parsed = SlotSchema.safeParse(slot);
    if (parsed.success) slots.push(parsed.data);
  }

  return slots;
}

/**
 * Decide the Slot.holes value for a row, honoring an explicit ListQuery.holes
 * filter. If the caller asked for a specific hole count, only rows that allow
 * it match (and that value is used). If unspecified, prefer 18 (the widest
 * round) then fall back to 9. A row that allows neither returns null (skip).
 */
function resolveHoles(row: TeeSheetRowLike, queryHoles: 9 | 18 | undefined): 9 | 18 | null {
  const nine = row.nineAllowed === true;
  const eighteen = row.eighteenAllowed === true;
  if (queryHoles === 9) return nine ? 9 : null;
  if (queryHoles === 18) return eighteen ? 18 : null;
  if (eighteen) return 18;
  if (nine) return 9;
  return null;
}
