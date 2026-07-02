// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SearchResultsView } from "../../web/components/SearchResultsView.js";
import type { SearchResult } from "../../src/search/search.js";
import type { Slot } from "../../src/core/slot.js";

afterEach(() => {
  cleanup();
});

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    courseId: "lowville",
    backendId: "tee-on",
    date: "2026-07-15",
    time: "07:30",
    holes: 18,
    spotsAvailable: 4,
    bookingUrl: "https://www.tee-on.com/PubGolf/lowville/book",
    ...overrides,
  };
}

// Fixed, pre-sorted-by-search() SearchResult: one healthy course (2 slots),
// one stale course (1 slot), and one deep-link-only course (0 slots).
const FIXED_RESULT: SearchResult = {
  slots: [
    makeSlot({ courseId: "lowville", time: "07:00", bookingUrl: "https://www.tee-on.com/PubGolf/lowville/0700" }),
    makeSlot({ courseId: "granite", time: "09:00", bookingUrl: "https://www.tee-on.com/PubGolf/granite/0900" }),
    makeSlot({ courseId: "lowville", time: "14:00", bookingUrl: "https://www.tee-on.com/PubGolf/lowville/1400" }),
  ],
  courses: [
    { courseId: "lowville", displayName: "Lowville Golf Course", state: "healthy", fetchedAt: 1_800_000_000_000 },
    {
      courseId: "granite",
      displayName: "Granite Golf Club",
      state: "stale",
      fetchedAt: 1_800_000_000_000 - 25 * 60_000, // 25 minutes before `now` below
    },
    {
      courseId: "lakeview",
      displayName: "Lakeview Golf Course",
      state: "deep-link-only",
      deepLinkUrl: "https://lakeviewgc.ezlinksgolf.com/",
    },
  ],
};

const NOW = 1_800_000_000_000;

describe("SearchResultsView (unit, fixed SearchResult prop)", () => {
  it("renders slots in the time-sorted order they arrive in (search() already sorts; this view must not re-shuffle them)", () => {
    render(<SearchResultsView result={FIXED_RESULT} now={NOW} />);

    const rows = screen.getAllByTestId("slot-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("07:00"),
      expect.stringContaining("09:00"),
      expect.stringContaining("14:00"),
    ]);
  });

  it("each row's Book link points at slot.bookingUrl and opens in a new tab safely", () => {
    render(<SearchResultsView result={FIXED_RESULT} now={NOW} />);

    const bookLinks = screen.getAllByRole("link", { name: /book/i });
    expect(bookLinks).toHaveLength(3);

    const hrefs = bookLinks.map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(FIXED_RESULT.slots.map((s) => s.bookingUrl));

    for (const link of bookLinks) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  it("a stale course shows the stale badge with its age", () => {
    render(<SearchResultsView result={FIXED_RESULT} now={NOW} />);

    const staleBadge = screen.getByTestId("stale-badge");
    expect(staleBadge.textContent).toMatch(/stale/i);
    expect(staleBadge.textContent).toMatch(/~25 min old/);
  });

  it("a deep-link-only course shows 'check times ->' linking to its deepLinkUrl", () => {
    render(<SearchResultsView result={FIXED_RESULT} now={NOW} />);

    const deepLink = screen.getByRole("link", { name: /check times/i });
    expect(deepLink.getAttribute("href")).toBe("https://lakeviewgc.ezlinksgolf.com/");
    expect(deepLink.getAttribute("target")).toBe("_blank");
  });

  it("renders a clear 'no tee times' message when there are no slots", () => {
    const empty: SearchResult = { slots: [], courses: [] };
    render(<SearchResultsView result={empty} now={NOW} />);

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState.textContent).toMatch(/no tee times/i);
    expect(screen.queryAllByTestId("slot-row")).toHaveLength(0);
  });

  it("ALL-DEGRADED: every course stale/deep-link-only still shows a per-course status section, not a blank page", () => {
    const allDegraded: SearchResult = {
      slots: [],
      courses: [
        { courseId: "lakeview", displayName: "Lakeview Golf Course", state: "deep-link-only", deepLinkUrl: "https://lakeviewgc.ezlinksgolf.com/" },
        { courseId: "braeben", displayName: "BraeBen Golf Course", state: "deep-link-only", deepLinkUrl: "https://braeben.ezlinksgolf.com/" },
        { courseId: "granite", displayName: "Granite Golf Club", state: "stale", fetchedAt: NOW - 60_000 },
      ],
    };
    render(<SearchResultsView result={allDegraded} now={NOW} />);

    // Not blank: all 3 course-status rows are present with working links/badges.
    expect(screen.getAllByTestId("course-status")).toHaveLength(3);
    expect(screen.getAllByTestId("deep-link")).toHaveLength(2);
    expect(screen.getByTestId("stale-badge")).toBeTruthy();
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });

  it("contains NO login/password/account UI anywhere in the DOM", () => {
    const { container } = render(<SearchResultsView result={FIXED_RESULT} now={NOW} />);

    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByRole("textbox", { name: /username|email|login/i })).toBeNull();
    expect(container.textContent?.toLowerCase()).not.toMatch(/log in|log out|sign in|sign up|password|account/);
  });
});
