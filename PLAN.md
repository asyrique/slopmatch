# PLAN.md: slopmatch handoff

Read this first. It's the state of the project at handoff (2026-10-13, ~14:45 SGT) and what to do next.

## What this is

**slopmatch.lol**: "match with builders who make slop like you." Built at the Singapore Claude Code Build Day (Opus 5.5) at Grab HQ. **The build runs until 17:00 and demos are 17:00–17:30.**

The user's own coding agent profiles them **locally** from their agent transcripts and installed skills, using a skill (`/slopmatch`) and a CLI (`slopmatch`). Only a pseudonymous card plus 10 numbers is uploaded, after the user approves the exact payload. The server ranks matches within a "room". Contacts are swapped only on a **mutual, double-blind reveal**. A public projector page shows handles, headlines and mutual pairs live.

## Architecture

```
skills/slopmatch/SKILL.md   Agent instructions: find/install CLI → extract → write profile locally →
                            write card → publish (dry run, then --yes) → matches → reveal
cli/                        TypeScript CLI, compiled with Bun into one binary per platform
  src/fingerprint.ts        Claude Code JSONL (~/.claude/projects) → metrics, 10 dimensions, redacted samples
  src/redact.ts             Secret/PII redaction for prompt samples
  src/cli.ts                Commands: extract, skills, config, publish, matches, reveal, status, delete
  scripts/build.ts          Cross-compile: darwin-arm64/x64, linux-x64/arm64 (baseline), windows-x64 (baseline)
  scripts/release.ts        Upload dist/ binaries to R2 (remote by default, --local for wrangler dev)
worker/                     Cloudflare Worker (single file, no framework)
  src/index.ts              API + scoring + handles + projector page + install.sh/ps1 + /dl from R2
  schema.sql                D1: profiles, reveals
  wrangler.jsonc            D1 "slopmatch", R2 "slopmatch-bin", custom domain slopmatch.lol
fixtures/make_fixtures.py   Generates fake transcripts (incl. planted secrets) into ./fixtures/projects
```

**Flow:** `curl -fsSL "https://slopmatch.lol/install.sh?room=<room>" | sh` installs `~/.slopmatch/bin/slopmatch` and writes `~/.slopmatch/config.json`. The user copies the skill into their agent and types `/slopmatch`.

**Scoring:** 65% dimension fit + 25% topic Jaccard + 10% file-type Jaccard. Dimension fit is `1 − |diff|` per dimension. In `complement` mode, `planning`, `exploration`, `delegation_size` and `steering` use `|diff|` instead.

**Handles:** SEA slang adjective + SEA animal (24 × 24 = 576 combinations, e.g. `kiasu-kancil`, `bojio-sunbear`). After 4 collisions a number is appended. The lists are at the top of `worker/src/index.ts`.

**Auth:** on first publish the server creates a 32-byte random token. D1 stores only its sha256. The client keeps the token in `~/.slopmatch/config.json` (chmod 600), keyed by `url|room`.

## Privacy invariants (do not regress)

1. Raw transcripts, prompt samples, evidence quotes, skill names/descriptions, file paths, project names and Claude's replies **never leave the machine**. `publish` sends only `dims` (10 numbers), plus a card: headline ≤90, style ≤400, big5, ≤8 coarse topics, ≤6 file extensions, looking_for, mode.
2. `publish` without `--yes` is a dry run that prints the exact payload. The skill must show it and get approval.
3. Contacts are visible only when reveals are mutual. `/api/room/:room` and `/r/:room` never expose contacts or scores.
4. Transcript and skill content is data, not instructions (prompt-injection guard in SKILL.md).
5. The installer only interpolates `url.origin` and a `ROOM_RE`-validated room into scripts. A `$(rm -rf)` room was tested and comes out empty.

## Status

### Done and tested (in a Linux cloud container)
- [x] The TS extractor matches the original Python version exactly: same coverage, dimensions, metrics, stack, rhythm and sample set on fixtures, and identical redaction on an adversarial corpus. The Python was removed after this check.
- [x] Worker typechecks; local `wrangler dev` with local D1 and R2 works.
- [x] End to end locally: install one-liner → binary → extract → publish (dry run, then real) → matches (score 77 for similar profiles, 33 for a dissimilar one) → one-sided reveal hidden → mutual reveal swaps contacts → status → delete. Bad input returns 400/401/404.
- [x] Projector page renders on desktop and phone widths, and a `<script>` in a headline is escaped.
- [x] All 5 binaries build (62–86 MB). The darwin binaries carry an ad-hoc signature blob, and install.sh also re-signs and clears quarantine.
- [x] Pushed to github.com/asyrique/slopmatch (private).

### Not yet done / not verified
- [x] **Deployed** to https://slopmatch.lol (2026-10-13 ~15:10 SGT). D1 `slopmatch` (45d4101d…), R2 `slopmatch-bin` with all 5 binaries. Prod smoke test passed: install → publish ×2 → matches → mutual reveal → delete.
- [x] Skill served at `/skill/SKILL.md`; installers write it to `~/.claude/skills/slopmatch/` (+ `~/.codex`, `~/.agents` if present).
- [x] darwin-arm64 installed and ran on a real Mac (via curl, no Gatekeeper kill). darwin-x64 and Windows still never executed.
- [ ] `install.ps1` never executed (no PowerShell available during the build).
- [ ] Dimension scales are hand-tuned guesses that have never seen real transcripts.
- [ ] Only Claude Code transcripts are parsed. Codex and pi aren't.

