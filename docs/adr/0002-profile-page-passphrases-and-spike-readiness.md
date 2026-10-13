# ADR 0002: Profile page, passphrase logins and readiness for a traffic spike

- **Status:** Accepted
- **Date:** 2026-10-13
- **Builds on:** [ADR 0001](0001-slopmatch-launch-architecture.md)

## Context

After launch, the owner asked for four things:

- a simple profile page that people can get back to, including by reopening the link Claude gave them;
- a passphrase instead of a long key, plus a QR code;
- one global pool, with no rooms or room admin;
- a review of what breaks if a crowd shows up at once.

## Decisions

### 1. One global pool, no room features

We are not building room admin or per-room caps, and the event-room hints are gone from the site, the skill and the agent instructions. The API still takes a `room` value (`world`), so existing CLIs and links keep working.

- **Why:** the owner wants slopmatch to be global and fun. Rooms added UI and operational surface for little value.

### 2. Profile page at `/me`

`/me` and `/join` serve the same page. The profile view shows:

- the handle, headline, style and tags;
- the ten dimensions as bars, plus the Big 5;
- matches, mutual reveals and a delete button.

The Worker exposes `GET /api/profiles` (authenticated) for this, and the CLI has `slopmatch profile`.

Ways back to a profile:

- **Same browser:** the key is in `localStorage`, so `/me` just works.
- **Reopening Claude's link:** if this browser already published that card, the page goes straight to the profile with "Welcome back". If the card is different, the page shows the review with an **Update my profile** button. That updates the existing profile instead of creating a duplicate.
- **Another device:** type the four-word passphrase at `/me`, open the private link `/me#k=<passphrase>`, or scan the QR from the profile page.

The page re-runs its startup logic on `hashchange`, so a link pasted into an already-open tab works too. Testing found that this case was broken before.

### 3. Four-word passphrases as the only login credential

Every profile's login is a four-word passphrase, for example `kopi-otter-mango-comet`:

- 256 words, one random byte per word, so 32 bits and no modulo bias;
- the server stores only its sha256;
- the old 64-hex tokens are no longer accepted (`TOKEN_RE` matches four words only). The owner said there's no need to support them, and production had no profiles yet.

**Why 32 bits is enough.** Four words are easy to type on a phone. 32 bits is about 4.3 billion combinations, which would be weak on its own, so failed logins are what we limit:

- Every 401 on a request that carried a key counts against `AUTHFAIL` (10 a minute per IP). Past that, the isolate blocks that IP's keyed requests for 60s.
- Per-token limits can't do this job, because each guess sends a different key.
- Publishing with a wrong key now returns 401 and counts as a failure. Before, it quietly created a new profile, which would have made it a free probe.

With 10,000 profiles, a random guess hits someone about once in 430,000 tries. At 10 guesses a minute per IP, that's roughly a month per IP. A large botnet could do better, and what a hijacker would get is a pseudonymous card plus that profile's mutual contacts. If that becomes a concern, go to 5 words (40 bits) or a 2,048-word list.

**Clients:**

- The `/join` page and the CLI treat a rejected saved key as stale. On publish they drop it and sign up fresh.
- Other CLI commands print "Your saved profile key isn't accepted any more… Run: slopmatch publish".
- `slopmatch profile` prints the passphrase and the private link.

**Alternative considered:** a passphrase that maps to a separate hex token. Rejected because the server only stores hashes, so it can't hand a token back without rotating it.

**QR code:** `POST /api/qr` returns an SVG, but only for `<origin>/me#k=…` text. Because it's a POST body, the passphrase never appears in a URL or a server log.

### 4. Readiness for a spike

What would break, and what we changed:

| Hot spot | Before | Now |
|---|---|---|
| `/api/matches` | Read the whole room from D1 on every call (N rows read per call) | Each isolate keeps a candidate pool cache: the newest 5,000 profiles, already parsed, for 15s. Concurrent requests share one in-flight query. New index `idx_profiles_room_updated`. |
| `/api/room/:room` | Every landing tab polled every 8s and every projector every 4s. Each poll ran COUNT + 200-row SELECT + join | Edge-cached with `caches.default` for 10s. The landing page polls every 20s (60s in background tabs) and the projector every 6s |
| Rate limits | 20 writes/min per IP. A venue's shared Wi-Fi would throttle the whole room | Keyed by the user's token when there is one. WRITES 30/min and READS 240/min per user; anonymous sign-ups get SIGNUPS 300/min per IP; failed logins get AUTHFAIL 10/min per IP, then a 60s block |
| Handles | 8 attempts, 0–99 suffix. Fills up quickly in a global pool, then 503 | 12 attempts, 0–999 suffix after 4 collisions (about 1.15M handles) |
| Landing HTML | QR SVG regenerated on every request | Memoised per origin |

**Consequences:**

- A profile can take up to 15s to show up in other people's matches, and to disappear after a delete. A reveal to a just-deleted handle returns 404.
- Matching only considers the newest 5,000 profiles. Past that we need precomputed candidates (for example, dimension buckets) or a vector index.
- D1 is single-writer, which is fine for sign-up-scale writes.
- Binary downloads stream from R2, which has no egress fees.

### 5. CI

`.github/workflows/ci.yml` runs on pushes and PRs:

- typecheck;
- check that `plugin/` is in sync with `cli/src`;
- a smoke test of the plugin CLI on the test transcripts.

On a `v*` tag that matches the CLI `VERSION`, it builds and uploads the five binaries to R2. That needs the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Notarising the macOS builds is not included, because it needs Apple Developer credentials.

### 6. Version 0.4.0

The CLI and plugin go to 0.4.0, adding `slopmatch profile`, so plugin users are offered the update.

## Still open

- **Can't be done from this machine:**
  - calibrating the dimensions (needs real users' metrics);
  - a Codex adapter (no `~/.codex/sessions` on this Mac to inspect);
  - running `install.ps1`, the Windows binaries or the Windows plugin shim (no PowerShell or Windows here);
  - the macOS x64 binary (Rosetta isn't installed);
  - Open in Claude inside the native mobile app.
- **Needs an owner decision:** a LICENSE, and the Cloudflare secrets for the CI release job.
