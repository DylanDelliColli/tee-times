import { load, type CheerioAPI } from "cheerio";
import type { AvailabilityAdapter, CourseRef, ListQuery, TeeOnRef } from "../core/adapter.js";
import { getCoursesByBackend } from "../core/courses.js";
import { SlotSchema, type Slot } from "../core/slot.js";
import {
  CookieJar,
  makeAdapterError,
  politeFetch,
  type PoliteFetchOptions,
  type RequestContext,
} from "./http.js";

/**
 * Tee-On adapter — the REFERENCE adapter. Anonymous HTML scrape of the Tee-On
 * "golfersection" public booking servlets. All other adapters mirror the shape
 * of this file + the shared {@link ./http.ts} scaffold.
 *
 * THE BRIGHT LINE (see http.ts): anonymous only, honest UA, no auth header, no
 * cookie we didn't receive anonymously in this same flow, back off on
 * 403/captcha. Empty tee sheet -> [] (a REAL "no times"); NEVER conflated with
 * 'blocked' (invariant I1).
 *
 * Flow (confirmed, tee-times-zra NOTES):
 *   (2) GET  WebBookingSearchSteps?CourseGroupID&CourseCode&Date   (mints the
 *            anonymous "Public Golfer" session cookie; SearchTime dropdown grid)
 *   (3) POST WebBookingSearchResults  body: Date, SearchTime('' = any), Holes,
 *            Players, CourseId{CODE}={CODE}, CourseGroupID, Referrer
 * The step-3 POST replays the cookie the step-2 GET set (anonymous session the
 * site itself mints — NOT a login).
 */

/** Public Tee-On servlet base (host confirmed from the real LOGC fixture JS). */
const TEE_ON_BASE = "https://www.tee-on.com/PubGolf/servlet/";
const GOLFER = "com.teeon.teesheet.servlets.golfersection.";

/** Per-slot booking submission handler present in the real page's JS. Each
 * available tee time is a clickable element calling this with its concrete
 * args; we key the parser on this real contract (course-agnostic across all
 * Tee-On golfersection pages). */
const SHOW_LOGIN_ARGS = [
  "courseCode",
  "nineCode",
  "date",
  "time",
  "holes",
  "isSpecial",
  "cartsMandatory",
  "timeId",
  "shotgunId",
] as const;

export interface TeeOnAdapterDeps {
  /** Options forwarded to politeFetch (fetchImpl cassette, jitter, etc.). */
  fetch?: Pick<PoliteFetchOptions, "fetchImpl" | "jitterMs" | "sleep" | "random">;
}

export class TeeOnAdapter implements AvailabilityAdapter {
  readonly backendId = "tee-on" as const;

  constructor(private readonly deps: TeeOnAdapterDeps = {}) {}

  async listSlots(courseRef: CourseRef, date: string, query: ListQuery): Promise<Slot[]> {
    if (courseRef.backend !== "tee-on") {
      throw new Error(`TeeOnAdapter received non-tee-on courseRef: ${courseRef.backend}`);
    }
    const ref = courseRef;
    const courseId = resolveCourseId(ref);
    const ctx: RequestContext = { backendId: this.backendId, courseId };

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw makeAdapterError(ctx, "parse", `invalid date '${date}', expected YYYY-MM-DD`);
    }

    const players = clampPlayers(query.players);
    const holes: 9 | 18 = query.holes === 9 ? 9 : 18;

    // ONE anonymous flow -> ONE fresh jar. Only cookies the site mints here are
    // ever replayed (BRIGHT LINE). No auth header is ever added.
    const jar = new CookieJar();
    const fetchOpts = this.deps.fetch ?? {};

    // Step 2 — GET the search form (mints the anonymous Public Golfer session).
    const stepsUrl =
      `${TEE_ON_BASE}${GOLFER}WebBookingSearchSteps` +
      `?CourseGroupID=${enc(ref.courseGroupId)}&CourseCode=${enc(ref.courseCode)}&Date=${enc(date)}`;
    await politeFetch(stepsUrl, ctx, { ...fetchOpts, method: "GET", jar });

    // Step 3 — POST the search to get the availability results HTML.
    const resultsUrl = `${TEE_ON_BASE}${GOLFER}WebBookingSearchResults`;
    const body = new URLSearchParams({
      Date: date,
      SearchTime: "", // '' = any time
      Holes: String(holes),
      Players: String(players),
      [`CourseId${ref.courseCode}`]: ref.courseCode,
      CourseGroupID: ref.courseGroupId,
      Referrer: "",
    }).toString();

