import { describe, it, expect } from "vitest";
import {
  parseTeeOnResults,
  normalizeTime,
  courseBookingUrl,
} from "../../src/adapters/tee-on.js";
import { SlotSchema, type Slot } from "../../src/core/slot.js";
import { AdapterError } from "../../src/core/errors.js";
import type { TeeOnRef } from "../../src/core/adapter.js";
import { loadFixture } from "./_fixtures.js";

const LOGC: TeeOnRef = { backend: "tee-on", courseCode: "LOGC", courseGroupId: "10880" };
const DATE = "2026-07-15";
const EXPECTED_BOOKING_URL =
  "https://www.tee-on.com/PubGolf/servlet/com.teeon.teesheet.servlets.golfersection." +
  "WebBookingSearchSteps?CourseGroupID=10880&CourseCode=LOGC&Date=2026-07-15";

describe("tee-on parser — populated results (synthetic fixture, real showLogin contract)", () => {
  const slots = parseTeeOnResults(
    loadFixture("logc-results-populated-synthetic-2026-07-15.html"),
    LOGC,
    DATE,
  );

  it("extracts every tee-time row", () => {
    expect(slots).toHaveLength(5);
  });

  it("parses the first rows to EXACT Slot shape", () => {
    const first3 = slots.slice(0, 3);
    const expected: Slot[] = [
      {
        courseId: "lowville",
        backendId: "tee-on",
        date: "2026-07-15",
        time: "07:30",
        holes: 18,
        spotsAvailable: 4,
        bookingUrl: EXPECTED_BOOKING_URL,
      },
      {
        courseId: "lowville",
        backendId: "tee-on",
        date: "2026-07-15",
        time: "07:40",
        holes: 18,
        spotsAvailable: 3,
        bookingUrl: EXPECTED_BOOKING_URL,
      },
      {
        courseId: "lowville",
        backendId: "tee-on",
        date: "2026-07-15",
        time: "08:00",
        holes: 18,
        spotsAvailable: 2,
        bookingUrl: EXPECTED_BOOKING_URL,
      },
    ];
    expect(first3).toEqual(expected);
  });

  it("normalizes 12:00 pm -> 12:00 (noon) and keeps 18 holes", () => {
    const noon = slots.find((s) => s.time === "12:00");
    expect(noon).toBeDefined();
    expect(noon?.holes).toBe(18);
    expect(noon?.spotsAvailable).toBe(4);
  });

  it("normalizes 2:30 pm -> 14:30 and reads 9-hole rows", () => {
    const nine = slots.find((s) => s.holes === 9);
    expect(nine?.time).toBe("14:30");
    expect(nine?.spotsAvailable).toBe(1);
  });

  it("every returned slot passes SlotSchema", () => {
    for (const s of slots) expect(SlotSchema.safeParse(s).success).toBe(true);
  });

  it("bookingUrl deep-links to THIS course's own Tee-On page (I3)", () => {
    for (const s of slots) {
      expect(s.bookingUrl).toContain("CourseCode=LOGC");
      expect(s.bookingUrl).toContain("CourseGroupID=10880");
      expect(s.bookingUrl).toContain("Date=2026-07-15");
      expect(s.bookingUrl).toMatch(/^https:\/\/www\.tee-on\.com\/PubGolf\/servlet\/.*WebBooking/);
      // NOT a generic backend landing.
      expect(s.bookingUrl).not.toMatch(/tee-on\.com\/?$/);
    }
  });
});

describe("tee-on parser — empty vs broken (invariant I1)", () => {
  it("REAL captured LOGC results page is an empty sheet -> [] (real-data anchor)", () => {
    const slots = parseTeeOnResults(loadFixture("logc-results-2026-07-15.html"), LOGC, DATE);
    expect(slots).toEqual([]);
  });

  it("compact empty-sheet fixture -> []", () => {
    const slots = parseTeeOnResults(loadFixture("logc-empty-2026-07-15.html"), LOGC, DATE);
    expect(slots).toEqual([]);
  });

  it("malformed/garbage markup -> throws AdapterError kind 'parse'", () => {
    try {
      parseTeeOnResults(loadFixture("logc-malformed-2026-07-15.html"), LOGC, DATE);
      throw new Error("expected parseTeeOnResults to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind).toBe("parse");
      expect((err as AdapterError).backendId).toBe("tee-on");
    }
  });
});

describe("normalizeTime — format + DST correctness (I2)", () => {
  it("12h am/pm -> 24h HH:MM", () => {
    expect(normalizeTime("7:30 am")).toBe("07:30");
    expect(normalizeTime("7:30 AM")).toBe("07:30");
    expect(normalizeTime("12:00 pm")).toBe("12:00"); // noon
    expect(normalizeTime("12:15 am")).toBe("00:15"); // midnight hour
    expect(normalizeTime("2:30 pm")).toBe("14:30");
    expect(normalizeTime("11:45 pm")).toBe("23:45");
  });

  it("already-24h passes through zero-padded", () => {
    expect(normalizeTime("07:30")).toBe("07:30");
    expect(normalizeTime("7:05")).toBe("07:05");
    expect(normalizeTime("14:00")).toBe("14:00");
  });

  it("is pure string formatting — applies NO timezone/DST offset", () => {
    // Same wall-clock label must normalize identically regardless of calendar
    // date. Tee-On times are already course-local (I2); we never do TZ math, so
    // a summer date and a winter date can never diverge.
    const summer = parseTeeOnResults(
      buildRow("7:30 am", "18"),
      LOGC,
      "2026-07-15", // EDT (DST in effect, Ontario)
    );
    const winter = parseTeeOnResults(
      buildRow("7:30 am", "18"),
      LOGC,
      "2026-01-15", // EST (no DST)
    );
    expect(summer[0]?.time).toBe("07:30");
    expect(winter[0]?.time).toBe("07:30");
    expect(summer[0]?.time).toBe(winter[0]?.time);
  });

  it("rejects non-times", () => {
    expect(normalizeTime("Time")).toBeNull();
    expect(normalizeTime("")).toBeNull();
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("7:99 am")).toBeNull();
  });
});

describe("courseBookingUrl", () => {
  it("is a valid course-specific URL", () => {
    const url = courseBookingUrl(LOGC, DATE);
    expect(url).toBe(EXPECTED_BOOKING_URL);
    expect(() => new URL(url)).not.toThrow();
  });
});

/** Minimal populated results shell with one showLogin row, for focused tests. */
function buildRow(time: string, holes: string): string {
  return (
    `<html><body><div class="search-results-tee-times-wrapper">` +
    `<div class="search-results-tee-time" ` +
    `onclick="showLogin('LOGC','1','2026-07-15','${time}','${holes}',false,false,'1','')">` +
    `<span>${time}</span><span>4 available</span></div></div></body></html>`
  );
}
