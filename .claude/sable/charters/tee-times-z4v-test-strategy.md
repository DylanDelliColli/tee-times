# TEST STRATEGY — Personal tee-time metasearch + slot watcher (epic tee-times-z4v)

**Substage:** TEST-STRATEGY (columbo), SABLE Full planning. Runs BEFORE DECOMPOSITION.
**Date:** 2026-07-02 · **Mode:** forward test-architecture spec (greenfield, no source yet).
**Status:** LOCKED. This is the test contract DECOMPOSITION lifts onto each implementation bead.
**Grounding:** DESIGN field of tee-times-z4v (AvailabilityAdapter seam + Slot model + I1-I3, AvailabilityStore spine, tradeoffs #2/#4/#5/#7/#9/#10, 3-module split, A3 degradation); research tee-times-8uc/1ox/v6c/f5f/853/xah.

> **This is a CONTRACT, not a backlog.** No child beads, no skeleton test files were authored (interlock holds the backlog until DECOMPOSITION, correctly). Every module below carries an explicit **unit + integration** matrix and a **boundary/failure** list so DECOMPOSITION can pair each block with its implementation bead and pass the Fresh Agent Test.

---

## 0. Standing rules that bind EVERY module (cross-cutting)

These are not one module's concern — every implementation bead inherits them.

1. **Unit AND integration, both, always.** User's Prime Directive #2. Unit tests with mocked deps ship broken systems. Every module has BOTH layers below. Integration exercises REAL composition:
   - **Real store** (sqlite file or on-disk fs) for anything that reads/writes availability state — NEVER a mocked/in-memory-double store in an integration test. Mocking the DB in an integration test defeats its purpose.
   - **Real HTTP** against **recorded/fixture responses** (a local fixture server or a recorded cassette replaying captured bytes) for adapters — NEVER `fetch` mocked at the function boundary in the integration layer. Unit layer may stub the transport; integration must not.
2. **The empty-vs-broken distinction (invariant I1) is the single highest-value assertion in the whole system.** A broken/blocked fetch THROWS a typed `AdapterError` (`{backendId, courseId, kind:'blocked'|'parse'|'network'|'auth', retryable}`). It MUST NEVER return `[]`. `[]` means "genuinely zero times." Conflating them silently destroys the health signal (Risk R3) and makes the watcher fire false "all slots cancelled" alerts. **Every adapter test suite tests both paths as SEPARATE, named cases.** Every downstream module (store, poller, search, watcher) has at least one case asserting it preserves the distinction rather than swallowing the throw into an empty list.
3. **Timezone/DST → course-local time (invariant I2).** The adapter owns tz conversion; everything downstream sees course-local `HH:MM`. Tested with a fixture whose raw payload is in a non-local tz and at least one fixture straddling a DST boundary. No downstream module re-derives time.
4. **Cloudflare/anti-bot block handling.** A 403/525/captcha challenge is a `kind:'blocked'` `AdapterError`, retryable=false → hard-stop that course for the day (xah). Tested at the adapter layer (classification) and the poller layer (hard-stop honored, no retry-through).
5. **Stale-cache serving is a first-class, correct behavior, not an error.** Search and watcher serve from cache; when `fetchedAt` is older than TTL the result is returned WITH `stale:true`, never withheld. Every store/search test asserts stale data is served + flagged, not dropped.
6. **Coverage-percentage is a first-class SUCCESS ASSERTION.** The charter says partial coverage = failure; success = a strong majority of the 8 courses across 4 backends. There is a top-level **acceptance/smoke test** asserting the aggregate covers the expected majority (≥75% = 6/8 scraped, 100% surfaced including deep-link-only). This test is the executable form of the charter's success bar. See Module 7.

**8-course / 4-backend coverage map (the success denominator):**
| Backend | Courses | Share | Tier (fetch effort) |
|---|---|---|---|
| Tee-On | CENT, LOGC, MTNE, CROS | 50% (4/8) | EASIEST — anonymous HTML parse |
| EZLinks (GolfNow/NBC) | lakeviewgc, braeben | 25% (2/8) | HARDEST — Cloudflare, likely deep-link-only degraded |
| Chronogolf/Lightspeed | Banty's Roost | 12.5% (1/8) | MIDDLE — clean JSON post-capture |
| LinkLine (TEI Unify) | GA (ClubLink) | 12.5% (1/8) | MODERATE — JSON post-capture, read-auth unconfirmed |

---

## MODULE 1 — Adapters (4: Tee-On, EZLinks, Chronogolf, LinkLine)

**Highest-risk surface.** Feature shape: external-API integration + pure data transformer (parser). Categories exercised: 1 (behavioral surface), 2 (boundary), 3 (negative space), 5 (failure modes), 7 (integration boundaries). Each of the 4 adapters gets its OWN unit suite + its OWN integration suite driven by that backend's captured fixture.

### 1U — UNIT layer: golden-fixture parser tests (per backend)

Input: a saved REAL response (Tee-On = captured HTML; EZLinks/Chronogolf/LinkLine = captured JSON, gated on the tee-times-azn devtools capture). Output asserted: exact `Slot[]`.

| # | Case | Assert | Why (bug it catches) |
|---|---|---|---|
| 1U-a | Parse golden fixture → expected `Slot[]` | Every field: `courseId`, `backendId`, `date`, `time`, `holes` (9\|18), `spotsAvailable`, `price?`, `bookingUrl` extracted correctly vs a hand-verified expected array | Parser drift / wrong JSON path or HTML selector silently mis-reads availability |
| 1U-b | **Timezone/DST → course-local (I2)** | Fixture whose raw time is UTC/other-tz normalizes to correct course-local `HH:MM`; a second fixture on a DST-transition date lands on the right wall-clock time | Off-by-one-hour tee times; DST double-hour / skipped-hour bug |
| 1U-c | **`bookingUrl` deep-links to the course's OWN booking page (I3)** | URL points at the course/backend's own booking page pre-filled for that course+date, never an intermediary/GolfNow URL, never our own domain | Metasearch invariant violation — sending users to the wrong booking surface |
| 1U-d | Price present vs absent | `price` populated when the backend exposes it (Chronogolf green-fee array, EZLinks FeeString); omitted (not null-coerced to 0) when absent | Free-round misprice; `$0` shown as real price |
| 1U-e | holes / spots boundary extraction | 9-hole vs 18-hole rows both parse; `spotsAvailable` 1..4 extracted; a fully-booked row is EXCLUDED (0 spots ≠ a slot) | Showing a 0-spot slot as bookable |
| 1U-f | **Empty result → `[]` (I1 path A)** | A well-formed response listing genuinely zero open times returns `[]`, does NOT throw | Real "no times" misclassified as an outage → false health alarm |
| 1U-g | **Broken/blocked → THROWS typed `AdapterError` (I1 path B)** | Garbled/truncated/schema-changed payload throws `kind:'parse'`; empty-shell SPA (LinkLine) or challenge page throws — NEVER returns `[]` | THE core R3 bug: broken fetch masquerading as "no times," poisoning the watcher diff |
| 1U-h | Error-kind classification | 403/525/Cloudflare challenge → `kind:'blocked'`, retryable=false; network timeout → `kind:'network'`, retryable=true; auth/token failure (LinkLine read-auth) → `kind:'auth'`; malformed body → `kind:'parse'` | Wrong retry decision → either hammering a blocking host or giving up on a transient blip |
| 1U-i | courseRef addressing | Adapter builds the right request from backend-specific `courseRef` (Tee-On `{courseCode,courseGroupId}`; EZLinks `{subdomain,facilityId}`; Chronogolf `{clubId,courseId,affiliationTypeId}`; LinkLine `{host,courseId}`) — one adapter serves all its courses by varying config only | Shotgun-surgery / wrong-tenant fetch; hardcoded single course |

**Per-backend fixture notes (for the capture spike + parser author):**
- **Tee-On** — HTML from `WebBookingSearchSteps` with a Public-Golfer LockerString. Golden HTML fixture; assert the slot-row selector + pipe-delimited UnlockTime handling. Reference adapter (do first). Confirm GET-vs-POST + exact row markup in the capture.
- **Chronogolf** — captured JSON from the consumer marketplace XHR (path unconfirmed — code against the CAPTURED path, never the guessed `/marketplace/v2/teetimes`). Richest data (green-fee array w/ price + player type). Fixture = real JSON body.
- **LinkLine** — captured JSON from the Unify SPA XHR. **read-auth is UNCONFIRMED** — fixture must capture whether an anonymous bearer/session token is required; the parse test is blocked until the schema is real. Assert CourseID-array tenant model.
- **EZLinks** — HARDEST. Fixture = captured gnsvc.com JSON (or, if capture fails behind Cloudflare, this adapter degrades to deep-link-only — see Module 6, and it has NO parser suite, only a degradation test).

### 1I — INTEGRATION layer: adapter against recorded HTTP (per backend)

Real HTTP client → local fixture server / recorded cassette replaying the captured bytes → real parse → real normalize. Asserts the whole fetch→parse→normalize path, not just the parser in isolation.

| # | Case | Assert | Real composition |
|---|---|---|---|
| 1I-a | End-to-end fetch→parse→normalize (happy) | Adapter issues the correct request (URL, params, honest UA header) and returns the expected `Slot[]` | Real HTTP stack + real parser against recorded response |
| 1I-b | **Cloudflare 403/525 → `AdapterError kind:'blocked'`** | Fixture server returns a 403 (EZLinks) / 525 (LinkLine) → adapter throws blocked/non-retryable, does NOT return `[]` | Real HTTP error handling path |
| 1I-c | 429 → retryable network/blocked error | Fixture returns 429 → typed error with retryable semantics per xah backoff | Real status-code handling |
| 1I-d | Honest-UA + no auth sent | Assert the outgoing request carries the honest identifying UA (`FoursomeTeeTimes/1.0 (personal; contact ...)`) and NO login/credential/cookie (legal bright line, xah) | Real request construction |
| 1I-e | Tee-On anonymous locker flow | Adapter auto-issues/handles the Public-Golfer LockerString without a member id | Real request/response round-trip |

> Tee-On integration is straightforward (anonymous HTML). The 3 SPA/JSON backends' integration fixtures are captured JSON responses and are **BLOCKED on the tee-times-azn devtools capture** (endpoint + auth + schema). DECOMPOSITION must sequence each capture spike BEFORE its adapter's integration bead.

**Module 1 boundary/failure non-negotiables:** empty-vs-broken (1U-f/g) as separate cases; DST fixture; deep-link correctness; blocked-classification on real HTTP status.

---

## MODULE 2 — AvailabilityStore (poll-cache spine)

Feature shape: stateful cache / snapshot store. Categories: 1, 2 (TTL boundary), 4 (cache states: FRESH/STALE/MISS), 9 (retention invariant). The spine both paths read from; the poller is the only writer.

### 2U — UNIT layer

| # | Case | Assert | Why |
|---|---|---|---|
| 2U-a | PUT then GET (FRESH) | `getSlots` within TTL returns `{slots, fetchedAt, stale:false}` | Basic round-trip |
| 2U-b | **TTL expiry → STALE, still served** | After TTL elapses, GET returns the slots WITH `stale:true` — data is NOT withheld | Stale-serving is correct behavior (rule 5); dropping it would blank the UI |
| 2U-c | **`stale` boundary (just-under vs just-over TTL)** | `fetchedAt` at `TTL - ε` → `stale:false`; at `TTL + ε` → `stale:true`. Off-by-one on the boundary tested explicitly | Boundary flip bug on the freshness flag |
| 2U-d | MISS (never polled) | GET for an un-polled (course,date) returns `MISS` sentinel, distinct from `{slots:[], stale}` | MISS (no data) vs empty (real zero times) conflation |
| 2U-e | **Snapshot retention for diffing** | `putSnapshot` retains the PRIOR snapshot; the watcher can read (current, previous) for a (course,date) | Watcher can't diff if prior is overwritten — silent no-alerts |
| 2U-f | Overwrite / newest-wins | A newer `putSnapshot` becomes current; the one it displaced becomes prior; older-than-prior is dropped | Snapshot history unbounded growth OR losing the needed prior |
| 2U-g | Per-(course,date) isolation | Writing course A date D1 doesn't perturb course B or date D2 | Key collision across courses/dates |
| 2U-h | `listCoursesToPoll` drives the poller | Returns the configured (course,date) work list | Poller fans out over the wrong set |

### 2I — INTEGRATION layer (REAL store — sqlite or fs, NOT mocked)

| # | Case | Assert | Real composition |
|---|---|---|---|
| 2I-a | put→read-back across a real store | Snapshot persisted to sqlite/fs and read back identically (serialization round-trip of `Slot`, incl. optional `price`) | Real sqlite/fs, real (de)serialization |
| 2I-b | Expiry against real clock/store | Written snapshot reads back `stale:true` after TTL using the real store's timestamp | Real persistence + time handling |
| 2I-c | **Retain-prior across a real reopen** | After put(current) over put(prior), a fresh store handle still exposes BOTH current and prior for the diff | Persistence of the retention invariant, not just in-memory |
| 2I-d | Concurrent read during write | A search read during a poller write returns a consistent snapshot (no torn/partial `Slot[]`) | Real store transaction/consistency (touches Category 6) |

**Module 2 boundary/failure non-negotiables:** stale boundary (2U-c); MISS-vs-empty (2U-d); retain-prior persisted (2I-c); NEVER mock the store in 2I.

---

## MODULE 3 — Poller + rate policy

Feature shape: long-running/batch job + rate limiter + adversarial-polite behavior. Categories: 1, 5 (failure/isolation), 6 (concurrency/ordering), 11 (rate/perf-budget). Encodes the xah polite-rate policy as executable rules.

### 3U — UNIT layer

| # | Case | Assert | Why |
|---|---|---|---|
| 3U-a | **≤4 req/course/hr enforced** | Limiter blocks a 5th request to the same course within the hour window | Exceeding budget → IP ban that masquerades as an outage (R3) |
| 3U-b | Serial + jitter, no burst | Requests issued one course at a time with 2-5s jitter; never all-courses-at-once | Bursting all 8 → Cloudflare flags us |
| 3U-c | **429 → exponential backoff** | On 429, backoff from 5min toward a 1-2hr cap; window respected | Retry-storm after a soft throttle |
| 3U-d | **403/captcha → HARD-STOP for the day, no retry-through** | On `kind:'blocked'`, that course is disabled for the day; poller does NOT retry, rotate IP, or solve challenge (xah bright line) | Legal + technical: fighting a block is the one thing we must never do |
| 3U-e | Per-course kill switch honored | A disabled-course flag skips that course entirely | Can't stop polling a course on request |
| 3U-f | **One adapter throwing does NOT sink the cycle** | If course A's adapter throws `AdapterError`, courses B-H still poll and write; A's error is recorded (health signal), not propagated to abort the run | One flaky backend blacks out the whole app |
| 3U-g | Off-peak throttle | Minimal/no polling outside ~6am-8pm course-local | Wasteful/impolite overnight hammering |
| 3U-h | Empty vs broken preserved into store | A `[]` from an adapter writes an empty snapshot (real zero times); a throw records an error/blocked marker — the poller does NOT write `[]` on a throw | Broken fetch overwriting good cache with fake "no times" → false cancel alerts |

### 3I — INTEGRATION layer

Poller fans out across multiple STUB adapters (some return `Slot[]`, some throw, some 429) → writes a REAL store → limiter enforced across the real cycle.

| # | Case | Assert | Real composition |
|---|---|---|---|
| 3I-a | Fan-out → real store write | Poll cycle across N stub adapters populates the real store for all healthy courses | Real store + real scheduler loop |
| 3I-b | Limiter respected across the real cycle | Across a simulated hour, no course exceeds 4 reqs; jitter/serialization observed | Real timing/limiter integration |
| 3I-c | Mixed health cycle | Stubs: 2 OK, 1 throws blocked, 1 returns `[]`, 1 429s → store ends with fresh data for the OK courses, a blocked marker for the blocked one, an empty snapshot for the zero-times one, backoff scheduled for the 429 | Real end-to-end degradation wiring |
| 3I-d | Blocked course stays stopped | After a `blocked` in cycle N, cycle N+1 skips that course (hard-stop persisted) | Real state carry across cycles |

**Module 3 boundary/failure non-negotiables:** rate cap (3U-a); hard-stop-no-retry (3U-d); one-adapter-throw-doesn't-sink-cycle (3U-f / 3I-c); empty-vs-broken write semantics (3U-h).

---

## MODULE 4 — Search / Merge / Rank

Feature shape: pure function / data transformer over the store + merge. Categories: 1, 2 (boundary), 3 (negative space), 9 (invariants). Stateless over the store; served FROM cache (tradeoff #4).

### 4U — UNIT layer

| # | Case | Assert | Why |
|---|---|---|---|
| 4U-a | Merge across courses → one time-sorted list | Slots from multiple courses interleave into a single ascending time-sorted view | Core wedge = one unified list |
| 4U-b | Filter: day / time-window | Only slots inside the requested window survive; boundary times (exactly at window start/end) handled per a locked inclusive/exclusive rule | Off-by-one at window edges drops/keeps wrong slots |
| 4U-c | Filter: players | Slots with `spotsAvailable >= requestedPlayers` survive; fewer-spots excluded | Showing a 2-spot slot to a foursome |
| 4U-d | Filter: holes (9 vs 18) | Holes filter exact-matches | Wrong-length round shown |
| 4U-e | Rank: "good times" | Ranking orders/marks preferred times per the locked heuristic (deterministic, tie-break stable) | Non-deterministic ordering; unstable UI |
| 4U-f | **Boundary: overlapping identical times across courses** | Two courses with the same date+time both appear (distinct `courseId`); merge does NOT dedupe across courses | Losing a real slot because another course shares its time |
| 4U-g | **Boundary: empty results** | No matching slots → returns empty result cleanly (not an error, not a crash) | Blank-search crash |
| 4U-h | **Boundary: ALL courses degraded/stale** | Every course stale or deep-link-only → search still returns rows (stale-flagged / link-only), never an empty or errored page | Total-degradation blackout |
| 4U-i | **One course's data missing/error mid-merge does NOT sink the search** | A course with a MISS or recorded error is skipped (or shown degraded); the rest of the merged list still returns | One bad course = no results at all |
| 4U-j | Stale slots surfaced + flagged | Stale-cache slots included with a `stale` marker, sorted in normally | Withholding stale data blanks the list |

### 4I — INTEGRATION layer (served FROM the real store)

| # | Case | Assert | Real composition |
|---|---|---|---|
| 4I-a | **Search reads cache, NEVER live-fetches** | With the store pre-populated and all adapters wired to FAIL if called, a search returns results and triggers ZERO adapter/upstream calls (tradeoff #4 + polite-rate) | Real store read path; adapter call-count asserted 0 |
| 4I-b | Merge over a real multi-course store | Store seeded (real sqlite/fs) with several courses/dates → search returns the correct merged+filtered+ranked view | Real store composition |
| 4I-c | Degraded course surfaced from store | A course stored as deep-link-only/stale appears in the real search result flagged, not dropped | Real A3 wiring end-to-end |

**Module 4 boundary/failure non-negotiables:** overlapping-identical-times (4U-f); all-degraded (4U-h); one-course-error-doesn't-sink-merge (4U-i); **cache-only, never live-fetch (4I-a) — this is the load-bearing tradeoff-#4 assertion.**

---

## MODULE 5 — Watcher / Alert (fast-follow)

Feature shape: snapshot diff / state-transition detector + idempotency. Categories: 1, 4 (appear/cancel transitions), 6 (ordering/cadence), 9 (idempotency invariant). Reads consecutive snapshots from the store; does NOT re-poll. Group-wide rules, **NO per-user model** (A2 locked: one shared app, no accounts).

### 5U — UNIT layer

| # | Case | Assert | Why |
|---|---|---|---|
| 5U-a | Diff → newly-appeared slots | (prev, curr): a slot in curr but not prev is emitted as "appeared" | Miss a freed cancellation slot = the whole fast-follow fails |
| 5U-b | Diff → cancelled/disappeared slots | A slot in prev but not curr flagged "gone" (if the rules cover disappearance) | Alerting on a slot already taken |
| 5U-c | **Group-wide rule matching (A2, no per-user)** | An appeared slot matching a shared rule (day/window/players/holes) triggers; non-matching does not. NO per-user rule storage | Building a user model the architecture forbids |
| 5U-d | **Idempotency: no duplicate alert across cycles** | A slot that persists appeared across cycles N, N+1, N+2 alerts ONCE, not every cycle | Alert spam — the fastest way the foursome mutes the app |
| 5U-e | **Boundary: appear-then-disappear within one interval** | If a slot appears and is gone by the next ~15min snapshot, behavior is defined (either no alert, or a single alert then a gone-notice) — no crash, no dangling "available" state | Ghost slot the user clicks and finds taken |
| 5U-f | **Empty-vs-broken guard (I1) at the diff** | If curr came from a broken fetch (error marker), the watcher does NOT treat "curr has 0 slots" as "everything cancelled" and fire mass alerts | THE watcher-poisoning bug — a Cloudflare block reading as "all slots cancelled" |
| 5U-g | ~15min cadence bound | Watcher operates on the poll cadence (~10-15min); freshness is interval-bounded, not instant (tradeoff #7) | Promising instant sniping the poll model can't deliver |
| 5U-h | No prior snapshot (cold start) | First-ever snapshot for a (course,date) → establishes baseline, does NOT alert every slot as "new" | Cold-start alert storm |

### 5I — INTEGRATION layer (two REAL store snapshots → diff → alert)

| # | Case | Assert | Real composition |
|---|---|---|---|
| 5I-a | Two real snapshots → diff → alert emission | Seed real store with prev then curr; watcher reads both, diffs, emits the expected alert(s) to a STUB notification sink | Real store retain-prior + real diff; only the sink is stubbed |
| 5I-b | Idempotency across a real multi-cycle run | Three consecutive real snapshots with a persistent slot → sink receives exactly one alert | Real cross-cycle dedupe state |
| 5I-c | Broken-curr snapshot → no mass-cancel alerts | Store curr = error/blocked marker → watcher emits no "cancelled" storm | Real I1 preservation through the store |

**Module 5 boundary/failure non-negotiables:** idempotency (5U-d / 5I-b); appear-then-disappear (5U-e); empty-vs-broken at diff (5U-f / 5I-c); cold-start no-storm (5U-h); stub ONLY the notification sink, use a REAL store.

---

## MODULE 6 — Degradation (invariant A3) — tested at the search layer

Not a standalone module — a cross-cutting contract asserted where it's user-visible: the Search layer. A backend that throws (EZLinks the likely case) is surfaced as **deep-link-only + flagged stale**, NEVER dropped from results.

| # | Layer | Case | Assert | Why |
|---|---|---|---|---|
| 6-a | UNIT (search) | Errored course → deep-link-only row | A course whose latest state is a `blocked`/error marker appears in results as a link-out row (course name + "check times →" `bookingUrl`) flagged degraded, with no fabricated slots | Coverage never silently drops (charter: partial coverage = failure) |
| 6-b | UNIT (search) | Stale course → served + flagged | Past-TTL course appears with stale marker, real (aged) slots shown | Stale ≠ absent |
| 6-c | INTEGRATION | A3 end-to-end from real store | Real store holds one healthy course, one stale, one deep-link-only → search returns all three correctly differentiated | Real degradation wiring |
| 6-d | UNIT (search) | Deep-link URL correctness under degradation | The degraded row's link is the course's OWN booking page (I3), even with no live slots | Sending users nowhere / to an intermediary |

**Module 6 non-negotiable:** a broken backend is visibly degraded, never invisible. This is the executable form of "partial coverage = failure."

---

## MODULE 7 — Coverage-percentage acceptance (charter success bar)

The charter's success criterion made executable. Not tied to one code module — a top-level acceptance/smoke test.

| # | Layer | Case | Assert |
|---|---|---|---|
| 7-a | ACCEPTANCE (smoke) | Aggregate coverage ≥ strong majority | Across the 8 configured courses, the aggregate surfaces a strong majority scraped-live (target ≥75% = 6/8; Tee-On 50% + Chronogolf + LinkLine) AND 100% surfaced (remaining courses present as deep-link-only). A run where >2 courses are silently absent FAILS. |
| 7-b | ACCEPTANCE (smoke) | Every configured course is accounted for | Each of the 8 courses resolves to exactly one of: {live slots, empty (real zero), stale, deep-link-only}. NONE is missing/undefined. |
| 7-c | ACCEPTANCE | Backend health rollup | The empty-vs-broken signal (I1) rolls up to a per-backend health status usable as the "an adapter broke" alarm (R3 mitigation). |

**Module 7 non-negotiable:** coverage % is asserted, not assumed. This test is the gate on the charter's "partial coverage = failure."

---

## Cross-cutting boundary/failure themes to stamp on EVERY implementation bead

DECOMPOSITION: copy this list into each impl bead's test spec so no worker ships happy-path-only.

1. **Empty (`[]`) vs broken (throws `AdapterError`)** — separate, named cases at every layer that touches availability (adapter, poller-write, store, search, watcher-diff). The #1 systemic bug.
2. **Timezone / DST** — course-local normalization owned by the adapter; at least one DST-boundary fixture; no downstream re-derivation.
3. **Cloudflare/anti-bot block handling** — 403/525/captcha → `kind:'blocked'`, retryable=false → hard-stop-for-the-day, no retry-through / no IP rotation / no challenge-solving (xah legal bright line).
4. **Stale-cache serving** — stale data is served WITH a flag, never withheld; MISS (never polled) is distinct from empty (real zero times).
5. **Coverage-percentage as a success assertion** — Module 7 acceptance test; a run missing a strong majority FAILS.
6. **One-bad-backend isolation** — a single adapter throwing must never sink the poll cycle (Module 3) or the merged search (Module 4) or storm the watcher (Module 5).

---

## Unit + Integration coverage matrix (summary — for DECOMPOSITION lift)

| Module | UNIT focus | INTEGRATION focus (REAL composition) | Empty-vs-broken? | Stale/degrade? |
|---|---|---|---|---|
| 1. Adapters ×4 | golden-fixture parser; I1/I2/I3; error-kind classification | recorded HTTP → fetch→parse→normalize; Cloudflare status handling; honest-UA/no-auth | YES (1U-f/g) core | via error-kind |
| 2. Store | TTL/stale boundary; MISS; retain-prior | REAL sqlite/fs put→read→expire→retain-prior; concurrent read | MISS vs empty | stale boundary |
| 3. Poller+rate | ≤4/hr; backoff; hard-stop; one-throw-doesn't-sink | fan-out over stub adapters → REAL store; limiter across real cycle | write semantics (3U-h) | blocked marker persist |
| 4. Search/Merge/Rank | merge; filters; rank; overlap; all-degraded; one-error | served FROM real store; **never live-fetches (4I-a)** | preserved into results | stale + deep-link rows |
| 5. Watcher/Alert | appear/cancel diff; group rules (no per-user); idempotency; ghost slot; cold start | two REAL snapshots → diff → stub sink; multi-cycle dedupe | broken-curr no-storm | interval-bounded |
| 6. Degradation (A3) | deep-link-only + stale-flag at search | real store 3-state search | — | THE degrade contract |
| 7. Coverage acceptance | — | aggregate ≥ strong majority; all 8 accounted; health rollup | rolls up as health | counts degraded as surfaced |

---

## Gaps / under-specified-for-testing items to resolve BEFORE (or early in) DECOMPOSITION

These are architecture ambiguities that make certain tests un-writable as-is. Flagged, not resolved (no beads authored — interlock).

1. **`Slot` identity / equality key is undefined.** The watcher diff (Module 5) and cross-course overlap (4U-f) both need a canonical "is this the same slot" key. Is a slot identified by `(courseId, date, time, holes)`? What if `spotsAvailable` changes 4→2 on the same tee — is that "changed," "still there," or "partially cancelled"? **The diff semantics and the idempotency dedupe key cannot be tested until slot identity is locked.** Recommend locking a `slotKey` in DECOMPOSITION before Module 5 beads.

2. **"Good time" ranking heuristic is unspecified.** 4U-e asserts deterministic ranking but the actual preference function (morning weight? weekend? proximity to a target time?) isn't defined. Testable only as "deterministic + stable" until the heuristic is chosen. Low risk to defer, but the ranking bead needs the definition inline.

3. **Watcher alert-rule schema + delivery channel undefined.** A2 locks "group-wide, no per-user," but the RULE shape (what fields: course set? time window? min players? min spots?) and the SINK (email? SMS? push? a shared channel?) aren't specified. 5U-c and 5I-a assert rule-matching and sink-emission against an undefined schema. **Lock the rule schema + pick the notification channel before Module 5 beads** (the integration test stubs the sink, but needs to know the sink's interface).

4. **TTL and poll-interval exact values are a range (10-15min / ≤4-per-hr), not a number.** The stale-boundary test (2U-c) needs an exact TTL to assert just-under/just-over. Fine to parameterize (test reads config), but DECOMPOSITION should pin the config values so the boundary test has a concrete number.

5. **LinkLine read-auth is UNCONFIRMED (research tee-times-853).** If reading availability needs an anonymous bearer/session token, the LinkLine adapter grows a token-bootstrap step with its OWN failure mode (`kind:'auth'`) — an extra sub-surface to test (token mint → expiry → re-mint) not covered above. **Blocked on the tee-times-azn devtools capture.** The LinkLine adapter's test spec can't be finalized until the capture confirms auth shape.

6. **EZLinks path is binary and undecided (scrape vs deep-link-only).** If EZLinks becomes deep-link-only, it has NO parser/integration suite — only Module 6 degradation coverage. If it's scraped (headless/partner-API), it needs a full Module-1 suite PLUS headless-context failure modes. **The EZLinks test surface is undefined until the scrape-vs-degrade decision is made** (architecture defers this to "that adapter's build, sequenced last"). DECOMPOSITION should carry BOTH branches until the decision, or explicitly gate the EZLinks adapter bead on it.

7. **Snapshot retention depth for the watcher is "prior" (N-1) only.** If the watcher ever needs to distinguish "appeared, vanished, reappeared" across >2 cycles, N-1 retention is insufficient. Current tests assume 2-deep. If deeper history is wanted, the store contract (Module 2 retain-prior) and its tests change. Confirm 2-deep is enough for the intended alert semantics.

---

*End of locked test contract. DECOMPOSITION pairs each module's unit+integration matrix to its implementation bead(s); resolve gaps 1/3/5/6 before finalizing the Watcher and adapter beads.*
