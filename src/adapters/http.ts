import type { BackendId } from "../core/adapter.js";
import { AdapterError, type AdapterErrorKind } from "../core/errors.js";

/**
 * SHARED ADAPTER SCAFFOLD — the polite, anonymous HTTP layer every backend
 * adapter (tee-on, clubhouse, chronogolf, tei-unify, ...) imports and mirrors.
 * `tee-on` is the reference adapter; keep this surface small and stable.
 *
 * ── THE BRIGHT LINE (non-negotiable — baked into this module) ────────────────
 * Never log in. Never defeat a block. Back off on 403/captcha. No stealth, no
 * anti-bot evasion, no headless-fingerprint tricks. Polite rate only: at most a
 * handful of requests per course per hour, honest User-Agent, serial with
 * jitter. Anonymous only — send NO Authorization header and NO auth cookie you
 * did not receive anonymously in the SAME flow. If a backend returns
 * 403/captcha, we throw AdapterError kind 'blocked'; we do NOT work around it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Honest User-Agent. It identifies this as personal research and gives a real
 * contact address so an operator can reach the author. It does NOT impersonate
 * a browser (no stealth / no fingerprint spoofing — see THE BRIGHT LINE).
 */
export const POLITE_USER_AGENT =
  "tee-times-personal-metasearch/0.1 (personal golf tee-time research; " +
  "contact: dylan.dellicolli@gmail.com)";

/** Header names that would carry credentials. We never send these anonymously. */
const FORBIDDEN_REQUEST_HEADERS = ["authorization", "proxy-authorization"];

/** Minimal, transport-agnostic response shape the adapters parse. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  /** Fully-read response body as text (adapters parse HTML/JSON from this). */
  text: string;
  /** Lower-cased header name -> value. `set-cookie` is joined newline-delimited. */
  headers: Record<string, string>;
}

/**
 * The underlying fetch primitive. Defaults to `globalThis.fetch`, but tests
 * inject a recorded cassette here so the fetch->parse pipeline runs end-to-end
 * without touching the live network.
 */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null; forEach?: (cb: (v: string, k: string) => void) => void };
}>;

/** Per-request context used only to build a well-typed {@link AdapterError}. */
export interface RequestContext {
  backendId: BackendId;
  courseId: string;
}

export interface PoliteFetchOptions {
  method?: "GET" | "POST";
  /** Extra request headers. Credential headers are rejected (see BRIGHT LINE). */
  headers?: Record<string, string>;
  /** Request body (POST). */
  body?: string;
  /** Cookie jar for the anonymous session; only replays cookies set THIS flow. */
  jar?: CookieJar;
  /** Injected fetch primitive (tests pass a cassette). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Max milliseconds of pre-request jitter (politeness). Tests pass 0. */
  jitterMs?: number;
  /** Sleep function (tests pass a no-op). Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter (tests can make deterministic). Defaults to Math.random. */
  random?: () => number;
}

