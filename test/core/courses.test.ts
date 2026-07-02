import { describe, it, expect } from "vitest";
import {
  COURSES,
  getCoursesByBackend,
  getCourse,
  type CourseEntry,
} from "../../src/core/courses.js";
import type {
  TeeOnRef,
  EzlinksRef,
  ChronogolfRef,
  TeiUnifyRef,
  ClubhouseRef,
} from "../../src/core/adapter.js";

describe("COURSES registry", () => {
  it("has exactly 16 entries", () => {
    expect(COURSES.length).toBe(16);
  });

  it("has no duplicate courseId", () => {
    const ids = COURSES.map((c) => c.courseId);
    expect(new Set(ids).size).toBe(16);
  });

  it("each entry's courseRef.backend matches the entry's backend field", () => {
    for (const c of COURSES) {
      expect(c.courseRef.backend).toBe(c.backend);
    }
  });

  it("each entry has a non-empty courseId and displayName", () => {
    for (const c of COURSES) {
      expect(c.courseId.length).toBeGreaterThan(0);
      expect(c.displayName.length).toBeGreaterThan(0);
    }
  });

  // tee-times-ckw: every course must carry a real, well-formed, course-specific
  // bookingUrl (invariant I3 at the registry level) — search.ts::deepLinkStatus()
  // reads this field directly instead of guessing a URL from courseRef shape.
  //
  // [no-integration]: this is static registry data with no runtime dependency.
  // Actually verifying each URL resolves live would require network access,
  // which THE BRIGHT LINE restricts (anonymous-GET-only, back off on
  // 403/captcha, never defeat a block) and would make CI flaky against
  // third-party uptime. Each URL below WAS verified by hand at authoring time
  // (2026-07-02) via a one-off anonymous GET/HEAD of the course's public
  // booking landing page — see the inline comments in src/core/courses.ts for
  // per-course verification notes (HTTP 200 for 14/16; the 2 EZLinks courses
  // 403 due to Cloudflare bot-protection and were instead confirmed genuine
  // via search-engine indexing, per THE BRIGHT LINE's "back off on 403" rule).
  it("every course has a non-empty, well-formed (URL-parseable) bookingUrl", () => {
    for (const c of COURSES) {
      expect(typeof c.bookingUrl).toBe("string");
      expect(c.bookingUrl.length).toBeGreaterThan(0);
      // Throws if not a valid absolute URL.
      expect(() => new URL(c.bookingUrl)).not.toThrow();
      expect(new URL(c.bookingUrl).protocol).toBe("https:");
    }
  });

  it("each bookingUrl is course-specific, not a generic bare-domain backend landing (invariant I3)", () => {
    for (const c of COURSES) {
      const url = new URL(c.bookingUrl);
      // A bare "https://host/" with no path/query/hash beyond "/" would be a
      // generic landing page rather than a course-specific deep link. EZLinks
      // is the one legitimate exception: each subdomain is dedicated to
      // exactly one facility, so the subdomain root IS the course-specific
      // page (tee-times-z4v.5 finding — no facilityId needed in the URL).
      if (c.backend === "ezlinks") {
        expect(url.hostname).toBe(`${(c.courseRef as { subdomain: string }).subdomain}.ezlinksgolf.com`);
        continue;
      }
      const isBareRoot = (url.pathname === "/" || url.pathname === "") && url.search === "";
      expect(isBareRoot).toBe(false);
    }
  });

  describe("courseRef shape per backend (discriminated union validation)", () => {
    function byBackend<K extends CourseEntry["backend"]>(backend: K): CourseEntry[] {
      return COURSES.filter((c) => c.backend === backend);
    }

    it("tee-on refs carry courseCode + courseGroupId", () => {
      const teeOnCourses = byBackend("tee-on");
      expect(teeOnCourses.length).toBe(5);
      for (const c of teeOnCourses) {
        const ref = c.courseRef as TeeOnRef;
        expect(typeof ref.courseCode).toBe("string");
        expect(ref.courseCode.length).toBeGreaterThan(0);
        expect(typeof ref.courseGroupId).toBe("string");
        expect(ref.courseGroupId.length).toBeGreaterThan(0);
      }
    });

    // tee-times-3rj: facilityId is OPTIONAL and intentionally omitted for
    // both EZLinks entries — EZLinks is formalized deep-link-only and never
    // live-scraped, so no code path ever reads facilityId (see
    // EzlinksRef in src/core/adapter.ts and src/adapters/ezlinks.ts).
    it("ezlinks refs carry subdomain, and intentionally omit the unused facilityId", () => {
      const ezlinksCourses = byBackend("ezlinks");
      expect(ezlinksCourses.length).toBe(2);
      for (const c of ezlinksCourses) {
        const ref = c.courseRef as EzlinksRef;
        expect(typeof ref.subdomain).toBe("string");
        expect(ref.subdomain.length).toBeGreaterThan(0);
        expect(ref.facilityId).toBeUndefined();
      }
    });

    it("chronogolf refs carry clubId + courseId + affiliationTypeId", () => {
      const chronogolfCourses = byBackend("chronogolf");
      expect(chronogolfCourses.length).toBe(2);
      for (const c of chronogolfCourses) {
        const ref = c.courseRef as ChronogolfRef;
        expect(typeof ref.clubId).toBe("string");
        expect(ref.clubId.length).toBeGreaterThan(0);
        expect(typeof ref.courseId).toBe("string");
        expect(typeof ref.affiliationTypeId).toBe("string");
      }
    });

    it("tei-unify refs carry host + courseId", () => {
      const teiUnifyCourses = byBackend("tei-unify");
      expect(teiUnifyCourses.length).toBe(6);
      for (const c of teiUnifyCourses) {
        const ref = c.courseRef as TeiUnifyRef;
        expect(typeof ref.host).toBe("string");
        expect(ref.host.length).toBeGreaterThan(0);
        expect(typeof ref.courseId).toBe("string");
        expect(ref.courseId.length).toBeGreaterThan(0);
      }
    });

    it("clubhouse refs carry host + courseId + externalId", () => {
      const clubhouseCourses = byBackend("clubhouse");
      expect(clubhouseCourses.length).toBe(1);
      for (const c of clubhouseCourses) {
        const ref = c.courseRef as ClubhouseRef;
        expect(typeof ref.host).toBe("string");
        expect(ref.host.length).toBeGreaterThan(0);
        expect(typeof ref.courseId).toBe("string");
        expect(ref.courseId.length).toBeGreaterThan(0);
        expect(typeof ref.externalId).toBe("string");
        expect(ref.externalId.length).toBeGreaterThan(0);
      }
    });
  });

  describe("known concrete IDs (spot-check, guards against typos/regressions)", () => {
    it("CENT tee-on ref", () => {
      const c = getCourse("cent")!;
      const ref = c.courseRef as TeeOnRef;
      expect(ref.courseCode).toBe("CENT");
      expect(ref.courseGroupId).toBe("PUB1695967");
    });

    it("Lowville tee-on ref", () => {
      const ref = getCourse("lowville")!.courseRef as TeeOnRef;
      expect(ref.courseCode).toBe("LOGC");
      expect(ref.courseGroupId).toBe("10880");
    });

    it("Mount Nemo tee-on ref", () => {
      const ref = getCourse("mount-nemo")!.courseRef as TeeOnRef;
      expect(ref.courseCode).toBe("MTNE");
      expect(ref.courseGroupId).toBe("11761");
    });

    it("CROS tee-on ref", () => {
      const ref = getCourse("cros")!.courseRef as TeeOnRef;
      expect(ref.courseCode).toBe("CROS");
      expect(ref.courseGroupId).toBe("11115");
    });

    it("Granite tee-on ref", () => {
      const ref = getCourse("granite")!.courseRef as TeeOnRef;
      expect(ref.courseCode).toBe("GRGC");
      expect(ref.courseGroupId).toBe("11670");
    });

    it("Lakeview ezlinks ref subdomain", () => {
      const ref = getCourse("lakeview")!.courseRef as EzlinksRef;
      expect(ref.subdomain).toBe("lakeviewgc");
    });

    it("BraeBen ezlinks ref subdomain", () => {
      const ref = getCourse("braeben")!.courseRef as EzlinksRef;
      expect(ref.subdomain).toBe("braeben");
    });

    it("Banty's Roost chronogolf ref (known from r4w spike)", () => {
      const ref = getCourse("bantys-roost")!.courseRef as ChronogolfRef;
      expect(ref.clubId).toBe("19628");
      expect(ref.courseId).toBe("27710");
      expect(ref.affiliationTypeId).toBe("142914");
    });

    it("Ballantrae chronogolf ref clubId (courseId/affiliationTypeId unknown)", () => {
      const ref = getCourse("ballantrae")!.courseRef as ChronogolfRef;
      expect(ref.clubId).toBe("1120");
    });

    it("Glen Abbey tei-unify ref", () => {
      const ref = getCourse("glen-abbey")!.courseRef as TeiUnifyRef;
      expect(ref.host).toBe("gateway.linklineonline.ca");
      expect(ref.courseId).toBe("GA");
    });

    it("Golf the 6ix tenant courses share host gateway.golfthe6ix.com with distinct codes", () => {
      const pairs: Array<[string, string]> = [
        ["dentonia-park", "DP"],
        ["don-valley", "DV"],
        ["humber-valley", "HV"],
        ["scarlett-woods", "SW"],
        ["tam-oshanter", "TS"],
      ];
      for (const [courseId, code] of pairs) {
        const ref = getCourse(courseId)!.courseRef as TeiUnifyRef;
        expect(ref.host).toBe("gateway.golfthe6ix.com");
        expect(ref.courseId).toBe(code);
      }
    });

    it("Upper Unionville clubhouse ref", () => {
      const ref = getCourse("upper-unionville")!.courseRef as ClubhouseRef;
      expect(ref.courseId).toBe("1258");
      expect(ref.externalId).toBe("UUGC");
      expect(ref.host.length).toBeGreaterThan(0);
    });
  });
});

