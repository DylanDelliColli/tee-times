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
}

/**
 * Full 16-course registry across 5 backends (tee-times-z4v epic, tee-times-r5h NOTES,
 * expanded 2026-07-02). Coverage: 14/16 scrapable directly + 2 EZLinks deep-link-only
 * (Lakeview, BraeBen) = 16/16 surfaced.
 */
export const COURSES: CourseEntry[] = [
  // --- Tee-On x5 ---
  {
    courseId: "cent",
    // TODO(tee-times-r5h): confirm real display name for CENT — unknown at registry time.
    displayName: "CENT (name unconfirmed)",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "CENT", courseGroupId: "PUB1695967" },
  },
  {
    courseId: "lowville",
    displayName: "Lowville Golf Course",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "LOGC", courseGroupId: "10880" },
  },
  {
    courseId: "mount-nemo",
    displayName: "Mount Nemo Golf Club",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "MTNE", courseGroupId: "11761" },
  },
  {
    courseId: "cros",
    // TODO(tee-times-r5h): confirm real display name for CROS — unknown at registry time.
    displayName: "CROS (name unconfirmed)",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "CROS", courseGroupId: "11115" },
  },
  {
    courseId: "granite",
    displayName: "Granite Golf Club",
    backend: "tee-on",
    courseRef: { backend: "tee-on", courseCode: "GRGC", courseGroupId: "11670" },
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
  },

  // --- TEI Unify x6 (Glen Abbey tenant + Golf the 6ix tenant, 5 Toronto municipals) ---
  {
    courseId: "glen-abbey",
    displayName: "Glen Abbey Golf Club",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.linklineonline.ca", courseId: "GA" },
  },
  {
    courseId: "dentonia-park",
    displayName: "Dentonia Park Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "DP" },
  },
  {
    courseId: "don-valley",
    displayName: "Don Valley Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "DV" },
  },
  {
    courseId: "humber-valley",
    displayName: "Humber Valley Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "HV" },
  },
  {
    courseId: "scarlett-woods",
    displayName: "Scarlett Woods Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "SW" },
  },
  {
    courseId: "tam-oshanter",
    displayName: "Tam O'Shanter Golf Course",
    backend: "tei-unify",
    courseRef: { backend: "tei-unify", host: "gateway.golfthe6ix.com", courseId: "TS" },
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
