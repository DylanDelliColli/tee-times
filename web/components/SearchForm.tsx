"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { SearchQuery } from "../../src/search/search.js";

export interface CourseOption {
  courseId: string;
  displayName: string;
}

export interface SearchFormProps {
  onSearch: (query: SearchQuery) => void;
  courseOptions: readonly CourseOption[];
  initialQuery?: SearchQuery;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The one shared search form (date OR date-range, time window, players,
 * holes, optional course subset). No login/account fields — this is a
 * group-wide, no-account page (A2). Submitting calls `onSearch` with a
 * SearchQuery; the page wires that to a fetch against web/app/api/search.
 */
export function SearchForm({ onSearch, courseOptions, initialQuery }: SearchFormProps) {
  const [mode, setMode] = useState<"single" | "range">(initialQuery?.dateRange ? "range" : "single");
  const [date, setDate] = useState(initialQuery?.date ?? todayIso());
  const [rangeStart, setRangeStart] = useState(initialQuery?.dateRange?.start ?? todayIso());
  const [rangeEnd, setRangeEnd] = useState(initialQuery?.dateRange?.end ?? todayIso());
  const [timeStart, setTimeStart] = useState(initialQuery?.timeWindow?.start ?? "");
  const [timeEnd, setTimeEnd] = useState(initialQuery?.timeWindow?.end ?? "");
  const [players, setPlayers] = useState(initialQuery?.players?.toString() ?? "");
  const [holes, setHoles] = useState(initialQuery?.holes?.toString() ?? "");
  const [selectedCourseIds, setSelectedCourseIds] = useState<string[]>(initialQuery?.courseIds ?? []);

  function toggleCourse(courseId: string) {
    setSelectedCourseIds((prev) =>
      prev.includes(courseId) ? prev.filter((id) => id !== courseId) : [...prev, courseId],
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const query: SearchQuery = mode === "single" ? { date } : { dateRange: { start: rangeStart, end: rangeEnd } };

    if (timeStart && timeEnd) {
      query.timeWindow = { start: timeStart, end: timeEnd };
    }
    if (players) {
      const n = Number(players);
      if (Number.isFinite(n) && n > 0) {
        query.players = n;
      }
    }
    if (holes === "9" || holes === "18") {
      query.holes = Number(holes) as 9 | 18;
    }
    if (selectedCourseIds.length > 0) {
      query.courseIds = selectedCourseIds;
    }

    onSearch(query);
  }

  return (
    <form onSubmit={handleSubmit} className="search-form" aria-label="Search tee times">
      <fieldset>
        <legend>When</legend>
        <label>
          <input
            type="radio"
            name="date-mode"
            value="single"
            checked={mode === "single"}
            onChange={() => setMode("single")}
          />
          Single date
        </label>
        <label>
          <input
            type="radio"
            name="date-mode"
            value="range"
            checked={mode === "range"}
            onChange={() => setMode("range")}
          />
          Date range
        </label>

        {mode === "single" ? (
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        ) : (
          <>
            <label>
              From
              <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
            </label>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Time window</legend>
        <label>
          From
          <input type="time" value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
        </label>
        <label>
          To
          <input type="time" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Players &amp; holes</legend>
        <label>
          Players
          <input
            type="number"
            min={1}
            max={4}
            value={players}
            onChange={(e) => setPlayers(e.target.value)}
          />
        </label>
        <label>
          Holes
          <select value={holes} onChange={(e) => setHoles(e.target.value)}>
            <option value="">Any</option>
            <option value="9">9</option>
            <option value="18">18</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Courses (leave all unchecked for every course)</legend>
        {courseOptions.map((course) => (
          <label key={course.courseId}>
            <input
              type="checkbox"
              checked={selectedCourseIds.includes(course.courseId)}
              onChange={() => toggleCourse(course.courseId)}
            />
            {course.displayName}
          </label>
        ))}
      </fieldset>

      <button type="submit">Search</button>
    </form>
  );
}
