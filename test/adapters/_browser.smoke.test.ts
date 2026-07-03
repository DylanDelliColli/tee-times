import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, loadCassette, withPage } from "./_browser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");

afterAll(async () => {
  await closeBrowser();
});

describe("_browser harness — withPage over a REAL headless chromium", () => {
  it("setContent + textContent round-trips over a real browser (not jsdom)", async () => {
    const text = await withPage("<div id=x>hi</div>", (page) => page.textContent("#x"));
    expect(text).toBe("hi");
  });

  it("evaluates real browser globals (proves it's chromium, not a DOM shim)", async () => {
    const ua = await withPage("<div>ignored</div>", (page) =>
      page.evaluate(() => navigator.userAgent),
    );
    expect(ua).toContain("HeadlessChrome");
  });

  it("each withPage call gets a fresh page (no leaked state between calls)", async () => {
    await withPage("<div id=x>first</div>", (page) => page.textContent("#x"));
    const second = await withPage("<div id=y>second</div>", (page) => page.textContent("#y"));
    expect(second).toBe("second");
  });
});

describe("loadCassette — unwraps JSON-string-encoded browser-flavor fixtures", () => {
  it("unwraps the Tee-On double-encoded HTML cassette to raw HTML bytes", () => {
    const html = loadCassette(
      join(FIXTURES_ROOT, "tee-on", "logc-browser-results-2026-07-10.html"),
    );
    expect(html.startsWith('"')).toBe(false);
    expect(html).toContain("<html");
  });

  it("unwraps the TEI Unify double-encoded HTML cassette to raw HTML bytes", () => {
    const html = loadCassette(
      join(FIXTURES_ROOT, "tei-unify", "golfthe6ix-teesheet-browser-2026-07-03.html"),
    );
    expect(html.startsWith('"')).toBe(false);
    expect(html).toContain("<body");
  });

  it("unwraps the Chronogolf double-encoded JSON cassette to raw JSON text", () => {
    const jsonText = loadCassette(
      join(FIXTURES_ROOT, "chronogolf", "bantys-19628-teetimes-2026-07-03.json"),
    );
    expect(jsonText.startsWith('"')).toBe(false);
    // Should now be plain (single-encoded) JSON, parseable exactly once.
    const parsed = JSON.parse(jsonText) as { status: string; teetimes: unknown[] };
    expect(parsed.status).toBe("open");
    expect(Array.isArray(parsed.teetimes)).toBe(true);
  });

  it("unwrapped Tee-On HTML round-trips through a real browser page", async () => {
    const html = loadCassette(
      join(FIXTURES_ROOT, "tee-on", "logc-browser-results-2026-07-10.html"),
    );
    const hasHtmlTag = await withPage(html, (page) =>
      page.evaluate(() => document.documentElement.outerHTML.length > 0),
    );
    expect(hasHtmlTag).toBe(true);
  });

  it("passes hand-authored (non-wrapped) fixtures through unchanged", () => {
    const html = loadCassette(join(FIXTURES_ROOT, "tee-on", "logc-empty-2026-07-15.html"));
    expect(html).toContain("<");
  });
});
