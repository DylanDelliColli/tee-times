---
kind: charter
slug: personal-tee-time-metasearch-and-slot-watcher-tee-on-book-direct
title: Personal tee-time metasearch and slot watcher (Tee-On, book-direct)
decision_record: tee-times-discovery-2026-07-02-decisions
epic_intention: tee-times-z4v
created: 2026-07-02
---

## Problem Statement

Booking a tee time today means one of two bad options: pay GolfNow's per-player convenience fee and tolerate their poor service, or manually check each course's own booking site one at a time. Worse, many of the courses my foursome actually plays are not even listed on GolfNow, so the aggregator doesn't solve it even if you pay. There is no fee-free, unified view of availability across the 10+ courses we favor, and no easy way for the whole group to share that view — good times at target courses book up fast, and whoever isn't organized misses out.

## Demand Evidence

Small-group utility build; the users are me + my regular foursome (~5 known people), not the public. Strongest behavioral evidence: I have already built the manual version — a hand-maintained bookmarks folder of 1st-party booking pages that I check across 10+ courses. That folder IS the product, done by hand. Two demand signals on top: (1) my friends do NOT replicate the bookmarks folder (the friction the tool removes — the knowledge doesn't share), and (2) good times book up fast, so the group repeatedly loses spots for lack of a shared, fast way to see and grab them. Broad demand across strangers is deliberately NOT the bar — this is a fixed small group, no public-market claim.

## Status Quo

Two live paths today, both broken for us. (1) GolfNow: aggregates across courses into one search, but charges a per-player convenience fee, pushes hot-deal/barter inventory, has poor service — AND, critically, does not even list several of our favorite courses, so it can't cover our actual set. (2) Direct booking: each course's own backend, fee-free but siloed, one site at a time, no cross-course view, no way to be first on a released/cancelled prime slot short of manual refreshing. My current workaround is a hand-maintained bookmarks folder of 1st-party booking pages across 10+ courses; it works for me but doesn't share to the group, and it's still N separate manual checks. Locally the dominant backend is Tee-On (availability reachable via its WebBookingSearchSteps endpoint with structured time-window params — the pasted PubGolf URL is a working example), but the 10+ course set may span other backends too (ForeUp, Lightspeed/Chronogolf, Club Prophet) — unverified and load-bearing (see Open Questions).

## Target User and Narrowest Wedge

USER: me + my regular foursome (~5 known people), not the public. We play an overlapping set of 10+ favorite courses, several of which GolfNow does not list. We want (a) fee-free booking, (b) ONE shared, easy view so the whole group can find and grab spots without everyone maintaining their own bookmarks folder, and (c) first crack at scarce good times.

NARROWEST WEDGE (RESOLVED — primary): unified availability SEARCH/aggregation across our configured courses, merged into one time-sorted view, each slot linking out to that course's own booking page. Booking completes DIRECT and fee-free. This is metasearch (Kayak), explicitly NOT a booking intermediary (Expedia/GolfNow) — never take payment, never hold inventory. Confirmed as the critical path: 'nothing else works without it.' The differentiator over GolfNow is COVERAGE OF THE LONG TAIL (courses GolfNow doesn't carry), not merely fee avoidance.

FAST-FOLLOW (secondary, confirmed not core): a rule-based background monitor that polls our courses and alerts the group when a slot matching set rules (e.g. Sat 7-10am, 4 players) appears or a cancellation frees one. Real problem ('good times book up fast'), but it depends on aggregation existing first.

## Why Now

