# ADR 0001: slopmatch launch architecture and product decisions

- **Status:** Accepted
- **Date:** 2026-10-13
- **Context of the work:** Claude Code Build Day, Singapore. This picks up from the handoff in `PLAN.md` (commit `841997d`) through to the launch on https://slopmatch.lol (commit `935e8f6`).

## Context

slopmatch matches builders by how they work with AI. The pre-launch design (see `PLAN.md`) was:

- a local CLI that fingerprints Claude Code transcripts,
- a skill that has the user's own agent write a pseudonymous card,
- a Cloudflare Worker that ranks matches inside a "room" and swaps contacts only on a mutual reveal.

At handoff, the Worker had not been deployed. It had only been installed via `curl | sh`, only worked from a terminal agent, and was scoped to a single event room.

The privacy invariants in `PLAN.md` still hold. Raw transcripts, prompts, paths, project names and skill contents never leave the machine. `publish` is a dry run until the user approves the exact payload. Contacts appear only on a mutual reveal.

## Decisions

### 1. Hosting: Cloudflare Worker + D1 + R2 on slopmatch.lol

The Worker is deployed with `slopmatch.lol` as a custom domain. It uses D1 database `slopmatch` (id `45d4101d-53c8-4270-8557-f10d281ec21c`) and R2 bucket `slopmatch-bin` for the compiled binaries.

- **Why:** this was already designed and tested locally. A single Worker serves the API, every page and the downloads.
- **Consequences:** Cloudflare account `asyrique@gmail.com` owns all of it. To deploy, run `bunx wrangler deploy` from `worker/`. The schema is applied with `bun run db:remote`.

### 2. Bun everywhere instead of npm

`package-lock.json` was removed. Scripts and docs use `bun install`, `bun run` and `bunx wrangler`.

- **Why:** this is the owner's standing preference.

### 3. One global pool (`world`) instead of per-event rooms

The default room is `world` in the CLI (`DEFAULT_ROOM`), in both installers and in the skill. Event rooms still work as an opt-in, via `?room=` on the installer or `slopmatch config --room`.

`/api/room/:room` returns the newest 200 people plus a `total` count. Mutual pairs are capped at 100.

- **Why:** the owner wants it to work for builders anywhere, not only for people in the room.
- **Alternative considered:** removing rooms entirely. Rejected because it would mean changing the CLI, the server and the skill, and events still benefit from private rooms.
- **Consequences:** `matches` still loads every profile in the room on each call. That is fine for thousands of profiles. Past that it needs pagination or precomputed candidates. Rate limiting is still on the P1 list.

### 4. Content negotiation at `/`: HTML for browsers, markdown for agents

Browsers get the landing page. curl, agent fetchers (matched by user agent: claude, openai, curl, python and so on) and anything requesting `text/markdown` get install instructions from `worker/src/agents.md`. The same markdown is also served at `/llms.txt` and `/index.md`, and the HTML includes a `rel="alternate"` link plus a visually hidden pointer to it.

- **Why:** the owner wants users to be able to point their agent at slopmatch.lol and have it just work. Some agent fetchers send browser-like headers, so the explicit URLs and the in-page pointer are fallbacks.

### 5. claude.ai and mobile support via a memory-based prompt and a `/join` page

Chat surfaces can't read local transcripts and usually can't reach slopmatch.lol from their sandbox, so this route works differently:

- **The prompt.** `worker/src/prompt.md`, served at `/prompt`, is modelled on Claude's memory-export prompt. Claude mines its memory and past chats about the user, then gives two parts:
  - **Part 1, private:** builder style with evidence, a just-for-fun Big Five, and an explicit list of guesses.
  - **Part 2:** a single tappable link, `https://slopmatch.lol/join#d=…&b=…&h=…&s=…&t=…&f=…&l=…&m=…`.

  The link format can be written by hand: dimensions are whole numbers 0–100 and text uses `+` for spaces. That matters because the Claude mobile app usually has no code tool, so base64 isn't reliable there.
- **The `/join` page.**
  - It parses `#d=` (compact), `#p=` (base64url JSON, used by the skill when it has a code tool), `#j=` (percent-encoded JSON), or a pasted reply (link or JSON, even with prose or code fences around it).
  - It strips the fragment from the URL after reading it, shows the exact payload, and publishes only when the user clicks.
  - It then shows matches, reveals, mutual contacts and delete.
  - The token lives in the browser's `localStorage`.
- **Open in Claude.** The button uses `https://claude.ai/new?q=<prompt>`, which opens a new chat with the prompt filled in.
- **The skill zip.** `/skill/slopmatch.zip` is a single-file stored zip built inside the Worker, for uploading the skill to claude.ai.
- **Why the fragment:** the card data sits in the URL fragment, which is never sent to a server. The page keeps the "approve the exact payload" invariant for people who never touch a terminal.
- **Consequences:**
  - Interview- and memory-based profiles are rougher than transcript-based ones, and the prompt says so.
  - claude.ai shows its own "use caution before running this prompt" banner on pre-filled prompts. That's expected and we can't change it.
  - Whether `claude.ai/new?q=` pre-fills inside the native Claude mobile app is unverified. "Copy the prompt" is the fallback.

### 6. Distribution: Claude Code plugin first, `curl | sh` as fallback

The repo is a plugin marketplace (`.claude-plugin/marketplace.json`) and the plugin lives in `plugin/`. Install with:

