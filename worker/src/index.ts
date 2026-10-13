/**
 * slopmatch backend: pseudonymous builder profiles, ranking, double-blind reveal.
 * The server never sees transcripts, prompts or skills — only a card + 10 numbers per person.
 */

export interface Env {
  DB: D1Database;
  BIN: R2Bucket;
}

const BINARIES = new Set([
  "slopmatch-darwin-arm64", "slopmatch-darwin-x64", "slopmatch-linux-x64", "slopmatch-linux-arm64", "slopmatch-windows-x64.exe",
]);

const DIMS = [
  "planning", "delegation_size", "verification", "steering", "exploration",
  "verbosity", "curiosity", "warmth", "frustration", "night_owl",
] as const;
type Dim = (typeof DIMS)[number];
type Dims = Record<Dim, number>;

/** Dimensions where, in "complement" mode, being different is the good outcome (division of labour). */
const COMPLEMENTABLE = new Set<Dim>(["planning", "exploration", "delegation_size", "steering"]);

interface Card {
  headline: string;
  style: string;
  big5: Record<"O" | "C" | "E" | "A" | "N", number>;
  topics: string[];
  file_types: string[];
  looking_for: string;
  mode: "similar" | "complement";
}

interface ProfileRow {
  id: string;
  room: string;
  handle: string;
  dims: string;
  card: string;
}

const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
// Pseudonyms: Southeast Asian slang adjective + Southeast Asian animal, e.g. "kiasu-kancil", "bojio-sunbear".
const ADJ = [
  "kiasu", "kiasi", "bojio", "shiok", "paiseh", "sian", "kancheong", "cincai", "kaypoh", "atas", "lansi", "jialat", // SG/MY
  "suay", "garang", "comel", "rajin", "malas", "manja", "santai", "mager",                                         // MY/ID
  "sabai", "sanuk", "kilig", "gigil",                                                                              // TH/PH
];
const ANIMAL = [
  "sunbear", "orangutan", "kancil", "pangolin", "tarsier", "hornbill", "dugong", "binturong", "macaque", "tapir",
  "komodo", "gibbon", "tamaraw", "saola", "seladang", "cicak", "arowana", "otter", "slowloris", "colugo",
  "babirusa", "harimau", "mudskipper", "kingcobra",
];

// ---------------------------------------------------------------- http helpers
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const err = (status: number, error: string) => json({ error }, status);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 8_000) throw new HttpError(413, "payload too large");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "invalid JSON"); }
}

async function auth(req: Request, env: Env): Promise<ProfileRow | null> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  return env.DB.prepare("SELECT id, room, handle, dims, card FROM profiles WHERE token_hash = ?")
    .bind(await sha256(m[1])).first<ProfileRow>();
}

async function requireAuth(req: Request, env: Env): Promise<ProfileRow> {
  const me = await auth(req, env);
  if (!me) throw new HttpError(401, "unknown or missing token");
  return me;
}

// ---------------------------------------------------------------- validation
const num01 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 1000) / 1000)) : 0.5;
};
const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const tags = (v: unknown, max: number, len: number) =>
  Array.isArray(v) ? [...new Set(v.map((t) => str(t, len).toLowerCase()).filter(Boolean))].slice(0, max) : [];

function cleanDims(v: any): Dims {
  if (!v || typeof v !== "object") throw new HttpError(400, "dims required");
  return Object.fromEntries(DIMS.map((k) => [k, num01(v[k])])) as Dims;
}

function cleanCard(v: any): Card {
  if (!v || typeof v !== "object") throw new HttpError(400, "card required");
  const b = v.big5 || {};
  return {
    headline: str(v.headline, 90),
    style: str(v.style, 400),
    big5: { O: num01(b.O), C: num01(b.C), E: num01(b.E), A: num01(b.A), N: num01(b.N) },
    topics: tags(v.topics, 8, 30),
    file_types: tags(v.file_types, 6, 10),
    looking_for: str(v.looking_for || "just curious", 40),
    mode: v.mode === "complement" ? "complement" : "similar",
  };
}

// ---------------------------------------------------------------- scoring
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

