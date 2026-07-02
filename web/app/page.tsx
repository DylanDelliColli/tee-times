"use client";

import { useEffect, useState, useCallback } from "react";
import { SearchForm } from "../components/SearchForm.js";
import { SearchResultsView } from "../components/SearchResultsView.js";
import type { SearchQuery, SearchResult } from "../../src/search/search.js";
import { COURSES } from "../../src/core/courses.js";

const EMPTY_RESULT: SearchResult = { slots: [], courses: [] };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function queryToSearchParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.date) {
    params.set("date", query.date);
  }
  if (query.dateRange) {
    params.set("rangeStart", query.dateRange.start);
    params.set("rangeEnd", query.dateRange.end);
  }
  if (query.timeWindow) {
    params.set("timeStart", query.timeWindow.start);
    params.set("timeEnd", query.timeWindow.end);
  }
  if (query.players !== undefined) {
    params.set("players", String(query.players));
  }
  if (query.holes !== undefined) {
    params.set("holes", String(query.holes));
  }
  if (query.courseIds && query.courseIds.length > 0) {
    params.set("courseIds", query.courseIds.join(","));
  }
  return params;
}

const COURSE_OPTIONS = COURSES.map(({ courseId, displayName }) => ({ courseId, displayName }));

/**
 * The one shared page (no login/account UI anywhere, A2): a search form
 * driving GET /api/search, rendering the merged time-sorted results plus
 * per-course degradation badges. Defaults to searching "today" on first
 * load so the page never shows a blank form-only screen.
 */
export default function SearchPage() {
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async (query: SearchQuery) => {
    setLoading(true);
    setError(null);
    try {
      const params = queryToSearchParams(query);
      const res = await fetch(`/api/search?${params.toString()}`);
      const data = (await res.json()) as SearchResult;
      setResult(data);
    } catch {
      setError("Search failed — please try again.");
      setResult(EMPTY_RESULT);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runSearch({ date: todayIso() });
  }, [runSearch]);

  return (
    <main className="page">
      <h1>Tee Times</h1>
      <SearchForm onSearch={(q) => void runSearch(q)} courseOptions={COURSE_OPTIONS} initialQuery={{ date: todayIso() }} />
      {loading && <p role="status">Searching…</p>}
      {error && <p role="alert">{error}</p>}
      <SearchResultsView result={result} />
    </main>
  );
}
