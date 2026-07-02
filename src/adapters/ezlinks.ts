import type { BackendId } from "../core/adapter.js";

/**
 * EZLinks formalization (tee-times-3rj; SHAPE LOCKED by tee-times-tt6's
 * decision spike).
 *
 * THE BRIGHT LINE: EZLinks is Cloudflare-defended (an anonymous GET to a
 * booking page 403s — see the inline verification notes on the "lakeview"
 * and "braeben" entries in src/core/courses.ts) and is DEEP-LINK-ONLY. This
 * module intentionally contains NO fetch/parse code, NO AvailabilityAdapter
 * implementation, and NO attempt to defeat Cloudflare. It exists purely to
 * name the "ezlinks is deep-link-only" fact ONCE so the rest of the system
 * (search.ts today; the poller/AdapterMap wiring if it's ever touched) can
 * ask a shared predicate instead of re-hardcoding the 'ezlinks' string
 * literal in multiple places.
 *
 * DESIGN CHOICE — predicate (a), not a stub adapter (b):
 * A stub `EzlinksDeepLinkAdapter` whose listSlots() always throws
 * AdapterError('blocked') was considered and rejected. Such a stub would
 * either (1) never be wired into any AdapterMap — in which case it is dead
 * code whose only job is to exist, adding a maintenance burden with no
 * runtime effect — or (2) get wired in "just in case", at which point it
 * looks, at a glance, like a real (if degraded) adapter and invites exactly
 * the "maybe we should retry/backoff/investigate it" instinct THE BRIGHT
 * LINE forbids for this backend. A pure predicate has no such attractive
 * nuisance: it can only be asked a yes/no question, and search.ts already
 * proves (test/search/search.integration.test.ts's structural assertion)
 * that it never imports adapter code, so a stub adapter would be unusable
 * from search.ts anyway without violating that invariant.
 */

/**
 * Backends that are NEVER live-polled and must ALWAYS be surfaced as
 * deep-link-only, regardless of what the store holds for them. Currently
 * just EZLinks; kept as an array (not a single constant) so a future
 * Cloudflare-defended backend can be added here without touching call sites.
 */
export const DEEP_LINK_ONLY_BACKENDS: readonly BackendId[] = ["ezlinks"];

/**
 * True if `backendId` must always be surfaced as deep-link-only. Callers
 * (e.g. search.ts) should treat this as "never look in the store for this
 * backend, never expect an adapter to be registered for it" — see
 * search.ts::search() and poller.ts's 'no-adapter' disposition, which is
 * simply what happens today because no AdapterMap ever registers 'ezlinks'.
 */
export function isDeepLinkOnlyBackend(backendId: BackendId): boolean {
  return DEEP_LINK_ONLY_BACKENDS.includes(backendId);
}