- The itch is live and shared: my foursome loses good times right now for lack of a shared, fast view.
- I have already validated the shape by hand (bookmarks folder) — this productizes something I use daily.
- The real edge is durable: GolfNow structurally under-covers the long tail of courses we play, and that gap isn't closing — a coverage-first metasearch wins on exactly what GolfNow can't do.
- The raw material is reachable without partnerships/API keys (e.g. Tee-On's WebBookingSearchSteps returns structured availability).
- A small-group scraper + shared UI is a weekend-to-a-few-weekends with current tooling; build cost dropped below the annoyance cost.
- The ecosystem is moving toward direct bookings (courses dislike GolfNow fees/barter), so routing to the course's own page is aligned with where things head — low risk the fee-free direct path disappears.

## Product Approaches

Product-level shapes (the business/what, not the how — architecture is Full's job):

APPROACH A — On-demand metasearch. Hit 'search', fan out live to my courses' Tee-On endpoints, merge + time-sort, click through to book direct. Simplest: no persistent storage, no background infra. Value = kills the tab-hopping. Ships fastest.

APPROACH B — Background monitor + alerts. A persistent poller diffs availability over time and notifies me (push / text / email) when a slot matching my rules appears or a cancellation frees one. Higher value if scarcity is the real pain; needs scheduling, stored state, and a notification channel.

APPROACH C — Streamlined / auto-book. Automate the Tee-On booking steps end-to-end. Highest value-per-use but highest brittleness and risk (acts on my behalf, breaks whenever the site changes). A later add-on, not the wedge.

RESOLVED LEAN: A is the shippable core (aggregation confirmed as the critical wedge — 'nothing else works without it'), B is the high-value fast-follow (scarcity is a real second problem but depends on A existing). C deferred. NB: A's difficulty scales with backend diversity of the actual course set, not with the UI.

## Recommended Product Shape

A small-group 'tee-time metasearch + watcher' over the foursome's configured courses:
- CORE (ship first): unified, time-sorted availability search across our 10+ courses; every result links to the fee-free direct booking page. Metasearch, never intermediary — no payment, no inventory, no fees. Shared so the whole foursome uses one view (lightweight shared access / shared course list — not public accounts).
- FAST-FOLLOW: rule-based background monitor with group alerts for scarce or cancelled good slots.
- Deliberately NOT a public GolfNow competitor, NOT a booking intermediary, NOT full auto-book at launch.
- BACKEND SCOPE IS CONDITIONAL: 'Tee-On first' holds ONLY if the actual 10+ course set is mostly Tee-On. Because aggregation is the critical wedge and courses not on GolfNow are the edge, coverage of the REAL course set trumps starting-simplicity — if the set spans backends, a backend-adapter seam (Tee-On + ForeUp + Lightspeed/Chronogolf) is required at launch, not deferred. Resolve via the course-to-backend mapping (Open Q #1) before DECOMPOSITION.

## Success Metric

Succeeds if the foursome stops using GolfNow and stops tab-hopping/bookmarks-checking, and starts grabbing better times. Concretely: (1) zero GolfNow convenience fees paid after launch — we book direct; (2) the tool covers a strong majority of our 10+ courses in one search (coverage is the wedge — partial coverage is failure); (3) time-to-find drops from 'open 10+ sites / check the bookmarks folder' to one shared search; (4) my foursome actually adopts it (they didn't adopt the manual bookmarks folder — real adoption by the group is the tell); (5) once monitoring ships, at least one scarce/cancelled good slot caught via alert that we book and would otherwise have missed.

## Non-Goals

- NOT a public product: shared among a fixed small group (~5 known people) is IN scope, but no stranger signups, no multi-tenant SaaS, no monetization.
- NOT a booking intermediary: no payment capture, no held inventory, no fees — always route to the course's own booking page.
- NOT full auto-booking at launch: deferred (brittle, acts on our behalf).
- NOT comprehensive metro coverage: only our configured courses.
- NOTE: 'single backend only' is NOT a firm non-goal — see Recommended Shape. Multi-adapter may be required at launch if our course set demands it.

## Open Questions

1. COURSE-TO-BACKEND MAP (top priority, first Full/RESEARCH task; load-bearing for scope): enumerate the actual 10+ favorite courses and identify each one's booking backend (Tee-On / ForeUp / Lightspeed-Chronogolf / Club Prophet / other). This decides one-adapter vs multi-adapter, and since aggregation is the critical wedge, partial backend coverage = failing the wedge. Do this before DECOMPOSITION.
2. Do the Tee-On courses in the set share one tenant + URL pattern as the PubGolf 'WebBookingSearchSteps' example, or do tenants differ (affects how many adapters even within Tee-On)?
3. Shared-access shape for the foursome: how do 5 people use one tool — a single shared deployment they all open, individual saved searches, shared course list? Lightweight, but needs a call (informs whether any accounts/auth exist at all).
4. Legal/ToS: polite poll rate, respect robots, no account-abusive behavior across whichever backends are scraped. Small-group scope is low-risk but make it a conscious call per backend.
5. Notification channel for the monitor fast-follow (group text / push / email / shared channel)?
6. 'Good time' definition for scarcity/monitoring — what makes a slot desirable for the group (day, time window, player count, course tier)? Feeds both ranking in search and rules in the watcher.
