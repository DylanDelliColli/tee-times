---
kind: decision
session: tee-times-discovery-2026-07-02
title: Direct-from-source tee-time tool (bypass GolfNow)
created: 2026-07-02
---

## Candidates

### Personal tee-time metasearch and slot watcher (Tee-On, book-direct)

- verdict: reshape
- charter: personal-tee-time-metasearch-and-slot-watcher-tee-on-book-direct

GO, reshaped. Original framing was 'an aggregator to avoid GolfNow fees/service.' The Discovery reshape: do NOT build a public aggregator or booking intermediary. Build a SMALL-GROUP metasearch (Kayak, not Expedia) for the user + their regular foursome that queries THEIR set of ~10+ favorite courses and routes each result to the course's own fee-free booking page. Two follow-up answers sharpened this: (1) the primary wedge is confirmed as unified SEARCH/aggregation — 'nothing else works without it' — with the slot-watcher as fast-follow, not core; (2) the real edge is COVERAGE OF THE LONG TAIL, not fee avoidance: many of their favorite courses are not even listed on GolfNow, so this shows courses GolfNow can't. The user's hand-maintained bookmarks folder of 1st-party booking pages is the manual version of this product already in use (behavioral demand); friends not replicating it is the friction the tool removes. Scope grew slightly from n=1 to a fixed small group (~5 known people) — still NOT a public product, no monetization. KEY RISK now front-and-center: aggregation is the critical wedge AND the 10+ courses may span multiple booking backends (Tee-On, ForeUp, Lightspeed/Chronogolf). A Tee-On-only build could fail the core wedge on day one by covering only half the courses. Does not gate the go verdict, but makes 'map every course to its backend' the first Full/RESEARCH task and may force multi-adapter sooner than a pure personal tool would.