/**
 * A tiny cookie jar scoped to ONE anonymous flow. It stores only cookies the
 * server itself set during this flow and replays them on later requests in the
 * same flow. It NEVER accepts an externally-supplied credential cookie — this
 * is exactly the "anonymous session the site mints" allowed by THE BRIGHT LINE,
 * and nothing else.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Absorb Set-Cookie header(s) from a response (newline-delimited if multiple). */
  storeFromHeader(setCookie: string | undefined): void {
    if (!setCookie) return;
    for (const line of setCookie.split("\n")) {
      const pair = line.split(";", 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  /** The `Cookie` request-header value, or undefined if the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size(): number {
    return this.cookies.size;
  }
}

/** Construct a well-typed {@link AdapterError} for a backend/course. */
export function makeAdapterError(
  ctx: RequestContext,
  kind: AdapterErrorKind,
  message: string,
  cause?: unknown,
): AdapterError {
  // 'network' and 'blocked' are transient; 'parse'/'auth' are not.
  const retryable = kind === "network" || kind === "blocked";
  return new AdapterError({
    backendId: ctx.backendId,
    courseId: ctx.courseId,
    kind,
    retryable,
    message: `[${ctx.backendId}] ${kind}: ${message}`,
    cause,
  });
}

/** True when a body looks like an interstitial anti-bot / captcha challenge. */
function looksLikeChallenge(status: number, body: string): boolean {
  if (status === 429) return false; // rate-limited, not a block — surfaced as network
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes("captcha") ||
    head.includes("cf-challenge") ||
    head.includes("attention required! | cloudflare") ||
    head.includes("/cdn-cgi/challenge-platform") ||
    head.includes("please verify you are a human")
  );
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Perform ONE polite, anonymous HTTP request.
 *
 * Guarantees (all enforced here so every adapter inherits them):
 *  - Sends the honest {@link POLITE_USER_AGENT}; never a spoofed browser UA.
 *  - Refuses to send Authorization/credential headers (throws 'auth' if asked).
 *  - Only replays cookies the server set during THIS flow (via {@link CookieJar}).
 *  - Serial with optional pre-request jitter for politeness.
 *
 * Failure mapping (empty-vs-broken discipline lives above this in the adapter):
 *  - 403 / captcha / challenge       -> AdapterError 'blocked' (we back off)
 *  - 5xx / transport / DNS / timeout -> AdapterError 'network'
 *  - other statuses (2xx/3xx/4xx)    -> returned as {@link HttpResponse}
 */
export async function politeFetch(
  url: string,
  ctx: RequestContext,
  opts: PoliteFetchOptions = {},
): Promise<HttpResponse> {
  const {
    method = "GET",
    headers = {},
    body,
    jar,
    fetchImpl = globalThis.fetch as unknown as FetchImpl,
    jitterMs = 250,
    sleep = defaultSleep,
    random = Math.random,
  } = opts;

  // BRIGHT LINE: never send credential headers anonymously.
  for (const name of Object.keys(headers)) {
    if (FORBIDDEN_REQUEST_HEADERS.includes(name.toLowerCase())) {
      throw makeAdapterError(
        ctx,
        "auth",
        `refusing to send credential header '${name}' — this adapter is anonymous-only`,
      );
    }
  }

  const requestHeaders: Record<string, string> = {
    "User-Agent": POLITE_USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
    ...headers,
  };
  const cookieHeader = jar?.header();
  if (cookieHeader) requestHeaders["Cookie"] = cookieHeader;

  // Politeness: serial-with-jitter. Callers run requests serially; add a small
  // randomized delay so we never burst.
  await sleep(Math.floor(random() * Math.max(0, jitterMs)));

  let res: Awaited<ReturnType<FetchImpl>>;
  try {
    res = await fetchImpl(url, { method, headers: requestHeaders, ...(body !== undefined ? { body } : {}) });
  } catch (cause) {
    // Transport-level failure: DNS, timeout, connection reset, etc.
    throw makeAdapterError(ctx, "network", `transport failure for ${url}`, cause);
  }

  const text = await res.text();

  if (res.status === 403 || looksLikeChallenge(res.status, text)) {
    throw makeAdapterError(ctx, "blocked", `backend returned ${res.status} / challenge for ${url}`);
  }
  if (res.status >= 500 || res.status === 429) {
    throw makeAdapterError(ctx, "network", `backend returned ${res.status} for ${url}`);
  }

  // Absorb any anonymous session cookie the server just minted.
  jar?.storeFromHeader(res.headers.get("set-cookie") ?? undefined);

  const headerBag: Record<string, string> = {};
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) headerBag["set-cookie"] = setCookie;
  const contentType = res.headers.get("content-type");
  if (contentType) headerBag["content-type"] = contentType;

  return { status: res.status, ok: res.status >= 200 && res.status < 300, text, headers: headerBag };
}
