import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Shared real-browser test harness for browser-flavor adapters (Tee-On,
 * TEI Unify, and any future adapter that needs a live DOM rather than a
 * cheerio/jsdom parse of raw HTML text).
 *
 * Mirrors the ergonomics of test/adapters/clubhouse.integration.test.ts's
 * makeCassette(): a small, reusable seam so adapter integration tests
 * compose REAL infrastructure (a real headless chromium here, a real
 * fetch->parse->normalize pipeline there) over recorded fixtures — never a
 * mocked parser.
 *
 * One chromium instance is launched lazily and reused for the lifetime of
 * the test file/process; call closeBrowser() in an `afterAll` if a test
 * file wants to explicitly release it (vitest also tears down the process
 * between files, so this is a courtesy, not a requirement).
 */

let browserPromise: Promise<Browser> | undefined;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/**
 * Launch (or reuse) a real headless chromium, open a fresh page, set its
 * content to `html`, run `fn(page)`, then close the page. The browser
 * itself is reused across calls within a process for speed; use
 * closeBrowser() to tear it down explicitly (e.g. in a file's afterAll).
 */
export async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** Close the shared browser instance, if one was launched. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = undefined;
  await browser.close();
}

/**
 * Load a recorded browser-flavor cassette fixture and return the REAL
 * bytes (HTML or JSON text) the adapter would have seen off the wire.
 *
 * The 2026-07-03 browser-flavor cassettes (Tee-On, TEI Unify, Chronogolf)
 * were captured JSON-STRING-ENCODED — the file on disk is one JSON string
 * literal wrapping the raw HTML/JSON, i.e. `"<html>...</html>"` rather than
 * `<html>...</html>`. A literal JSON.parse of that file AS the payload
 * TypeErrors downstream (e.g. cheerio/JSON.parse on the adapter's actual
 * response text), so this helper JSON.parse-unwraps exactly once to
 * reconstruct the original bytes before handing them to setContent/parse.
 *
 * Hand-authored fixtures that are already raw HTML/JSON (no wrapping
 * quote) are returned as-is — same leading-quote-sniff convention as
 * test/adapters/_fixtures.ts's loadFixture().
 */
export function loadCassette(path: string): string {
  const raw = readFileSync(path, "utf8");
  if (raw.startsWith('"')) {
    return JSON.parse(raw) as string;
  }
  return raw;
}
