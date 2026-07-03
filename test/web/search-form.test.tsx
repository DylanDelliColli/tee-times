// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { SearchForm } from "../../web/components/SearchForm.js";
import type { SearchQuery } from "../../src/search/search.js";

afterEach(() => {
  cleanup();
});

const COURSE_OPTIONS = [
  { courseId: "lowville", displayName: "Lowville Golf Course" },
  { courseId: "granite", displayName: "Granite Golf Club" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Date-typed "From"/"To" inputs live in the "When" fieldset; time-typed ones in "Time window". */
function dateInputLabelled(name: "From" | "To"): HTMLInputElement {
  const candidates = screen.getAllByLabelText(name) as HTMLInputElement[];
  const match = candidates.find((el) => el.type === "date");
  if (!match) throw new Error(`no date-typed input labelled "${name}"`);
  return match;
}

function timeInputLabelled(name: "From" | "To"): HTMLInputElement {
  const candidates = screen.getAllByLabelText(name) as HTMLInputElement[];
  const match = candidates.find((el) => el.type === "time");
  if (!match) throw new Error(`no time-typed input labelled "${name}"`);
  return match;
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
}

/** The SearchQuery passed to onSearch's first call (asserts it was actually called). */
function submittedQuery(onSearch: ReturnType<typeof vi.fn<(query: SearchQuery) => void>>): SearchQuery {
  const call = onSearch.mock.calls[0];
  if (!call) throw new Error("onSearch was not called");
  return call[0];
}

describe("SearchForm (unit, onSearch spy)", () => {
  it("single-date: defaults to today's date in single mode and submits { date }", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    submit();

    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith({ date: todayIso() });
  });

  it("single-date: changing the date input updates the submitted date", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-08-01" } });
    submit();

    expect(onSearch).toHaveBeenCalledWith({ date: "2026-08-01" });
  });

  it("date-range: switching to range mode submits { dateRange: { start, end } }, no `date` field", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.click(screen.getByLabelText("Date range"));
    fireEvent.change(dateInputLabelled("From"), { target: { value: "2026-08-01" } });
    fireEvent.change(dateInputLabelled("To"), { target: { value: "2026-08-05" } });
    submit();

    expect(onSearch).toHaveBeenCalledTimes(1);
    const query = submittedQuery(onSearch);
    expect(query).toEqual({ dateRange: { start: "2026-08-01", end: "2026-08-05" } });
    expect(query.date).toBeUndefined();
  });

  it("time-window: setting both From and To submits timeWindow alongside the date", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(timeInputLabelled("From"), { target: { value: "07:00" } });
    fireEvent.change(timeInputLabelled("To"), { target: { value: "11:00" } });
    submit();

    expect(onSearch).toHaveBeenCalledWith({
      date: todayIso(),
      timeWindow: { start: "07:00", end: "11:00" },
    });
  });

  it("time-window: setting only one of From/To omits timeWindow entirely (component requires both)", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(timeInputLabelled("From"), { target: { value: "07:00" } });
    submit();

    const query = submittedQuery(onSearch);
    expect(query.timeWindow).toBeUndefined();
  });

  it("players: entering a player count submits it as a number", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "3" } });
    submit();

    const query = submittedQuery(onSearch);
    expect(query.players).toBe(3);
    expect(typeof query.players).toBe("number");
  });

  it("players: leaving the field blank omits `players` from the query", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    submit();

    const query = submittedQuery(onSearch);
    expect(query.players).toBeUndefined();
  });

  it("holes: selecting 9 submits holes: 9 (as a number)", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(screen.getByLabelText("Holes"), { target: { value: "9" } });
    submit();

    const query = submittedQuery(onSearch);
    expect(query.holes).toBe(9);
  });

  it("holes: selecting 18 submits holes: 18 (as a number)", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(screen.getByLabelText("Holes"), { target: { value: "18" } });
    submit();

    const query = submittedQuery(onSearch);
    expect(query.holes).toBe(18);
  });

  it("holes: leaving the select on 'Any' omits `holes` from the query", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    submit();

    const query = submittedQuery(onSearch);
    expect(query.holes).toBeUndefined();
  });

  it("course subset: checking one course submits courseIds with just that course", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.click(screen.getByLabelText("Granite Golf Club"));
    submit();

    const query = submittedQuery(onSearch);
    expect(query.courseIds).toEqual(["granite"]);
  });

  it("course subset: checking multiple courses submits all selected courseIds in click order", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.click(screen.getByLabelText("Granite Golf Club"));
    fireEvent.click(screen.getByLabelText("Lowville Golf Course"));
    submit();

    const query = submittedQuery(onSearch);
    expect(query.courseIds).toEqual(["granite", "lowville"]);
  });

  it("course subset: leaving all courses unchecked omits `courseIds` (search defaults to every course)", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    submit();

    const query = submittedQuery(onSearch);
    expect(query.courseIds).toBeUndefined();
  });

  it("course subset: unchecking a previously-checked course removes it from courseIds", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    const graniteCheckbox = screen.getByLabelText("Granite Golf Club");
    fireEvent.click(graniteCheckbox); // check
    fireEvent.click(graniteCheckbox); // uncheck
    submit();

    const query = submittedQuery(onSearch);
    expect(query.courseIds).toBeUndefined();
  });

  it("initialQuery: pre-populates a date-range + players + holes form and resubmits it unchanged", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    const initialQuery: SearchQuery = {
      dateRange: { start: "2026-09-01", end: "2026-09-03" },
      players: 2,
      holes: 18,
      courseIds: ["lowville"],
    };
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} initialQuery={initialQuery} />);

    // Range mode should be pre-selected because initialQuery.dateRange was given.
    expect((screen.getByLabelText("Date range") as HTMLInputElement).checked).toBe(true);

    submit();

    expect(onSearch).toHaveBeenCalledWith(initialQuery);
  });

  it("combined: date + time window + players + holes + course subset all land on one SearchQuery", () => {
    const onSearch = vi.fn<(query: SearchQuery) => void>();
    render(<SearchForm onSearch={onSearch} courseOptions={COURSE_OPTIONS} />);

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-08-01" } });
    fireEvent.change(timeInputLabelled("From"), { target: { value: "07:00" } });
    fireEvent.change(timeInputLabelled("To"), { target: { value: "11:00" } });
    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Holes"), { target: { value: "9" } });
    fireEvent.click(screen.getByLabelText("Lowville Golf Course"));
    submit();

    expect(onSearch).toHaveBeenCalledWith({
      date: "2026-08-01",
      timeWindow: { start: "07:00", end: "11:00" },
      players: 4,
      holes: 9,
      courseIds: ["lowville"],
    });
  });
});
