import type { BackendId, CourseRef } from "./adapter.js";

/**
 * Sentinel for a required CourseRef field whose real value is not yet known
 * (see bead tee-times-r5h NOTES). Adapters/pollers for these courses will
 * fail fast against this value rather than silently using a fabricated ID.
 * Every occurrence has an inline TODO comment naming the course + field.
 */
export const TODO_UNKNOWN = "TODO_UNKNOWN";

/** One row of the course registry: the single source of truth for "add a course = add config". */
export interface CourseEntry {
  courseId: string;
  displayName: string;
  backend: BackendId;
  courseRef: CourseRef;
  /**
   * Canonical, real, per-course booking-page URL (tee-times-ckw) — the page a
   * human visitor would land on to book at THIS specific course (its own
   * booking widget/landing), never a generic backend homepage (invariant I3
   * at the registry level). Verified 2026-07-02 via an anonymous GET/HEAD of
   * each course's public landing page (a normal visitor's request — THE
   * BRIGHT LINE: no login, no captcha-solving, no scrape of availability).
   * search.ts::deepLinkStatus() reads this field directly for the
   * deep-link-only / stale / never-polled CourseStatus row.
   */
  bookingUrl: string;
}

/**
 * Full 16-course registry across 5 backends (tee-times-z4v epic, tee-times-r5h NOTES,
 * expanded 2026-07-02). Coverage: 14/16 scrapable directly + 2 EZLinks deep-link-only
 * (Lakeview, BraeBen) = 16/16 surfaced.
 */
