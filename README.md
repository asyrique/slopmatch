# slopmatch.lol

Find people who build the way you do (or who cover your gaps). Your own coding agent profiles you **locally** from your transcripts and installed skills. Only a pseudonymous card plus 10 numbers is uploaded, after you approve the exact payload. Names are swapped only on a mutual, double-blind reveal.

```
skills/slopmatch/SKILL.md   ← the skill (any agent that loads SKILL.md skills)
cli/                       ← `slopmatch` CLI in TypeScript, compiled with Bun to one binary per platform
  src/fingerprint.ts         transcript extractor (Claude Code JSONL today)
  src/redact.ts              secret/PII redaction for prompt samples
  src/cli.ts                 extract, skills, config, publish, matches, reveal, status, delete
  scripts/build.ts           cross-compile: darwin-arm64/x64, linux-x64/arm64, windows-x64
  scripts/release.ts         upload binaries to R2
worker/                    ← Cloudflare Worker + D1 + R2: API, projector page, installers, binary downloads
```

## Deploy (≈5 min, from your Mac)

```bash
# backend
cd worker && npm install
npx wrangler d1 create slopmatch            # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create slopmatch-bin
npm run db:remote && npm run deploy       # → https://slopmatch.lol (custom domain in wrangler.jsonc)

# binaries (needs bun: curl -fsSL https://bun.sh/install | bash)
cd ../cli && bun install
bun run release                           # builds 5 binaries and uploads them to R2
```

`wrangler.jsonc` already routes `slopmatch.lol` as a custom domain; the zone must be on the same Cloudflare account. Change or remove the `routes` entry to deploy elsewhere.

## Install (what people in the room run)

```bash
# macOS / Linux
curl -fsSL "https://slopmatch.lol/install.sh?room=sg-build-day" | sh
# Windows PowerShell
irm "https://slopmatch.lol/install.ps1?room=sg-build-day" | iex
```

Then copy the skill into their agent and type `/slopmatch`:

```bash
cp -r skills/slopmatch ~/.claude/skills/     # Claude Code
cp -r skills/slopmatch ~/.codex/skills/      # Codex
```

Projector: `https://slopmatch.lol/r/sg-build-day`

## API

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /api/profiles | optional bearer | create (returns handle + token) or update |
| DELETE | /api/profiles | bearer | removes profile and all reveals |
| GET | /api/matches?mode=similar\|complement&limit=3 | bearer | ranked cards + which dimensions drove the score |
| POST | /api/reveals `{handle, contact}` | bearer | mutual → returns their contact |
| GET | /api/reveals | bearer | your mutual matches |
| GET | /api/room/:room | public | pseudonyms, headlines, topics, mutual pairs |
| GET | /r/:room | public | projector page |
| GET | /install.sh, /install.ps1 `?room=` | public | installers (room is validated before it's written into the script) |
| GET | /dl/:binary | public | binaries from R2 |

Score = 65% dimension fit (1 − |diff| per dimension; in complement mode, planning, exploration, delegation size and steering reward difference) + 25% shared topics + 10% shared file types.

## Development

```bash
cd cli && bun src/cli.ts extract --path ../fixtures/projects --days 30   # run from source
bun scripts/build.ts linux-x64                                           # build one target
cd ../worker && npm run db:local && npm run dev
bun ../cli/scripts/release.ts --local                                    # binaries into local R2
```

## Known gaps

- Transcript parsing is Claude Code only; Codex/pi adapters are next.
- The Windows binary and install.ps1 are built but haven't been run on a real Windows machine.
- Binaries are 60–86 MB (Bun bundles its runtime) and unsigned beyond Bun's ad-hoc Mac signature.
- No rate limiting or profile verification. Fine for a room, not for the open internet.
- Dimension scales are hand-tuned guesses; recalibrate on real data.
