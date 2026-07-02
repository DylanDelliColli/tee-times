import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseClubhouseResults,
  clubhouseAvailabilityUrl,
  courseBookingUrl,
  normalizeTeeTime,
} from "../../src/adapters/clubhouse.js";
import { SlotSchema, type Slot } from "../../src/core/slot.js";
import { AdapterError } from "../../src/core/errors.js";
import type { ClubhouseRef } from "../../src/core/adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures", "clubhouse");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

const UUGC: ClubhouseRef = {
  backend: "clubhouse",
  host: "upperunionville.clubhouseonline-e3.net",
  courseId: "1258",
  externalId: "UUGC",
};
const DATE = "2026-07-10";
const REAL_FIXTURE = loadFixture("uugc-2026-07-10.json");
const EXPECTED_BOOKING_URL =
  "https://upperunionville.clubhouseonline-e3.net/CMSModules/CHO/TeeTimes/PublicTeeTimes.aspx#!/";

describe("clubhouse parser — REAL captured fixture (uugc-2026-07-10.json)", () => {
  const slots = parseClubhouseResults(REAL_FIXTURE, UUGC, DATE, {});

  it("keeps only public-bookable rows (availableToPublic && isBookable)", () => {
    // Fixture: 80 teeSheet rows total, 18 are availableToPublic && isBookable.
    expect(slots).toHaveLength(18);
  });

  it("parses the first three bookable rows to EXACT Slot shape", () => {
    const first3 = slots.slice(0, 3);
    const expected: Slot[] = [
      {
        courseId: "upper-unionville",
        backendId: "clubhouse",
        date: "2026-07-10",
        time: "07:50",
        holes: 18,
        spotsAvailable: 4,
        price: 120,
        bookingUrl: EXPECTED_BOOKING_URL,
      },
      {
        courseId: "upper-unionville",
        backendId: "clubhouse",
        date: "2026-07-10",
        time: "08:50",
        holes: 18,
        spotsAvailable: 4,
        price: 120,
        bookingUrl: EXPECTED_BOOKING_URL,
      },
      {
        courseId: "upper-unionville",
        backendId: "clubhouse",
        date: "2026-07-10",
        time: "11:30",
        holes: 18,
        spotsAvailable: 4,
        price: 120,
        bookingUrl: EXPECTED_BOOKING_URL,
      },
    ];
    expect(first3).toEqual(expected);
  });

  it("reads a partially-filled row's real open-spot count (12:30, availPlayers:1)", () => {
    const partial = slots.find((s) => s.time === "12:30");
    expect(partial).toBeDefined();
    expect(partial?.spotsAvailable).toBe(1);
    expect(partial?.price).toBe(120);
  });

  it("every returned slot passes SlotSchema", () => {
    for (const s of slots) expect(SlotSchema.safeParse(s).success).toBe(true);
  });

  it("bookingUrl deep-links to THIS course's own ClubHouse widget (I3), not a generic landing", () => {
    for (const s of slots) {
      expect(s.bookingUrl).toBe(EXPECTED_BOOKING_URL);
      expect(s.bookingUrl).toContain("upperunionville.clubhouseonline-e3.net");
      expect(s.bookingUrl).not.toMatch(/^https:\/\/clubhouseonline-e3\.net\/?$/);
    }
  });
});

