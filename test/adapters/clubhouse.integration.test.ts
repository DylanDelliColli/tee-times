import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { ClubhouseAdapter } from "../../src/adapters/clubhouse.js";
import { POLITE_USER_AGENT, type FetchImpl } from "../../src/adapters/http.js";
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

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface Canned {
  status: number;
  text: string;
}

/**
 * Build a recorded HTTP cassette: a fake fetch that replays the REAL fixture
 * bytes for the one GetAvailableTeeTimes GET. This is REAL composition of the
 * adapter's fetch->parse->normalize pipeline; it just never touches the live
 * network.
 */
function makeCassette(response: Canned) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: { ...init.headers } });
    return {
      status: response.status,
      async text() {
        return response.text;
      },
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "content-type") return "application/json; charset=UTF-8";
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

describe("ClubhouseAdapter integration — recorded cassette (fetch->parse->normalize)", () => {
  it("drives the anonymous GET and returns normalized slots from the REAL fixture", async () => {
    const { requests, fetchImpl } = makeCassette({ status: 200, text: REAL_FIXTURE });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    const slots = await adapter.listSlots(UUGC, DATE, { players: 4, holes: 18 });

    expect(slots).toHaveLength(18);
    expect(slots[0]).toMatchObject({
      courseId: "upper-unionville",
      backendId: "clubhouse",
      date: "2026-07-10",
      time: "07:50",
      holes: 18,
      spotsAvailable: 4,
      price: 120,
    });

    // ONE anonymous GET, path-style endpoint.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "https://upperunionville.clubhouseonline-e3.net/api/v1/teetimes/GetAvailableTeeTimes/20260710/1258/0/4/false",
    );
  });

  it("carries an honest User-Agent, Accept: application/json, NO Authorization header, and no auth cookie (anonymous)", async () => {
    const { requests, fetchImpl } = makeCassette({ status: 200, text: REAL_FIXTURE });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    await adapter.listSlots(UUGC, DATE, {});

    expect(requests).toHaveLength(1);
    const req = requests[0]!;

    // Honest UA (personal research + contact), not a spoofed browser.
    expect(req.headers["User-Agent"]).toBe(POLITE_USER_AGENT);
    expect(req.headers["Accept"]).toBe("application/json");

    // No credential headers, anywhere — anonymous only (THE BRIGHT LINE).
    const lowerKeys = Object.keys(req.headers).map((k) => k.toLowerCase());
    expect(lowerKeys).not.toContain("authorization");
    expect(lowerKeys).not.toContain("proxy-authorization");

    // No cookie sent at all — this endpoint is confirmed stateless/anonymous,
    // we never fabricate or replay a login/auth cookie.
    expect(req.headers["Cookie"]).toBeUndefined();
  });

  it("empty data.teeSheet -> [] end-to-end (NOT an error; invariant I1)", async () => {
    const emptyEnvelope = JSON.stringify({
      retCode: 0,
      title: null,
      infoMsg: null,
      errorMessage: null,
      displayMessage: null,
      serverStackTrace: null,
      data: { availability: [], teeSheet: [] },
      result: true,
    });
    const { fetchImpl } = makeCassette({ status: 200, text: emptyEnvelope });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    const slots = await adapter.listSlots(UUGC, DATE, {});
    expect(slots).toEqual([]);
  });

  it("retCode !== 0 envelope -> AdapterError kind 'parse'", async () => {
    const badEnvelope = JSON.stringify({
      retCode: 7,
      title: null,
      infoMsg: null,
      errorMessage: null,
      displayMessage: "Company context missing",
      serverStackTrace: null,
      data: { availability: [], teeSheet: [] },
      result: false,
    });
    const { fetchImpl } = makeCassette({ status: 200, text: badEnvelope });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    await expect(adapter.listSlots(UUGC, DATE, {})).rejects.toMatchObject({
      name: "AdapterError",
      kind: "parse",
      backendId: "clubhouse",
    });
  });

  it("simulated HTTP 404 with an HTML body -> AdapterError (non-JSON response)", async () => {
    const { fetchImpl } = makeCassette({
      status: 404,
      text: "<html><body><h1>404 Not Found</h1></body></html>",
    });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    let thrown: unknown;
    try {
      await adapter.listSlots(UUGC, DATE, {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).kind).toBe("parse");
    expect((thrown as AdapterError).backendId).toBe("clubhouse");
  });

  it("simulated 403 -> AdapterError kind 'blocked' (backs off, does NOT retry-around; THE BRIGHT LINE)", async () => {
    const { fetchImpl } = makeCassette({
      status: 403,
      text: "please verify you are a human — captcha",
    });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    await expect(adapter.listSlots(UUGC, DATE, {})).rejects.toMatchObject({
      name: "AdapterError",
      kind: "blocked",
      backendId: "clubhouse",
    });
  });

  it("5xx -> AdapterError kind 'network'", async () => {
    const { fetchImpl } = makeCassette({ status: 503, text: "service unavailable" });
    const adapter = new ClubhouseAdapter(fastDeps(fetchImpl));
    await expect(adapter.listSlots(UUGC, DATE, {})).rejects.toMatchObject({ kind: "network" });
  });
});