describe("getCoursesByBackend", () => {
  it("partitions into exactly tee-on:5, ezlinks:2, chronogolf:2, tei-unify:6, clubhouse:1", () => {
    const byBackend = getCoursesByBackend();
    expect(byBackend["tee-on"].length).toBe(5);
    expect(byBackend.ezlinks.length).toBe(2);
    expect(byBackend.chronogolf.length).toBe(2);
    expect(byBackend["tei-unify"].length).toBe(6);
    expect(byBackend.clubhouse.length).toBe(1);
  });

  it("every course appears in exactly one partition, totaling 16", () => {
    const byBackend = getCoursesByBackend();
    const total = Object.values(byBackend).reduce((sum, arr) => sum + arr.length, 0);
    expect(total).toBe(16);
  });

  it("partition entries are the same objects as in COURSES (referential, not copies)", () => {
    const byBackend = getCoursesByBackend();
    const cent = getCourse("cent");
    expect(byBackend["tee-on"]).toContain(cent);
  });
});

describe("getCourse", () => {
  it("returns the right course for a known courseId", () => {
    const c = getCourse("glen-abbey");
    expect(c).toBeDefined();
    expect(c!.displayName).toBe("Glen Abbey Golf Club");
    expect(c!.backend).toBe("tei-unify");
  });

  it("returns undefined for an unknown courseId", () => {
    expect(getCourse("nonexistent-course")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getCourse("")).toBeUndefined();
  });
});