describe("clubhouse parser — ListQuery.holes filter", () => {
  it("holes:9 excludes rows that don't allow 9 (none in this fixture) -> []", () => {
    // Every bookable row in the real fixture allows both 9 and 18; a
    // synthetic row exercises the exclusion branch (see below), but we also
    // confirm the real fixture still honors an explicit 18 request.
    const slots18 = parseClubhouseResults(REAL_FIXTURE, UUGC, DATE, { holes: 18 });
    expect(slots18).toHaveLength(18);
    for (const s of slots18) expect(s.holes).toBe(18);
  });

  it("a row allowing only 9 holes is excluded when holes:18 is requested, and included as 9 when holes:9 is requested", () => {
    const envelope = {
      retCode: 0,
      title: null,
      infoMsg: null,
      errorMessage: null,
      displayMessage: null,
      serverStackTrace: null,
      result: true,
      data: {
        availability: [],
        teeSheet: [
          {
            teeSheetTimeId: 1,
            availableToPublic: true,
            isBookable: true,
            nineAllowed: true,
            eighteenAllowed: false,
            teeTime: "09:00:00",
            availPlayers: 2,
            playerCost: 50,
          },
        ],
      },
    };
    const json = JSON.stringify(envelope);
    expect(parseClubhouseResults(json, UUGC, DATE, { holes: 18 })).toEqual([]);
    const nineOnly = parseClubhouseResults(json, UUGC, DATE, { holes: 9 });
    expect(nineOnly).toHaveLength(1);
    expect(nineOnly[0]?.holes).toBe(9);
  });
});