    const res = await politeFetch(resultsUrl, ctx, {
      ...fetchOpts,
      method: "POST",
      jar,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return parseResults(res.text, ref, date, courseId, ctx);
  }
}

/**
 * Parse a WebBookingSearchResults HTML body into normalized Slots (public entry
 * for unit tests). Resolves the registry courseId from the ref. Empty sheet ->
 * []; unrecognizable markup -> AdapterError 'parse' (invariant I1).
 */
export function parseTeeOnResults(html: string, ref: TeeOnRef, date: string): Slot[] {
  const courseId = resolveCourseId(ref);
  const ctx: RequestContext = { backendId: "tee-on", courseId };
  return parseResults(html, ref, date, courseId, ctx);
}

/** Resolve our registry courseId from a Tee-On courseRef (fall back to code). */
function resolveCourseId(ref: TeeOnRef): string {
  const entry = getCoursesByBackend()["tee-on"].find(
    (c) =>
      c.courseRef.backend === "tee-on" &&
      c.courseRef.courseCode === ref.courseCode &&
      c.courseRef.courseGroupId === ref.courseGroupId,
  );
  return entry?.courseId ?? ref.courseCode.toLowerCase();
}

function clampPlayers(players: number | undefined): number {
  if (players === undefined) return 4; // widest search surfaces the most times
  const n = Math.trunc(players);
  return Math.min(4, Math.max(1, n));
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Parse a WebBookingSearchResults HTML body into normalized Slots.
 *
 * Empty-vs-broken discipline (invariant I1):
 *  - results container present, zero tee-time rows -> [] (REAL "no times")
 *  - results container absent (shape unrecognizable) -> throw 'parse'
 */
function parseResults(
  html: string,
  ref: TeeOnRef,
  date: string,
  courseId: string,
  ctx: RequestContext,
): Slot[] {
  let $: CheerioAPI;
  try {
    $ = load(html);
  } catch (cause) {
    throw makeAdapterError(ctx, "parse", "cheerio failed to load results HTML", cause);
  }

  // Anchor that identifies a genuine results page. If NONE of these exist the
  // markup is not a Tee-On results page (truncated/garbage/shape change).
  const isResultsPage =
    $(".search-results-tee-times-wrapper").length > 0 ||
    $("form[action*='WebBookingSearchResults']").length > 0 ||
    $(".search-results-course").length > 0;
  if (!isResultsPage) {
    throw makeAdapterError(
      ctx,
      "parse",
      "results markup unrecognizable (no search-results anchor) — upstream shape changed",
    );
  }

  const bookingUrl = courseBookingUrl(ref, date);
  const slots: Slot[] = [];

  // Each available tee time is a clickable element invoking the page's own
  // showLogin(...) handler. Key on that real contract (works for every Tee-On
  // golfersection course), not on brittle inner CSS classes.
  $("[onclick*='showLogin(']").each((_i, el) => {
    const onclick = $(el).attr("onclick") ?? "";
    const args = parseShowLoginArgs(onclick);
    if (!args) return;

    const time = normalizeTime(args.time);
    if (!time) return; // not a real tee-time row

    const holes = args.holes.includes("9") && !args.holes.includes("18") ? 9 : 18;
    const spotsAvailable = extractSpots($, el);

    const slot: Slot = {
      courseId,
      backendId: "tee-on",
      // Tee-On times are already course-local Ontario wall-clock (I2). We only
      // normalize the string format; we apply NO timezone math, so there is no
      // DST offset bug to introduce.
      date: args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : date,
      time,
      holes,
      spotsAvailable,
      bookingUrl,
    };

    const parsed = SlotSchema.safeParse(slot);
    if (parsed.success) slots.push(parsed.data);
  });

  return slots;
}

/** Extract showLogin(...) positional args from an onclick string. */
function parseShowLoginArgs(onclick: string): Record<(typeof SHOW_LOGIN_ARGS)[number], string> | null {
  const m = onclick.match(/showLogin\s*\(([^)]*)\)/);
  if (!m || m[1] === undefined) return null;
  const rawArgs = splitArgs(m[1]);
  if (rawArgs.length < SHOW_LOGIN_ARGS.length) return null;
  const out = {} as Record<(typeof SHOW_LOGIN_ARGS)[number], string>;
  SHOW_LOGIN_ARGS.forEach((name, i) => {
    out[name] = stripQuotes(rawArgs[i] ?? "");
  });
  return out;
}

/** Split a comma-separated JS arg list, respecting simple quotes. */
function splitArgs(s: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ",") {
      args.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  args.push(cur.trim());
  return args;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "").trim();
}

/**
 * Extract open-spot count for a tee-time row. Tee-On shows this as a small
 * "N available / N players" label; if absent, a bookable open time seats up to
 * 4. (spotsAvailable is an ATTRIBUTE, gap G1.)
 */
function extractSpots($: CheerioAPI, el: Parameters<CheerioAPI>[0]): number {
  const $el = $(el as never);
  const dataAttr = $el.attr("data-spots") ?? $el.attr("data-available");
  if (dataAttr && /^\d+$/.test(dataAttr.trim())) {
    return Math.min(4, Math.max(0, parseInt(dataAttr.trim(), 10)));
  }
  const text = $el.text();
  const m = text.match(/(\d+)\s*(?:available|spots?|players?|golfers?)/i);
  if (m && m[1]) return Math.min(4, Math.max(0, parseInt(m[1], 10)));
  return 4;
}

/**
 * Normalize a Tee-On time label to 24h "HH:MM". Accepts "7:30 am", "7:30 AM",
 * "07:30", "7:30". Timezone-agnostic string formatting only (I2 / DST-safe).
 * Returns null if the input is not a clock time.
 */
export function normalizeTime(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1] ?? "", 10);
  const minute = parseInt(m[2] ?? "", 10);
  const meridiem = m[3];
  if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;
  if (meridiem === "am") {
    if (hour === 12) hour = 0;
  } else if (meridiem === "pm") {
    if (hour !== 12) hour += 12;
  }
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Deep link to THIS course's own Tee-On booking page for the date (invariant
 * I3) — the course-specific search-steps servlet, NOT a generic backend
 * landing. Booking itself requires the golfer to sign in on Tee-On (which this
 * tool never does — THE BRIGHT LINE); we hand the user to the course's own page.
 */
export function courseBookingUrl(ref: TeeOnRef, date: string): string {
  return (
    `${TEE_ON_BASE}${GOLFER}WebBookingSearchSteps` +
    `?CourseGroupID=${enc(ref.courseGroupId)}&CourseCode=${enc(ref.courseCode)}&Date=${enc(date)}`
  );
}