function score(me: { dims: Dims; card: Card }, them: { dims: Dims; card: Card }, mode: Card["mode"]) {
  const per = DIMS.map((d) => {
    const diff = Math.abs(me.dims[d] - them.dims[d]);
    const fit = mode === "complement" && COMPLEMENTABLE.has(d) ? diff : 1 - diff;
    return { d, fit, mine: me.dims[d], theirs: them.dims[d] };
  });
  const dimScore = per.reduce((s, p) => s + p.fit, 0) / per.length;
  const topicScore = jaccard(me.card.topics, them.card.topics);
  const stackScore = jaccard(me.card.file_types, them.card.file_types);
  const total = 0.65 * dimScore + 0.25 * topicScore + 0.1 * stackScore;
  const sorted = [...per].sort((a, b) => b.fit - a.fit);
  return {
    score: Math.round(total * 100),
    drivers: {
      clicks_on: sorted.slice(0, 3).map(({ d, mine, theirs }) => ({ dim: d, mine, theirs })),
      clashes_on: sorted.slice(-2).reverse().map(({ d, mine, theirs }) => ({ dim: d, mine, theirs })),
      shared_topics: me.card.topics.filter((t) => them.card.topics.includes(t)),
      shared_file_types: me.card.file_types.filter((t) => them.card.file_types.includes(t)),
    },
  };
}

const parse = (r: ProfileRow) => ({ dims: JSON.parse(r.dims) as Dims, card: JSON.parse(r.card) as Card });

// ---------------------------------------------------------------- handlers
async function upsertProfile(req: Request, env: Env) {
  const body = await readJson(req);
  const room = str(body.room, 32).toLowerCase();
  if (!ROOM_RE.test(room)) throw new HttpError(400, "room must be 3-32 chars: a-z 0-9 -");
  const dims = cleanDims(body.dims);
  const card = cleanCard(body.card);
  const now = Date.now();
  const me = await auth(req, env);

  if (me) {
    if (me.room !== room) throw new HttpError(400, "token belongs to a different room");
    await env.DB.prepare("UPDATE profiles SET dims = ?, card = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(dims), JSON.stringify(card), now, me.id).run();
    return json({ handle: me.handle, updated: true });
  }

  const token = randomToken();
  const id = crypto.randomUUID();
  const tokenHash = await sha256(token);
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = crypto.getRandomValues(new Uint8Array(3));
    let handle = `${ADJ[r[0] % ADJ.length]}-${ANIMAL[r[1] % ANIMAL.length]}`;
    if (attempt >= 4) handle += `-${r[2] % 100}`;
    try {
      await env.DB.prepare(
        "INSERT INTO profiles (id, room, handle, token_hash, dims, card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, room, handle, tokenHash, JSON.stringify(dims), JSON.stringify(card), now, now).run();
      return json({ handle, token, updated: false }, 201);
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
    }
  }
  throw new HttpError(503, "could not allocate a handle, try again");
}

async function matches(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  const url = new URL(req.url);
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 3));
  const mine = parse(me);
  const mode = url.searchParams.get("mode") === "complement" ? "complement"
    : url.searchParams.get("mode") === "similar" ? "similar" : mine.card.mode;

  const { results } = await env.DB.prepare("SELECT id, room, handle, dims, card FROM profiles WHERE room = ? AND id != ?")
    .bind(me.room, me.id).all<ProfileRow>();
  const { results: outgoing } = await env.DB.prepare("SELECT to_id FROM reveals WHERE from_id = ?")
    .bind(me.id).all<{ to_id: string }>();
  const revealed = new Set(outgoing.map((r) => r.to_id));

  const ranked = results
    .map((r) => {
      const them = parse(r);
      return { handle: r.handle, ...score(mine, them, mode), card: them.card, you_revealed: revealed.has(r.id) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return json({ you: me.handle, room: me.room, mode, people_in_room: results.length + 1, matches: ranked });
}

async function reveal(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  const body = await readJson(req);
  const contact = str(body.contact, 120);
  if (!contact) throw new HttpError(400, "contact required");
  const target = await env.DB.prepare("SELECT id, handle FROM profiles WHERE room = ? AND handle = ?")
    .bind(me.room, str(body.handle, 40).toLowerCase()).first<{ id: string; handle: string }>();
  if (!target) throw new HttpError(404, "no one with that handle in this room");
  if (target.id === me.id) throw new HttpError(400, "that's you");

  await env.DB.prepare(
    "INSERT INTO reveals (from_id, to_id, contact, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT (from_id, to_id) DO UPDATE SET contact = excluded.contact",
  ).bind(me.id, target.id, contact, Date.now()).run();

  const back = await env.DB.prepare("SELECT contact FROM reveals WHERE from_id = ? AND to_id = ?")
    .bind(target.id, me.id).first<{ contact: string }>();
  return back
    ? json({ handle: target.handle, mutual: true, their_contact: back.contact })
    : json({ handle: target.handle, mutual: false, note: "Saved. They'll only see your contact if they reveal you too." });
}

async function revealStatus(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  const { results } = await env.DB.prepare(
    `SELECT p.handle, theirs.contact AS their_contact
       FROM reveals mine
       JOIN reveals theirs ON theirs.from_id = mine.to_id AND theirs.to_id = mine.from_id
       JOIN profiles p ON p.id = mine.to_id
      WHERE mine.from_id = ?`,
  ).bind(me.id).all<{ handle: string; their_contact: string }>();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM reveals WHERE from_id = ?")
    .bind(me.id).first<{ n: number }>();
  return json({ you: me.handle, mutual: results, waiting_on_them: (pending?.n ?? 0) - results.length });
}

async function deleteProfile(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reveals WHERE from_id = ? OR to_id = ?").bind(me.id, me.id),
    env.DB.prepare("DELETE FROM profiles WHERE id = ?").bind(me.id),
  ]);
  return json({ deleted: true });
}