describe("clubhouse parser — envelope unwrap / empty-vs-broken (invariant I1)", () => {
  it("retCode !== 0 -> AdapterError", () => {
    const json = JSON.stringify({
      retCode: 42,
      title: null,
      infoMsg: null,
      errorMessage: null,
      displayMessage: "Course not found",
      serverStackTrace: null,
      data: { availability: [], teeSheet: [] },
      result: false,
    });
    try {
      parseClubhouseResults(json, UUGC, DATE, {});
      throw new Error("expected parseClubhouseResults to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind).toBe("parse");
      expect((err as AdapterError).backendId).toBe("clubhouse");
      expect((err as AdapterError).message).toContain("Course not found");
    }
  });

  it("errorMessage present (even with retCode:0) -> AdapterError", () => {
    const json = JSON.stringify({
      retCode: 0,
      title: null,
      infoMsg: null,
      errorMessage: "session expired",
      displayMessage: null,
      serverStackTrace: null,
      data: { availability: [], teeSheet: [] },
      result: false,
    });
    expect(() => parseClubhouseResults(json, UUGC, DATE, {})).toThrow(AdapterError);
    try {
      parseClubhouseResults(json, UUGC, DATE, {});
    } catch (err) {
      expect((err as AdapterError).kind).toBe("parse");
    }
  });

  it("empty data.teeSheet -> [] (REAL 'no times', never conflated with an error)", () => {
    const json = JSON.stringify({
      retCode: 0,
      title: null,
      infoMsg: null,
      errorMessage: null,
      displayMessage: null,
      serverStackTrace: null,
      data: { availability: [], teeSheet: [] },
      result: true,
    });
    expect(parseClubhouseResults(json, UUGC, DATE, {})).toEqual([]);
  });

  it("zero bookable rows (all present but none public+bookable) -> []", () => {
    const json = JSON.stringify({
      retCode: 0,
      title: null,
      infoMsg: null,
      errorMessage: null,
      displayMessage: null,
      serverStackTrace: null,
      data: {
        availability: [],
        teeSheet: [
          { teeSheetTimeId: 1, availableToPublic: true, isBookable: false, nineAllowed: true, eighteenAllowed: true, teeTime: "09:00:00", availPlayers: 0, playerCost: 100 },
          { teeSheetTimeId: 2, availableToPublic: false, isBookable: true, nineAllowed: true, eighteenAllowed: true, teeTime: "10:00:00", availPlayers: 4, playerCost: 100 },
        ],
      },
      result: true,
    });
    expect(parseClubhouseResults(json, UUGC, DATE, {})).toEqual([]);
  });

  it("non-JSON body (HTML 404 page) -> AdapterError kind 'parse'", () => {
    const html = "<html><body>404 Not Found</body></html>";
    try {
      parseClubhouseResults(html, UUGC, DATE, {});
      throw new Error("expected parseClubhouseResults to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind).toBe("parse");
    }
  });

  it("envelope-shape guard: top-level non-object -> AdapterError 'parse'", () => {
    expect(() => parseClubhouseResults("42", UUGC, DATE, {})).toThrow(AdapterError);
    expect(() => parseClubhouseResults("null", UUGC, DATE, {})).toThrow(AdapterError);
  });

  it("envelope-shape guard: missing 'data' -> AdapterError 'parse'", () => {
    const json = JSON.stringify({ retCode: 0, errorMessage: null });
    try {
      parseClubhouseResults(json, UUGC, DATE, {});
      throw new Error("expected parseClubhouseResults to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind).toBe("parse");
    }
  });

  it("envelope-shape guard: data.teeSheet missing/not-an-array -> AdapterError 'parse'", () => {
    const json = JSON.stringify({ retCode: 0, errorMessage: null, data: { availability: [] } });
    expect(() => parseClubhouseResults(json, UUGC, DATE, {})).toThrow(AdapterError);

    const json2 = JSON.stringify({ retCode: 0, errorMessage: null, data: { teeSheet: "not-an-array" } });
    expect(() => parseClubhouseResults(json2, UUGC, DATE, {})).toThrow(AdapterError);
  });
});

describe("normalizeTeeTime — tz format correctness (I2)", () => {
  it("HH:MM:SS -> HH:MM, pure string formatting, no tz math", () => {
    expect(normalizeTeeTime("07:50:00")).toBe("07:50");
    expect(normalizeTeeTime("00:05:00")).toBe("00:05");
    expect(normalizeTeeTime("23:59:59")).toBe("23:59");
  });

  it("is identical across a summer and winter date (no DST offset introduced)", () => {
    const summer = parseClubhouseResults(REAL_FIXTURE, UUGC, "2026-07-10", {});
    const winterJson = REAL_FIXTURE; // same rows, only the request date differs
    const winter = parseClubhouseResults(winterJson, UUGC, "2026-01-10", {});
    expect(summer[0]?.time).toBe(winter[0]?.time);
    expect(summer[0]?.time).toBe("07:50");
  });

  it("rejects malformed times", () => {
    expect(normalizeTeeTime("25:00:00")).toBeNull();
    expect(normalizeTeeTime("07:99:00")).toBeNull();
    expect(normalizeTeeTime("not-a-time")).toBeNull();
    expect(normalizeTeeTime("07:50")).toBeNull(); // missing seconds segment
  });
});

describe("clubhouseAvailabilityUrl — path-style endpoint shape (tee-times-j0v NOTES)", () => {
  it("matches the exact verified live capture for players=1", () => {
    const url = clubhouseAvailabilityUrl(UUGC, "2026-07-10", { players: 1 });
    expect(url).toBe(
      "https://upperunionville.clubhouseonline-e3.net/api/v1/teetimes/GetAvailableTeeTimes/20260710/1258/0/1/false",
    );
  });

  it("uses literal 'null' players segment when players is unspecified (front-end default)", () => {
    const url = clubhouseAvailabilityUrl(UUGC, "2026-07-10", {});
    expect(url).toContain("/20260710/1258/0/null/false");
  });

  it("accepts a bare (non-FQDN) host and appends the tenant suffix", () => {
    const bare: ClubhouseRef = { backend: "clubhouse", host: "upperunionville", courseId: "1258", externalId: "UUGC" };
    const url = clubhouseAvailabilityUrl(bare, "2026-07-10", { players: 1 });
    expect(url).toContain("https://upperunionville.clubhouseonline-e3.net/");
  });

  it("clamps an out-of-range player count into 1-4", () => {
    expect(clubhouseAvailabilityUrl(UUGC, "2026-07-10", { players: 9 })).toContain("/0/4/false");
    expect(clubhouseAvailabilityUrl(UUGC, "2026-07-10", { players: 0 })).toContain("/0/1/false");
  });
});

describe("courseBookingUrl", () => {
  it("is a valid, course-specific URL", () => {
    const url = courseBookingUrl(UUGC);
    expect(url).toBe(EXPECTED_BOOKING_URL);
    expect(() => new URL(url)).not.toThrow();
  });
});
