import { search } from "../../../../src/search/search.js";
import type { AvailabilityStore } from "../../../../src/store/store.js";
import type { SearchResult } from "../../../../src/search/search.js";
import { openStore, parseSearchQuery } from "../../../lib/api-search.js";

/**
 * better-sqlite3 is a native module and CANNOT run on the edge runtime — this
 * route MUST run under the Node.js runtime.
 */
export const runtime = "nodejs";

const EMPTY_RESULT: SearchResult = { slots: [], courses: [] };

/**
 * Read-only search endpoint: parses the query, opens the store fresh for
 * this request, calls search() (never live-fetches — see src/search/search.ts's
 * THE BRIGHT LINE note), and returns SearchResult JSON. A store-open failure
 * (e.g. an unwritable/missing path in some deploy environments) or any other
 * unexpected error degrades to an empty-but-valid SearchResult rather than a
 * 500 — "no data" must never look like a server error to the shared page.
 *
 * NOTE: helper functions (resolveDbPath/openStore/parseSearchQuery) live in
 * ../../../lib/api-search.js rather than being exported from this file —
 * Next's App Router route-handler type validator only allows a fixed set of
 * named exports (GET/POST/.../runtime/dynamic/...) from a route.ts file.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = parseSearchQuery(url.searchParams);

  let store: AvailabilityStore | undefined;
  try {
    store = openStore();
    const result = search(query, store);
    return Response.json(result satisfies SearchResult);
  } catch (err) {
    console.error("[api/search] search failed, degrading to empty result", err);
    return Response.json(EMPTY_RESULT);
  } finally {
    store?.close();
  }
}