/** Public, projector-friendly view: pseudonyms, headlines, mutual pairs. No contacts, no scores. */
async function roomData(room: string, env: Env) {
  if (!ROOM_RE.test(room)) throw new HttpError(404, "no such room");
  const { results } = await env.DB.prepare(
    "SELECT id, handle, card FROM profiles WHERE room = ? ORDER BY created_at",
  ).bind(room).all<{ id: string; handle: string; card: string }>();
  const { results: pairs } = await env.DB.prepare(
    `SELECT a.handle AS a, b.handle AS b FROM reveals r1
       JOIN reveals r2 ON r2.from_id = r1.to_id AND r2.to_id = r1.from_id
       JOIN profiles a ON a.id = r1.from_id
       JOIN profiles b ON b.id = r1.to_id
      WHERE a.room = ? AND r1.from_id < r1.to_id`,
  ).bind(room).all<{ a: string; b: string }>();
  return json({
    room,
    people: results.map((r) => {
      const c = JSON.parse(r.card) as Card;
      return { handle: r.handle, headline: c.headline, topics: c.topics, looking_for: c.looking_for };
    }),
    mutual_pairs: pairs,
  });
}

// ---------------------------------------------------------------- binaries & installers
// The skill is bundled as text (wrangler `rules`) so installers can drop it straight into the agent.
import SKILL_MD from "../../skills/slopmatch/SKILL.md";

async function download(name: string, req: Request, env: Env) {
  if (!BINARIES.has(name)) throw new HttpError(404, "no such binary");
  const obj = req.method === "HEAD" ? await env.BIN.head(name) : await env.BIN.get(name);
  if (!obj) throw new HttpError(404, "binary not uploaded yet: run `bun run release` in cli/");
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${name}"`,
    "content-length": String(obj.size),
    "cache-control": "public, max-age=300",
    etag: obj.httpEtag,
  });
  return new Response(req.method === "HEAD" ? null : (obj as R2ObjectBody).body, { headers });
}

