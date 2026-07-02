import { describe, it, expect } from "vitest";
import { TeeOnAdapter } from "../../src/adapters/tee-on.js";
import { POLITE_USER_AGENT, type FetchImpl } from "../../src/adapters/http.js";
import { AdapterError } from "../../src/core/errors.js";
import type { TeeOnRef } from "../../src/core/adapter.js";
import { loadFixture } from "./_fixtures.js";

const LOGC: TeeOnRef = { backend: "tee-on", courseCode: "LOGC", courseGroupId: "10880" };
const DATE = "2026-07-15";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A canned response for the cassette. */
interface Canned {
  status: number;
  text: string;
  setCookie?: string;
}

/**
 * Build a recorded HTTP cassette: a fake fetch that replays real fixture bytes
 * for the step-2 GET and step-3 POST. This is REAL composition of the adapter's
 * fetch->parse->normalize pipeline; it just never touches the live network.
 */
function makeCassette(steps: Canned, results: Canned) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    const canned = url.includes("WebBookingSearchResults") ? results : steps;
    return {
      status: canned.status,
      async text() {
        return canned.text;
      },
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "set-cookie") return canned.setCookie ?? null;
          if (name.toLowerCase() === "content-type") return "text/html; charset=UTF-8";
          return null;
        },
      },
    };
  };
  return { requests, fetchImpl };
}

/** Deps that disable jitter/sleep so tests are fast and deterministic. */
function fastDeps(fetchImpl: FetchImpl) {
  return { fetch: { fetchImpl, jitterMs: 0, sleep: async () => {}, random: () => 0 } };
}

const STEPS_HTML = loadFixture("logc-2026-07-15.html");
const POPULATED_HTML = loadFixture("logc-results-populated-synthetic-2026-07-15.html");
const REAL_EMPTY_HTML = loadFixture("logc-results-2026-07-15.html");
const SESSION_COOKIE = "JSESSIONID=abc123anon; Path=/PubGolf; HttpOnly";

describe("TeeOnAdapter integration — recorded cassette (fetch->parse->normalize)", () => {
  it("drives the anonymous 2-step flow and returns normalized slots", async () => {
    const { requests, fetchImpl } = makeCassette(
      { status: 200, text: STEPS_HTML, setCookie: SESSION_COOKIE },
      { status: 200, text: POPULATED_HTML },
    );
    const adapter = new TeeOnAdapter(fastDeps(fetchImpl));
    const slots = await adapter.listSlots(LOGC, DATE, { players: 4, holes: 18 });

    expect(slots).toHaveLength(5);
    expect(slots[0]).toMatchObject({ courseId: "lowville", time: "07:30", holes: 18, spotsAvailable: 4 });

    // Two requests: GET steps, then POST results.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toContain("WebBookingSearchSteps");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toContain("WebBookingSearchResults");
    expect(requests[1]?.body).toContain("CourseIdLOGC=LOGC");
    expect(requests[1]?.body).toContain("CourseGroupID=10880");
    expect(requests[1]?.body).toContain("Date=2026-07-15");
  });

  it("carries an honest User-Agent, NO Authorization header, and no pre-existing auth cookie", async () => {
    const { requests, fetchImpl } = makeCassette(
      { status: 200, text: STEPS_HTML, setCookie: SESSION_COOKIE },
      { status: 200, text: POPULATED_HTML },
    );
    const adapter = new TeeOnAdapter(fastDeps(fetchImpl));
    await adapter.listSlots(LOGC, DATE, {});

    for (const req of requests) {
      // Honest UA (personal research + contact), not a spoofed browser.
      expect(req.headers["User-Agent"]).toBe(POLITE_USER_AGENT);
      // No credential headers, anywhere.
      const lowerKeys = Object.keys(req.headers).map((k) => k.toLowerCase());
      expect(lowerKeys).not.toContain("authorization");
      expect(lowerKeys).not.toContain("proxy-authorization");
    }

    // The FIRST request (mints the anonymous session) carries NO cookie at all —
    // we never send a pre-existing/auth cookie.
    expect(requests[0]?.headers["Cookie"]).toBeUndefined();
    // The SECOND request replays ONLY the anonymous session cookie the site set
    // in step 1 — the anonymous session the site itself mints (not a login).
    expect(requests[1]?.headers["Cookie"]).toBe("JSESSIONID=abc123anon");
  });

  it("empty real results page -> [] end-to-end (NOT an error; invariant I1)", async () => {
    const { fetchImpl } = makeCassette(
      { status: 200, text: STEPS_HTML, setCookie: SESSION_COOKIE },
      { status: 200, text: REAL_EMPTY_HTML },
    );
    const adapter = new TeeOnAdapter(fastDeps(fetchImpl));
    const slots = await adapter.listSlots(LOGC, DATE, {});
    expect(slots).toEqual([]);
  });

  it("simulated 403 on the results POST -> AdapterError kind 'blocked' (backs off, does NOT retry-around)", async () => {
    const { fetchImpl } = makeCassette(
      { status: 200, text: STEPS_HTML, setCookie: SESSION_COOKIE },
      { status: 403, text: "<html><body>Forbidden</body></html>" },
    );
    const adapter = new TeeOnAdapter(fastDeps(fetchImpl));
    await expect(adapter.listSlots(LOGC, DATE, {})).rejects.toMatchObject({
      name: "AdapterError",
      kind: "blocked",
      backendId: "tee-on",
    });
  });

  it("simulated 403 on the initial GET -> blocked (empty-vs-broken separation)", async () => {
    const { fetchImpl } = makeCassette(
      { status: 403, text: "please verify you are a human — captcha" },
      { status: 200, text: POPULATED_HTML },
    );
    const adapter = new TeeOnAdapter(fastDeps(fetchImpl));
    let thrown: unknown;
    try {
      await adapter.listSlots(LOGC, DATE, {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).kind).toBe("blocked");
  });

  it("5xx -> AdapterError kind 'network'", async () => {
    const { fetchImpl } = makeCassette(
      { status: 200, text: STEPS_HTML, setCookie: SESSION_COOKIE },
      { status: 503, text: "service unavailable" },
    );
    const adapter = new TeeOnAdapter(fastDeps(fetchImpl));
    await expect(adapter.listSlots(LOGC, DATE, {})).rejects.toMatchObject({ kind: "network" });
  });
});
