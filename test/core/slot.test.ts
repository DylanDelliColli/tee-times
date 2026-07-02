import { describe, it, expect } from "vitest";
import {
  SlotSchema,
  slotKey,
  classifyChange,
  type Slot,
} from "../../src/core/slot.js";
import { AdapterError } from "../../src/core/errors.js";

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    courseId: "flemingdon",
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    bookingUrl: "https://example.com/book/flemingdon/2026-07-15/0730",
    ...overrides,
  };
}

describe("slotKey", () => {
  it("is stable: same identity fields -> same key regardless of attributes", () => {
    const a = makeSlot({ spotsAvailable: 4, price: 60, bookingUrl: "https://a.example.com/x" });
    const b = makeSlot({ spotsAvailable: 1, price: 99, bookingUrl: "https://b.example.com/y" });
    expect(slotKey(a)).toBe(slotKey(b));
    expect(slotKey(a)).toBe("flemingdon|2026-07-15|07:30|18");
  });

  it("does not collide across differing courseId", () => {
    expect(slotKey(makeSlot({ courseId: "a" }))).not.toBe(slotKey(makeSlot({ courseId: "b" })));
  });

  it("does not collide across differing date", () => {
    expect(slotKey(makeSlot({ date: "2026-07-15" }))).not.toBe(slotKey(makeSlot({ date: "2026-07-16" })));
  });

  it("does not collide across differing time", () => {
    expect(slotKey(makeSlot({ time: "07:30" }))).not.toBe(slotKey(makeSlot({ time: "07:40" })));
  });

  it("does not collide across differing holes", () => {
    expect(slotKey(makeSlot({ holes: 9 }))).not.toBe(slotKey(makeSlot({ holes: 18 })));
  });

  it("produces distinct keys for a batch of differing slots (no collisions)", () => {
    const slots = [
      makeSlot({ courseId: "a", date: "2026-07-15", time: "07:30", holes: 18 }),
      makeSlot({ courseId: "a", date: "2026-07-15", time: "07:30", holes: 9 }),
      makeSlot({ courseId: "a", date: "2026-07-15", time: "07:40", holes: 18 }),
      makeSlot({ courseId: "a", date: "2026-07-16", time: "07:30", holes: 18 }),
      makeSlot({ courseId: "b", date: "2026-07-15", time: "07:30", holes: 18 }),
    ];
    const keys = slots.map(slotKey);
    expect(new Set(keys).size).toBe(slots.length);
  });
});

describe("classifyChange (G1 table)", () => {
  it("NEW: key added (prev undefined, curr present with spots)", () => {
    expect(classifyChange(undefined, makeSlot({ spotsAvailable: 2 }))).toBe("NEW");
  });

  it("REMOVED: key gone (curr undefined)", () => {
    expect(classifyChange(makeSlot({ spotsAvailable: 3 }), undefined)).toBe("REMOVED");
  });

  it("REMOVED: spots X->0 (still keyed but no longer bookable)", () => {
    expect(classifyChange(makeSlot({ spotsAvailable: 3 }), makeSlot({ spotsAvailable: 0 }))).toBe("REMOVED");
  });

  it("FREED: spots increased 0->2", () => {
    expect(classifyChange(makeSlot({ spotsAvailable: 0 }), makeSlot({ spotsAvailable: 2 }))).toBe("FREED");
  });

  it("FREED: spots increased 1->4", () => {
    expect(classifyChange(makeSlot({ spotsAvailable: 1 }), makeSlot({ spotsAvailable: 4 }))).toBe("FREED");
  });

  it("FILLED: spots decreased but still bookable 4->2", () => {
    expect(classifyChange(makeSlot({ spotsAvailable: 4 }), makeSlot({ spotsAvailable: 2 }))).toBe("FILLED");
  });

  it("SAME: spots unchanged", () => {
    expect(classifyChange(makeSlot({ spotsAvailable: 3 }), makeSlot({ spotsAvailable: 3 }))).toBe("SAME");
  });

  it("SAME: both undefined", () => {
    expect(classifyChange(undefined, undefined)).toBe("SAME");
  });

  it("NEW takes precedence when prev absent and curr bookable", () => {
    expect(classifyChange(undefined, makeSlot({ spotsAvailable: 1 }))).toBe("NEW");
  });

  it("REMOVED when prev absent but curr has 0 spots (never NEW for unbookable)", () => {
    expect(classifyChange(undefined, makeSlot({ spotsAvailable: 0 }))).toBe("REMOVED");
  });
});

describe("SlotSchema (zod runtime validation)", () => {
  it("accepts a well-formed slot", () => {
    expect(SlotSchema.safeParse(makeSlot()).success).toBe(true);
  });

  it("accepts optional price and raw", () => {
    expect(SlotSchema.safeParse(makeSlot({ price: 59.5, raw: { foo: "bar" } })).success).toBe(true);
  });

  it("rejects a bad holes value (36)", () => {
    const bad = { ...makeSlot(), holes: 36 };
    expect(SlotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing required field (bookingUrl)", () => {
    const { bookingUrl, ...rest } = makeSlot();
    void bookingUrl;
    expect(SlotSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-integer spotsAvailable", () => {
    expect(SlotSchema.safeParse(makeSlot({ spotsAvailable: 2.5 })).success).toBe(false);
  });

  it("rejects negative spotsAvailable", () => {
    expect(SlotSchema.safeParse(makeSlot({ spotsAvailable: -1 })).success).toBe(false);
  });

  it("rejects malformed date", () => {
    expect(SlotSchema.safeParse(makeSlot({ date: "07/15/2026" })).success).toBe(false);
  });

  it("rejects malformed time", () => {
    expect(SlotSchema.safeParse(makeSlot({ time: "7:30" })).success).toBe(false);
  });

  it("rejects a non-url bookingUrl", () => {
    expect(SlotSchema.safeParse(makeSlot({ bookingUrl: "not a url" })).success).toBe(false);
  });

  it("rejects an unknown backendId", () => {
    const bad = { ...makeSlot(), backendId: "linkline" };
    expect(SlotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown extra keys (strict schema)", () => {
    const bad = { ...makeSlot(), sneaky: true };
    expect(SlotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("AdapterError", () => {
  it("carries all fields and is an instanceof Error", () => {
    const err = new AdapterError({
      backendId: "chronogolf",
      courseId: "don-valley",
      kind: "blocked",
      retryable: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.name).toBe("AdapterError");
    expect(err.backendId).toBe("chronogolf");
    expect(err.courseId).toBe("don-valley");
    expect(err.kind).toBe("blocked");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("chronogolf");
  });

  it("supports a custom message and cause", () => {
    const cause = new Error("socket hang up");
    const err = new AdapterError({
      backendId: "tei-unify",
      courseId: "the-6ix",
      kind: "network",
      retryable: true,
      message: "gateway timed out",
      cause,
    });
    expect(err.message).toBe("gateway timed out");
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(cause);
  });

  it("is throwable and catchable as AdapterError", () => {
    expect(() => {
      throw new AdapterError({
        backendId: "ezlinks",
        courseId: "glen-abbey",
        kind: "parse",
        retryable: false,
      });
    }).toThrow(AdapterError);
  });
});