export const COURSES: CourseEntry[] = [
  // --- Tee-On x5 ---
  // bookingUrl shape verified live 2026-07-02 (tee-times-ckw): anonymous GET
  // of each course's own WebBookingSearchSteps servlet URL (CourseGroupID +
  // CourseCode) returned HTTP 200 for all 5 courses below.
  {
    courseId: "cent",
    // TODO(tee-times-r5h): confirm real display name for CENT — unknown at registry time.
    displayName: "CENT (name unconfirmed)",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "CENT", courseGroupId: "PUB1695967" },
    bookingUrl:
      "https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingSearchSteps?CourseGroupID=PUB1695967&CourseCode=CENT",
  },
  {
    courseId: "lowville",
    displayName: "Lowville Golf Course",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "LOGC", courseGroupId: "10880" },
    bookingUrl:
      "https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingSearchSteps?CourseGroupID=10880&CourseCode=LOGC",
  },
  {
    courseId: "mount-nemo",
    displayName: "Mount Nemo Golf Club",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "MTNE", courseGroupId: "11761" },
    bookingUrl:
      "https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingSearchSteps?CourseGroupID=11761&CourseCode=MTNE",
  },
  {
    courseId: "cros",
    // TODO(tee-times-r5h): confirm real display name for CROS — unknown at registry time.
    displayName: "CROS (name unconfirmed)",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "CROS", courseGroupId: "11115" },
    bookingUrl:
      "https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingSearchSteps?CourseGroupID=11115&CourseCode=CROS",
  },
  {
    courseId: "granite",
    displayName: "Granite Golf Club",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "GRGC", courseGroupId: "11670" },
    bookingUrl:
      "https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection.WebBookingSearchSteps?CourseGroupID=11670&CourseCode=GRGC",
  },

  // --- EZLinks x2 (deep-link-only: Cloudflare-blocked, no live scrape) ---
  {
    courseId: "lakeview",
    displayName: "Lakeview Golf Course",
    backend: "ezlinks",
    courseRef: {
      backend: "ezlinks",
      subdomain: "lakeviewgc",
      // TODO(tee-times-r5h): confirm facilityId for Lakeview (ezlinks) — unknown at registry time.
      facilityId: TODO_UNKNOWN,
    },
    // tee-times-z4v.5 finding: the EZLinks subdomain LANDING page is the real,
    // course-specific booking page (each subdomain serves exactly one
    // facility) — no facilityId is needed in the URL. Confirmed the domain is
    // genuine via search-engine indexing ("Lakeview Golf Course - Public -
    // Online tee times made EZ" at this exact URL); a direct anonymous
    // curl GET returned 403 (Cloudflare bot-challenge on this host, matching
    // the registry's existing "EZLinks is Cloudflare-blocked" note) so this
    // URL is best-known/verified-via-indexing rather than live-GET-verified —
    // per THE BRIGHT LINE we back off on the 403 rather than working around it.
    bookingUrl: "https://lakeviewgc.ezlinksgolf.com/",
  },
  {
    courseId: "braeben",
    displayName: "BraeBen Golf Course",
    backend: "ezlinks",
    courseRef: {
      backend: "ezlinks",
      subdomain: "braeben",
      // TODO(tee-times-r5h): confirm facilityId for BraeBen (ezlinks) — unknown at registry time.
      facilityId: TODO_UNKNOWN,
    },
    // Same tee-times-z4v.5 finding as Lakeview above: subdomain root is the
    // real per-course landing; direct anonymous GET also 403s (Cloudflare),
    // confirmed genuine via search-engine indexing instead
    // ("Braeben Golf Course - Public - Online tee times made EZ").
    bookingUrl: "https://braeben.ezlinksgolf.com/",
  },

  // --- Chronogolf x2 ---
  {
    courseId: "bantys-roost",
    displayName: "Banty's Roost Golf Club",
    backend: "chronogolf",
    courseRef: {
      backend: "chronogolf",
      clubId: "19628",
      // Known from the tee-times-r4w spike.
      courseId: "27710",
      affiliationTypeId: "142914",
    },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200. (The alternate
    // slug "banty-s-roost-golf-course" 404s; "-club" is the real one.)
    bookingUrl: "https://www.chronogolf.com/club/banty-s-roost-golf-club",
  },
  {
    courseId: "ballantrae",
    displayName: "Ballantrae Golf Club",
    backend: "chronogolf",
    courseRef: {
      backend: "chronogolf",
      clubId: "1120",
      // TODO(tee-times-r5h): confirm courseId for Ballantrae (chronogolf) — unknown at registry time.
      courseId: TODO_UNKNOWN,
      // TODO(tee-times-r5h): confirm affiliationTypeId for Ballantrae (chronogolf) — unknown at registry time.
      affiliationTypeId: TODO_UNKNOWN,
    },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200 (Stouffville, ON club).
    bookingUrl: "https://www.chronogolf.com/club/ballantrae-golf-club",
  },

  // --- TEI Unify x6 (Glen Abbey tenant + Golf the 6ix tenant, 5 Toronto municipals) ---
  {
    courseId: "glen-abbey",
    displayName: "Glen Abbey Golf Club",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.linklineonline.ca", courseId: "GA" },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200. Public UI host is
    // "linklineonline.ca" (no "gateway." prefix — that prefix is the
    // API/scrape host used by courseRef.host, distinct from the public page).
    // CourseID filter makes this course-specific, not a generic tenant landing.
    bookingUrl: 'https://linklineonline.ca/web/tee-times?filters=%7B%22CourseID%22:%5B%22GA%22%5D%7D',
  },
  {
    courseId: "dentonia-park",
    displayName: "Dentonia Park Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "DP" },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200. Public UI host is
    // "app.golfthe6ix.com" (the "gateway." host is the API/scrape host).
    bookingUrl: 'https://app.golfthe6ix.com/web/tee-times?filters=%7B%22CourseID%22:%5B%22DP%22%5D%7D',
  },
  {
    courseId: "don-valley",
    displayName: "Don Valley Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "DV" },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200.
    bookingUrl: 'https://app.golfthe6ix.com/web/tee-times?filters=%7B%22CourseID%22:%5B%22DV%22%5D%7D',
  },
  {
    courseId: "humber-valley",
    displayName: "Humber Valley Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "HV" },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200.
    bookingUrl: 'https://app.golfthe6ix.com/web/tee-times?filters=%7B%22CourseID%22:%5B%22HV%22%5D%7D',
  },
  {
    courseId: "scarlett-woods",
    displayName: "Scarlett Woods Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "SW" },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200.
    bookingUrl: 'https://app.golfthe6ix.com/web/tee-times?filters=%7B%22CourseID%22:%5B%22SW%22%5D%7D',
  },
  {
    courseId: "tam-oshanter",
    displayName: "Tam O'Shanter Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "TS" },
    // Verified live 2026-07-02: anonymous GET -> HTTP 200.
    bookingUrl: 'https://app.golfthe6ix.com/web/tee-times?filters=%7B%22CourseID%22:%5B%22TS%22%5D%7D',
  },

  // --- ClubHouse Online / Jonas x1 ---
  {
    courseId: "upper-unionville",
    displayName: "Upper Unionville Golf Club",
    backend: "clubhouse",
    courseRef: {
      backend: "clubhouse",
      // Two host forms were given in the notes ("upperunionville" and
      // "upperunionville.clubhouseonline-e3.net"); the fully-qualified form
      // is used here as the actual network host. Flagged for confirmation —
      // see final report.
      host: "upperunionville.clubhouseonline-e3.net",
      courseId: "1258",
      externalId: "UUGC",
    },
    // Verified live 2026-07-02: anonymous GET (without the client-side-only
    // "#!/" hash fragment, which HTTP requests never send) -> HTTP 200.
    bookingUrl: "https://upperunionville.clubhouseonline-e3.net/CMSModules/CHO/TeeTimes/PublicTeeTimes.aspx#!/",
  },
];

/** Partition the registry by backend. */
export function getCoursesByBackend(): Record<BackendId, CourseEntry[]> {
  const result: Record<BackendId, CourseEntry[]> = {
    "tee-on": [],
    ezlinks: [],
    chronogolf: [],
    "tei-unify": [],
    clubhouse: [],
  };
  for (const course of COURSES) {
    result[course.backend].push(course);
  }
  return result;
}

/** Look up a single course by its registry courseId. */
export function getCourse(courseId: string): CourseEntry | undefined {
  return COURSES.find((c) => c.courseId === courseId);
}