```
claude plugin install slopmatch --marketplace asyrique/slopmatch
```

The CLI ships inside the plugin as **readable JavaScript**:

- `plugin/bin/slopmatch.mjs` is the CLI, unminified, bundled by `cli/scripts/build-plugin.ts` (`bun run build:plugin`).
- `plugin/bin/slopmatch` is a small CommonJS launcher so it runs on Node 18+.
- `plugin/bin/slopmatch.cmd` is the Windows shim.

Claude Code puts the plugin's `bin/` on the Bash tool's PATH, so `slopmatch` works as a plain command. The build script keeps the plugin version in step with `VERSION` in `cli/src/cli.ts`.

- **Why:** the owner found `curl | sh` and a 60–90 MB opaque binary "very sus". A plugin is installed by Claude Code from a public repo, needs no shell piping, and the code anyone runs can be read.
- **Alternatives considered:**
  - Keep `curl | sh` and add checksums: still opaque.
  - A separate public plugin repo: rejected once the owner made the main repo public.
- **Consequences:**
  - It requires Node 18+. The skill falls back to the binary installer, and asks first, if `node` is missing.
  - The curl installers and the R2 binaries stay for Codex and other agents.
  - Users only get updates when the plugin `version` changes.
  - Tested: a real install from GitHub, and `slopmatch --version` resolving to the plugin's `bin/` inside a session. Only Node 24 on macOS was exercised. The Windows `.cmd` shim has not been run.

### 7. Skill naming: `/slopmatch:me`

In the plugin, the skill is `plugin/skills/me/SKILL.md` with `name: me`, which gives `/slopmatch:me` (plugin name before the colon, skill name after). The Worker rewrites the frontmatter to `name: slopmatch` when it serves the same file standalone (`/skill/SKILL.md`, the curl installers and the claude.ai zip), so those installs keep `/slopmatch` instead of a bare `/me`.

- **Why:** the owner asked for `/slopmatch:me`. There is one source file, and only its name differs per route.

### 8. Pseudonyms: 48 adjectives × 24 animals

The 24 Southeast Asian slang adjectives were joined by 24 English ones (sloppy, feral, cursed, caffeinated, … gremlin), for 1,152 combinations. A number is still appended after 4 collisions.

- **Why:** a global pool needs more headroom. (No English list existed in git history, so these are new.)
- **Consequences:** existing profiles keep their handles. The byte-modulo pick is slightly biased, as it was before.

### 9. Landing page design

`worker/src/landing.html` is bundled as text through a wrangler `rules` entry. It has no front-end framework and no external JS. Fonts come from Google Fonts.

- **Hero:** a full-screen WebGL raymarched metaball scene. Pairs of blobs orbit, merge and split, and one blob follows the cursor. The resolution adapts to frame rate, and the scene fades as you scroll past the hero.
- **Install box, one instruction per device:**
  - phones: Open in Claude only
  - desktop: the plugin command, with links to the code, to the curl installer for the user's OS ("no Claude Code?"), and to claude.ai
- **QR card, desktop only, linking to `/join`.** It is part of the 3D scene:
  - a blob pair settles behind its frosted glass, and a droplet shuttles to it
  - hovering swells the blob and tilts the card
  - the QR modules take their colour from the WebGL pixels around the card. Saturation is boosted, then the brightest channel is capped at 110/255, which keeps about 4.5:1 contrast so it still scans.

  The projector page `/r/:room` has a plain black QR. The QR is generated in the Worker (`qrcode-generator`) and only ever encodes the site's own `/join` URL.
- **Sections that show rather than tell:**
  - **How it works:** a scripted Claude Code session types itself out, with a step rail.
  - **Privacy, "the bouncer":** local items bounce off the dry-run gate, and only the approved payload fields get through.
  - **Matching, "the slop compatibility test":** six sliders, a radar chart of you against your top match, generated "why you'd click / where you'd clash" lines, and similar/complement re-ranking against a made-up cast.
- **Why:** the owner asked for a good-looking 3D site, then for the sections to be better and more fun.
- **Consequences:** the compatibility test is a simplification (6 dimensions, no topics). The page says the cast is made up and shows the real formula (65% dimensions, 25% topics, 10% file types).

### 10. Small fixes made along the way

- The extractor now ignores Claude Code's `[Image: original …]` placeholders, which were being counted as prompts.
- In complement mode, the compatibility test now says "you both …, so nobody covers the other side" when being too alike is the clash.

## Verification done

- **Production smoke tests:** install → publish ×2 → matches → mutual reveal → delete. Test profiles were deleted afterwards.
- **The `/join` flow** (link, paste, publish, reveal, delete) was exercised against local `wrangler dev`.
- **Live-site checks in Chrome via Claude in Chrome:** the hero install switches, copy, QR hover, session replay, the bouncer, slider drags, mode buttons, the slot machine, the reveal demo and `/join`. There were no console errors.
- **The QR code** decodes correctly, including when tinted (Chrome `BarcodeDetector`).

## Open items

- Dimension scales are still uncalibrated against real users: collect `metrics` from 3–5 people.
- Not yet run: the macOS x64 and Windows binaries, `install.ps1`, the plugin on Windows, and Open in Claude inside the native mobile app.
- P1 from `PLAN.md` is still open: Codex transcript adapter, rate limiting and a per-room cap, CI build/sign/notarise, room admin.
- No LICENSE file yet, so `plugin.json` omits `license`.