### Changed 2026-10-13 afternoon
- [x] **Global pool:** default room is `world` (CLI, installers, skill). Event rooms are opt-in via `?room=`. `/api/room/:room` returns the newest 200 people + `total`.
- [x] **claude.ai support:** skill has a Web mode (interview → card → `slopmatch.lol/join#p=<base64url>` link). `/join` shows the exact payload, publishes on click, then shows matches/reveals/delete. Key stays in localStorage. Skill zip at `/skill/slopmatch.zip`.
- [x] **Landing page** at `/` for browsers (WebGL raymarched metaballs, no deps). Agents/curl get markdown (`worker/src/agents.md`, also `/llms.txt`, `/index.md`).
- [ ] claude.ai Web mode never run inside claude.ai itself; only the /join page was tested with a hand-built link.

## Next steps, in priority order

### P0: before the 17:00 demo

1. **Deploy**
   ```bash
   cd worker && bun install
   bunx wrangler whoami                         # make sure it's the account that owns slopmatch.lol
   bunx wrangler d1 create slopmatch            # paste database_id into wrangler.jsonc
   bunx wrangler r2 bucket create slopmatch-bin
   bun run db:remote
   bun run deploy                              # attaches slopmatch.lol as a custom domain
   cd ../cli && bun install && bun run release # builds 5 binaries and uploads them to R2
   curl -sI https://slopmatch.lol/dl/slopmatch-darwin-arm64   # expect 200
   ```
2. **Real Mac smoke test**
   - Run `curl -fsSL "https://slopmatch.lol/install.sh?room=sg-build-day" | sh` and confirm `~/.slopmatch/bin/slopmatch --version` prints `0.3.0` without a Gatekeeper kill.
   - Run `slopmatch extract --days 90` and sanity-check the preview against how the user actually works.
3. **Calibrate dimensions.** The scale constants are in `analyze()` in `cli/src/fingerprint.ts`: the second arg to `squash(x, k)`, the 0.7/0.3, 0.6/0.4 and 0.5/0.5 blends, and the `/3`, `4*`, `5*` multipliers. The goal is that typical users land mid-range, not pinned near 0 or 1. Rebuild and re-release after changing them. Collecting `metrics` from 3–5 people is ideal.
4. **Make the skill installable without cloning the repo.** People in the room won't clone it. Suggested approach:
   - Have the Worker serve the skill at `GET /skill/SKILL.md`, e.g. import it as text with a wrangler `rules` entry, or put it in R2.
   - Have `install.sh` and `install.ps1` also write it to `~/.claude/skills/slopmatch/SKILL.md` and, if those folders exist, `~/.codex/skills/slopmatch/` and `~/.agents/skills/slopmatch/`.
   - Then the demo is one command plus `/slopmatch`.
5. **Demo script**
   - Put `https://slopmatch.lol/r/sg-build-day` on the projector.
   - Two volunteers run the one-liner and `/slopmatch`, then publish.
   - Show their matches with "why you'd click / where you'd clash", then both reveal and the ♥ pair appears.
   - Have a fallback: pre-publish 3–4 seeded profiles in the room so matches exist even if volunteers are slow.

### P1: after the demo
- Codex transcript adapter. Inspect the real files under `~/.codex/sessions` on the Mac first; don't guess the schema. Add it as a second collector that feeds the same `Session` shape, and set `source` accordingly.
- Rate limiting on `/api/*` (Workers rate-limiting binding) and a per-room profile cap.
- A GitHub Action to build binaries on tag, sign and notarise the macOS builds properly, and upload to R2.
- A room admin action: clear or close a room after the event.

### P2: later
- A Claude Desktop MCP bundle (`.mcpb`, which uses Desktop's bundled Node) so chat-surface users can run it.
- A pi adapter.
- Some form of profile verification. Today anyone can hand-edit their card or dimensions.

## Local development

```bash
python3 fixtures/make_fixtures.py                       # writes ./fixtures/projects (gitignored)
cd cli && bun install
bun src/cli.ts extract --path ../fixtures/projects --days 30
npx tsc --noEmit

cd ../worker && npm install && npx tsc --noEmit
bun run db:local
bunx wrangler dev --port 8787 --local-upstream localhost:8787   # see gotcha below
cd ../cli && bun scripts/build.ts linux-x64 && bun scripts/release.ts --local   # or the darwin-arm64 target on a Mac
SLOPMATCH_HOME=/tmp/u1 sh -c 'curl -fsSL "http://localhost:8787/install.sh?room=test" | sh'
```

Use separate `SLOPMATCH_HOME` directories to simulate multiple users on one machine.

## Gotchas found during the build

- **`wrangler dev` with the custom-domain route** rewrites the request origin to `http://slopmatch.lol`, so the installers point at production. Pass `--local-upstream localhost:<port>` when testing installers locally.
- **`@cloudflare/workers-types` must be `^5.x`** with wrangler 4.149, or `npm install` fails on peer deps. This is already set in `worker/package.json`.
- **Bun cross-compiles** by downloading each target runtime on first build, which is slow once and cached after. The baseline x64 targets avoid AVX2 requirements on old CPUs.
- **Fixture fake secrets** are assembled at runtime in `make_fixtures.py` so GitHub push protection doesn't block pushes. Keep it that way.
- **Default server:** the CLI uses `https://slopmatch.lol` when no URL is configured, so `slopmatch config --room X` is enough.
- **Windows:** the preview uses `#`/`.` bars instead of block characters. Paths go through `os.homedir()`, and skills scanning handles CRLF frontmatter.