function installer(path: string, url: URL) {
  // Only ever interpolate values we have validated: the origin and a ROOM_RE-checked room.
  const roomParam = (url.searchParams.get("room") || "").toLowerCase();
  const room = ROOM_RE.test(roomParam) ? roomParam : "";
  const tpl = path === "/install.sh" ? INSTALL_SH : INSTALL_PS1;
  const body = tpl.replaceAll("__BASE__", url.origin).replaceAll("__ROOM__", room);
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

const INSTALL_SH = `#!/bin/sh
# slopmatch installer for macOS and Linux. Installs one binary to ~/.slopmatch/bin and the /slopmatch skill for your agent.
set -eu
BASE="__BASE__"
ROOM="__ROOM__"
os=$(uname -s); arch=$(uname -m)
case "$os" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported OS: $os. On Windows use install.ps1." >&2; exit 1 ;; esac
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "Unsupported CPU: $arch" >&2; exit 1 ;; esac
# A Rosetta shell on Apple Silicon reports x86_64; prefer the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
dir="\${SLOPMATCH_HOME:-$HOME/.slopmatch}/bin"
mkdir -p "$dir"
echo "Downloading slopmatch for $os-$arch..."
curl -fSL --progress-bar "$BASE/dl/slopmatch-$os-$arch" -o "$dir/slopmatch.tmp"
chmod +x "$dir/slopmatch.tmp"
mv -f "$dir/slopmatch.tmp" "$dir/slopmatch"
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$dir/slopmatch" 2>/dev/null || true
  codesign --force --sign - "$dir/slopmatch" 2>/dev/null || true
fi
if [ -n "$ROOM" ]; then "$dir/slopmatch" config --url "$BASE" --room "$ROOM" >/dev/null; else "$dir/slopmatch" config --url "$BASE" >/dev/null; fi
echo "Installed $dir/slopmatch ($("$dir/slopmatch" --version))"
# Install the /slopmatch skill for Claude Code, plus Codex and other agents whose folders already exist.
if skill=$(curl -fsSL "$BASE/skill/SKILL.md"); then
  for agent in "$HOME/.claude" "$HOME/.codex" "$HOME/.agents"; do
    if [ "$agent" = "$HOME/.claude" ] || [ -d "$agent" ]; then
      mkdir -p "$agent/skills/slopmatch" && printf '%s\\n' "$skill" > "$agent/skills/slopmatch/SKILL.md" && echo "Skill installed: $agent/skills/slopmatch/SKILL.md"
    fi
  done
else
  echo "Could not download the skill; get it from $BASE/skill/SKILL.md" >&2
fi
echo "Next: start a new agent session and run /slopmatch"
`;

const INSTALL_PS1 = `# slopmatch installer for Windows. Installs one binary to %USERPROFILE%\\.slopmatch\\bin and the /slopmatch skill for your agent.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Base = "__BASE__"
$Room = "__ROOM__"
$root = if ($env:SLOPMATCH_HOME) { $env:SLOPMATCH_HOME } else { Join-Path $env:USERPROFILE ".slopmatch" }
$dir = Join-Path $root "bin"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir "slopmatch.exe"
Write-Host "Downloading slopmatch for windows-x64..."
Invoke-WebRequest -UseBasicParsing -Uri "$Base/dl/slopmatch-windows-x64.exe" -OutFile "$exe.tmp"
Move-Item -Force "$exe.tmp" $exe
Unblock-File $exe
if ($Room) { & $exe config --url $Base --room $Room | Out-Null } else { & $exe config --url $Base | Out-Null }
Write-Host "Installed $exe ($(& $exe --version))"
# Install the /slopmatch skill for Claude Code, plus Codex and other agents whose folders already exist.
try {
  $skill = (Invoke-WebRequest -UseBasicParsing -Uri "$Base/skill/SKILL.md").Content
  foreach ($name in ".claude", ".codex", ".agents") {
    $agent = Join-Path $env:USERPROFILE $name
    if ($name -eq ".claude" -or (Test-Path $agent)) {
      $sd = Join-Path $agent "skills\\slopmatch"
      New-Item -ItemType Directory -Force -Path $sd | Out-Null
      [IO.File]::WriteAllText((Join-Path $sd "SKILL.md"), $skill)
      Write-Host "Skill installed: $sd\\SKILL.md"
    }
  }
} catch { Write-Host "Could not download the skill; get it from $Base/skill/SKILL.md" }
Write-Host "Next: start a new agent session and run /slopmatch"
`;

// ---------------------------------------------------------------- router
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (p === "/api/profiles" && req.method === "POST") return await upsertProfile(req, env);
      if (p === "/api/profiles" && req.method === "DELETE") return await deleteProfile(req, env);
      if (p === "/api/matches" && req.method === "GET") return await matches(req, env);
      if (p === "/api/reveals" && req.method === "POST") return await reveal(req, env);
      if (p === "/api/reveals" && req.method === "GET") return await revealStatus(req, env);
      let m = p.match(/^\/api\/room\/([^/]+)$/);
      if (m && req.method === "GET") return await roomData(decodeURIComponent(m[1]), env);
      m = p.match(/^\/r\/([^/]+)$/);
      if (m && req.method === "GET") return new Response(ROOM_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      m = p.match(/^\/dl\/([^/]+)$/);
      if (m && (req.method === "GET" || req.method === "HEAD")) return await download(m[1], req, env);
      if (p === "/install.sh" || p === "/install.ps1") return installer(p, url);
      if (p === "/skill/SKILL.md" && (req.method === "GET" || req.method === "HEAD")) {
        return new Response(req.method === "HEAD" ? null : SKILL_MD, {
          headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=60" },
        });
      }
      if (p === "/") {
        return new Response(
          "slopmatch\n\n" +
          `Mac/Linux:  curl -fsSL ${url.origin}/install.sh?room=<room> | sh\n` +
          `Windows:    irm "${url.origin}/install.ps1?room=<room>" | iex\n\n` +
          `The installer also adds the /slopmatch skill to Claude Code (and Codex if present): ${url.origin}/skill/SKILL.md\n` +
          "Open /r/<room> on the projector.\n",
        );
      }
      return err(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.message);
      console.error(e);
      return err(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- projector page
const ROOM_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>slopmatch room</title>
<style>
  :root { --bg:#0e0f12; --card:#181a20; --ink:#f2efe9; --muted:#8b8f99; --accent:#ff7a59; --line:#2a2d36; }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; padding:32px 16px; }
  header { max-width:1200px; margin:0 auto 24px; display:flex; justify-content:space-between; align-items:baseline; gap:16px; flex-wrap:wrap }
  h1 { margin:0; font-size:clamp(28px,5vw,48px); letter-spacing:-.02em } h1 span { color:var(--accent) }
  .count { color:var(--muted); font-size:18px }
  .pairs { max-width:1200px; margin:0 auto 24px; display:flex; flex-wrap:wrap; gap:10px }
  .pair { background:var(--accent); color:#1a0d08; font-weight:700; padding:8px 14px; border-radius:999px }
  .grid { max-width:1200px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px }
  .p { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; animation:in .4s ease }
  .h { font-weight:700; font-size:18px } .hl { color:var(--muted); margin:6px 0 10px }
  .t { display:inline-block; font-size:12px; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin:0 4px 4px 0; color:var(--muted) }
  .lf { font-size:12px; color:var(--accent); text-transform:uppercase; letter-spacing:.06em }
  @keyframes in { from { opacity:0; transform:translateY(6px) } }
</style></head><body>
<header><h1>slop<span>match</span> · <span id="room"></span></h1><div class="count" id="count"></div></header>
<div class="pairs" id="pairs"></div>
<div class="grid" id="grid"></div>
<script>
const room = decodeURIComponent(location.pathname.split("/").pop());
document.getElementById("room").textContent = room;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function tick() {
  try {
    const r = await fetch("/api/room/" + encodeURIComponent(room)); if (!r.ok) return;
    const d = await r.json();
    document.getElementById("count").textContent = d.people.length + (d.people.length === 1 ? " builder · " : " builders · ") + d.mutual_pairs.length + (d.mutual_pairs.length === 1 ? " mutual match" : " mutual matches");
    document.getElementById("pairs").innerHTML = d.mutual_pairs.map((p) => '<div class="pair">' + esc(p.a) + " ♥ " + esc(p.b) + "</div>").join("");
    document.getElementById("grid").innerHTML = d.people.map((p) =>
      '<div class="p"><div class="lf">' + esc(p.looking_for) + '</div><div class="h">' + esc(p.handle) + '</div><div class="hl">' +
      esc(p.headline) + "</div>" + p.topics.map((t) => '<span class="t">' + esc(t) + "</span>").join("") + "</div>").join("");
  } catch (e) {}
}
tick(); setInterval(tick, 4000);
</script></body></html>`;
