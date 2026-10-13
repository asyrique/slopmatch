/**
 * slopmatch backend: pseudonymous builder profiles, ranking, double-blind reveal.
 * The server never sees transcripts, prompts or skills — only a card + 10 numbers per person.
 */

export interface Env {
  DB: D1Database;
  BIN: R2Bucket;
  WRITES: RateLimit;
  READS: RateLimit;
  SIGNUPS: RateLimit;
  AUTHFAIL: RateLimit;
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
/** Everyone lands here unless they opt into a private room (e.g. for an event). */
const DEFAULT_ROOM = "world";
// Pseudonyms: Southeast Asian slang or English adjective + Southeast Asian animal, e.g. "kiasu-kancil", "feral-sunbear".
const ADJ = [
  "kiasu", "kiasi", "bojio", "shiok", "paiseh", "sian", "kancheong", "cincai", "kaypoh", "atas", "lansi", "jialat", // SG/MY
  "suay", "garang", "comel", "rajin", "malas", "manja", "santai", "mager",                                         // MY/ID
  "sabai", "sanuk", "kilig", "gigil",                                                                              // TH/PH
  "sloppy", "feral", "cursed", "caffeinated", "sleepy", "chaotic", "sneaky", "cosmic", "spicy", "grumpy", "cheeky", "wobbly",
  "sassy", "zesty", "crunchy", "soggy", "turbo", "scrappy", "unhinged", "vibey", "shiny", "dramatic", "nocturnal", "gremlin", // English
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

/**
 * Login credential for new profiles: a four-word passphrase (256 words, one random byte each = 32 bits), e.g.
 * "kopi-otter-mango-comet". Easy to type on another device. 32 bits is only safe because failed logins are
 * limited per IP (AUTHFAIL, then a 60s block), see failedAuth(). Only its sha256 is stored.
 */
const PASS_WORDS = [
  "kopi", "teh", "milo", "laksa", "satay", "roti", "prata", "kaya", "durian", "mango", "rambutan", "mangosteen",
  "lychee", "pandan", "sago", "tofu", "mee", "rice", "noodle", "dumpling", "bun", "curry", "chili", "lime", "ginger",
  "garlic", "lemongrass", "coconut", "papaya", "guava", "banana", "jackfruit", "otter", "tapir", "dugong", "gibbon",
  "hornbill", "kancil", "tarsier", "pangolin", "sunbear", "komodo", "gecko", "heron", "egret", "kingfisher", "myna",
  "peacock", "turtle", "squid", "crab", "prawn", "clam", "oyster", "starfish", "jellyfish", "dolphin", "whale",
  "shark", "manta", "seahorse", "mudskipper", "puffer", "koi", "river", "ocean", "island", "beach", "reef", "lagoon",
  "harbour", "jetty", "bridge", "tower", "temple", "market", "hawker", "kampung", "village", "garden", "jungle",
  "forest", "mangrove", "orchid", "lotus", "hibiscus", "bamboo", "fern", "banyan", "monsoon", "thunder", "rainbow",
  "sunset", "sunrise", "moon", "comet", "planet", "rocket", "galaxy", "nebula", "meteor", "orbit", "star", "cloud",
  "breeze", "storm", "drizzle", "puddle", "pebble", "boulder", "canyon", "pixel", "laptop", "keyboard", "cursor",
  "widget", "module", "kernel", "socket", "packet", "buffer", "cache", "shell", "script", "compiler", "linter",
  "syntax", "lambda", "vector", "matrix", "tensor", "gradient", "prompt", "token", "agent", "skill", "plugin",
  "branch", "commit", "merge", "rebase", "deploy", "lantern", "kite", "drum", "flute", "gong", "bell", "compass",
  "anchor", "sail", "paddle", "oar", "map", "scroll", "ink", "brush", "canvas", "pencil", "eraser", "notebook",
  "stamp", "ticket", "parcel", "basket", "bucket", "ladder", "rope", "lamp", "candle", "mirror", "window", "door",
  "tiger", "lion", "panda", "koala", "zebra", "camel", "llama", "alpaca", "hamster", "rabbit", "squirrel", "badger",
  "beaver", "walrus", "penguin", "puffin", "falcon", "owl", "raven", "parrot", "toucan", "flamingo", "pelican",
  "swan", "goose", "duck", "robin", "sparrow", "wren", "finch", "lark", "violet", "amber", "jade", "ruby", "coral",
  "ivory", "indigo", "crimson", "cobalt", "saffron", "teal", "olive", "maroon", "silver", "golden", "bronze",
  "apple", "cherry", "peach", "plum", "pear", "melon", "grape", "berry", "kiwi", "fig", "date", "walnut", "almond",
  "cashew", "peanut", "waffle", "pancake", "muffin", "cookie", "biscuit", "toast", "bagel", "pretzel", "soup",
  "salad", "pizza", "taco", "burrito", "sushi", "ramen", "mochi", "kueh", "chendol", "ondeh", "rojak", "popiah",
];
const TOKEN_RE = /^[a-z]+(?:-[a-z]+){3}$/;
function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => PASS_WORDS[b]).join("-");
}

// Guessing sends a different passphrase every time, so per-token limits never trip for an attacker.
// Count failed logins per IP instead; past AUTHFAIL's budget the IP is blocked for a minute (per isolate).
const authBlockedUntil = new Map<string, number>();
const authBlocked = (ip: string) => (authBlockedUntil.get(ip) ?? 0) > Date.now();
async function failedAuth(ip: string, env: Env) {
  const { success } = await env.AUTHFAIL.limit({ key: "ip:" + ip });
  if (!success) {
    authBlockedUntil.set(ip, Date.now() + 60_000);
    if (authBlockedUntil.size > 10_000) authBlockedUntil.clear(); // bound memory under a flood
  }
}

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 8_000) throw new HttpError(413, "payload too large");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "invalid JSON"); }
}

async function auth(req: Request, env: Env): Promise<ProfileRow | null> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m || !TOKEN_RE.test(m[1])) return null;
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
  const card: Card = {
    headline: str(v.headline, 90),
    style: str(v.style, 400),
    big5: { O: num01(b.O), C: num01(b.C), E: num01(b.E), A: num01(b.A), N: num01(b.N) },
    topics: tags(v.topics, 8, 30),
    file_types: tags(v.file_types, 6, 10),
    looking_for: str(v.looking_for || "just curious", 40),
    mode: v.mode === "complement" ? "complement" : "similar",
  };
  // everything on the card is shown to other people (matches, world page), so keep it clean
  const fields: [string, string][] = [["headline", card.headline], ["style", card.style], ["topics", card.topics.join(" ")], ["looking_for", card.looking_for]];
  for (const [name, text] of fields) if (hasBadWords(text)) throw new HttpError(400, `please keep it clean: the ${name.replace("_", " ")} ${name === "topics" ? "have" : "has"} a word we don't allow`);
  return card;
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
  // a wrong key must fail (and count as a failed login), not quietly create a new profile
  if (!me && req.headers.get("authorization")) throw new HttpError(401, "unknown or missing token");

  if (me) {
    if (me.room !== room) throw new HttpError(400, "token belongs to a different room");
    await env.DB.prepare("UPDATE profiles SET dims = ?, card = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(dims), JSON.stringify(card), now, me.id).run();
    return json({ handle: me.handle, updated: true });
  }

  const token = randomToken();
  const id = crypto.randomUUID();
  const tokenHash = await sha256(token);
  // 1,152 bare handles fill up in a global pool, so after 4 collisions add a number (0-999: ~1.15M handles)
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = crypto.getRandomValues(new Uint16Array(3));
    let handle = `${ADJ[r[0] % ADJ.length]}-${ANIMAL[r[1] % ANIMAL.length]}`;
    if (attempt >= 4) handle += `-${r[2] % 1000}`;
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

// ---------------------------------------------------------------- candidate pool cache
// Every /api/matches call used to read the whole room from D1. Under a spike that's N rows per call, so each
// isolate keeps the newest POOL_MAX profiles (already parsed) for POOL_TTL_MS and scores against that.
// New or deleted profiles show up in other people's matches within the TTL.
const POOL_TTL_MS = 15_000, POOL_MAX = 5000;
type PoolRow = { id: string; handle: string; dims: Dims; card: Card };
const poolCache = new Map<string, { at: number; rows: Promise<PoolRow[]> }>();
function candidatePool(room: string, env: Env): Promise<PoolRow[]> {
  const hit = poolCache.get(room);
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.rows;
  const rows = env.DB.prepare("SELECT id, handle, dims, card FROM profiles WHERE room = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(room, POOL_MAX).all<{ id: string; handle: string; dims: string; card: string }>()
    .then(({ results }) => results.map((r) => ({ id: r.id, handle: r.handle, dims: JSON.parse(r.dims) as Dims, card: JSON.parse(r.card) as Card })));
  // share one in-flight query between concurrent requests; drop it on failure so the next call retries
  poolCache.set(room, { at: Date.now(), rows });
  rows.catch(() => poolCache.delete(room));
  return rows;
}

async function matches(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  const url = new URL(req.url);
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 3));
  const mine = parse(me);
  const mode = url.searchParams.get("mode") === "complement" ? "complement"
    : url.searchParams.get("mode") === "similar" ? "similar" : mine.card.mode;

  const results = (await candidatePool(me.room, env)).filter((r) => r.id !== me.id);
  const { results: outgoing } = await env.DB.prepare("SELECT to_id FROM reveals WHERE from_id = ?")
    .bind(me.id).all<{ to_id: string }>();
  const revealed = new Set(outgoing.map((r) => r.to_id));

  const ranked = results
    .map((r) => ({ handle: r.handle, ...score(mine, r, mode), card: r.card, you_revealed: revealed.has(r.id) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return json({ you: me.handle, room: me.room, mode, people_in_room: results.length + 1, matches: ranked });
}

async function reveal(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  const body = await readJson(req);
  const contact = str(body.contact, 120);
  if (hasBadWords(contact)) throw new HttpError(400, "please keep it clean: the contact has a word we don't allow");
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

/** Your own profile, for the /me page and `slopmatch profile`. */
async function getProfile(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  const { dims, card } = parse(me);
  return json({ handle: me.handle, room: me.room, dims, card });
}

async function deleteProfile(req: Request, env: Env) {
  const me = await requireAuth(req, env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reveals WHERE from_id = ? OR to_id = ?").bind(me.id, me.id),
    env.DB.prepare("DELETE FROM profiles WHERE id = ?").bind(me.id),
  ]);
  return json({ deleted: true });
}

/** Every open landing page and projector polls this, so serve it from the edge cache for 10s. */
async function cachedRoomData(room: string, url: URL, env: Env, ctx: ExecutionContext) {
  const cache = caches.default, key = new Request(`${url.origin}/api/room/${encodeURIComponent(room)}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const fresh = await roomData(room, env);
  const res = new Response(fresh.body, fresh);
  res.headers.set("cache-control", "public, max-age=10");
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** Public, projector-friendly view: pseudonyms, headlines, mutual pairs. No contacts, no scores. */
async function roomData(room: string, env: Env) {
  if (!ROOM_RE.test(room)) throw new HttpError(404, "no such room");
  // The global room can be large: show the newest 200 and report the total separately.
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM profiles WHERE room = ?").bind(room).first<number>("n");
  const { results } = await env.DB.prepare(
    "SELECT id, handle, card FROM profiles WHERE room = ? ORDER BY created_at DESC LIMIT 200",
  ).bind(room).all<{ id: string; handle: string; card: string }>();
  const { results: pairs } = await env.DB.prepare(
    `SELECT a.handle AS a, b.handle AS b FROM reveals r1
       JOIN reveals r2 ON r2.from_id = r1.to_id AND r2.to_id = r1.from_id
       JOIN profiles a ON a.id = r1.from_id
       JOIN profiles b ON b.id = r1.to_id
      WHERE a.room = ? AND r1.from_id < r1.to_id ORDER BY MAX(r1.created_at, r2.created_at) DESC LIMIT 100`,
  ).bind(room).all<{ a: string; b: string }>();
  return json({
    room,
    total: total ?? results.length,
    people: results.map((r) => {
      const c = JSON.parse(r.card) as Card;
      return { handle: r.handle, headline: c.headline, topics: c.topics, looking_for: c.looking_for };
    }),
    mutual_pairs: pairs,
  });
}

// ---------------------------------------------------------------- binaries & installers
// The skill is bundled as text (wrangler `rules`) so installers can drop it straight into the agent.
import PLUGIN_SKILL_MD from "../../plugin/skills/me/SKILL.md";
import AGENTS_MD from "./agents.md";
import LANDING_HTML from "./landing.html";
import JOIN_HTML from "./join.html";
import ROOM_HTML from "./room.html";
import PROMPT_MD from "./prompt.md";
import qrcode from "qrcode-generator";
import { hasBadWords } from "./clean";

// In the plugin the skill is "me" (/slopmatch:me). Installed on its own (curl installer, claude.ai zip) it keeps the name slopmatch.
const SKILL_MD = PLUGIN_SKILL_MD.replace(/^name: me$/m, "name: slopmatch");

// JSON for inline <script>; escape "<" so nothing in it can close the script tag.
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const LANDING = LANDING_HTML.replace("__HANDLE_WORDS__", inlineJson({ adj: ADJ, animal: ANIMAL })).replace("__PROMPT__", inlineJson(PROMPT_MD));
const JOIN = JOIN_HTML.replace("__PROMPT__", inlineJson(PROMPT_MD));
const landingByOrigin = new Map<string, string>();

/** Browsers get the landing page; curl, agents and anything asking for markdown get install instructions. */
function wantsHtml(req: Request) {
  const accept = req.headers.get("accept") || "";
  const ua = req.headers.get("user-agent") || "";
  if (/text\/markdown|text\/plain/.test(accept)) return false;
  if (/claude|anthropic|openai|gpt|codex|cursor|copilot|gemini|perplexity|bot\b|crawler|spider|agent|curl|wget|httpie|python|node|undici|axios|bun\/|deno|go-http/i.test(ua)) return false;
  return accept.includes("text/html") && /mozilla/i.test(ua);
}

/** claude.ai uploads skills as a zip holding one folder: slopmatch/SKILL.md. Stored (uncompressed) is enough. */
function zipOne(name: string, text: string): Uint8Array {
  const data = new TextEncoder().encode(text), fname = new TextEncoder().encode(name);
  let crc = ~0;
  for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  crc = ~crc >>> 0;
  const local = new DataView(new ArrayBuffer(30)), central = new DataView(new ArrayBuffer(46)), end = new DataView(new ArrayBuffer(22));
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01; zip needs some date
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(12, DOS_DATE, true);
  local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, fname.length, true);
  central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(14, DOS_DATE, true);
  central.setUint32(16, crc, true); central.setUint32(20, data.length, true); central.setUint32(24, data.length, true); central.setUint16(28, fname.length, true);
  const cdOffset = 30 + fname.length + data.length, cdSize = 46 + fname.length;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, cdSize, true); end.setUint32(16, cdOffset, true);
  const parts = [new Uint8Array(local.buffer), fname, data, new Uint8Array(central.buffer), fname, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
const SKILL_ZIP = zipOne("slopmatch/SKILL.md", SKILL_MD);

/** QR for this site's own /join page (never arbitrary input), dark on light so every phone camera reads it. */
function qrSvg(text: string, opts: { live?: boolean } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), pad = 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const size = n + pad * 2;
  // live: the landing page recolours the gradient stops from the 3D scene behind the card (kept dark enough to scan)
  const defs = opts.live
    ? `<defs><linearGradient id="qrg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${size}" y2="${size}"><stop offset="0" stop-color="#0a0a0f"/><stop offset=".5" stop-color="#0a0a0f"/><stop offset="1" stop-color="#0a0a0f"/></linearGradient></defs>`
    : "";
  const attrs = opts.live ? ` class="qr-live" role="img" aria-label="QR code linking to ${text}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${attrs} viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${defs}<rect width="${size}" height="${size}" fill="#f4f1ea"/><path d="${d}" fill="${opts.live ? "url(#qrg)" : "#0a0a0f"}"/></svg>`;
}

function markdown(url: URL) {
  return new Response(AGENTS_MD.replaceAll("__BASE__", url.origin), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=60", vary: "Accept, User-Agent" },
  });
}

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
  const room = ROOM_RE.test(roomParam) ? roomParam : DEFAULT_ROOM;
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
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const bearer = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/)?.[1];
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    try {
      if (p.startsWith("/api/") && p !== "/api/room" && !p.startsWith("/api/room/")) {
        if (bearer && authBlocked(ip)) throw new HttpError(429, "too many wrong passphrases from here, try again in a minute");
        // Key by the user's token when there is one: at an event everyone shares the venue's IP, so per-IP write
        // limits would throttle the whole room. Anonymous writes (new sign-ups) get a generous per-IP allowance.
        const key = bearer && TOKEN_RE.test(bearer) ? "t:" + (await sha256(bearer)).slice(0, 24) : "ip:" + ip;
        const limiter = req.method === "GET" ? env.READS : key.startsWith("t:") ? env.WRITES : env.SIGNUPS;
        const { success } = await limiter.limit({ key });
        if (!success) throw new HttpError(429, "slow down: too many requests, try again in a minute");
      }
      if (p === "/api/profiles" && req.method === "GET") return await getProfile(req, env);
      if (p === "/api/qr" && req.method === "POST") {
        const text = str((await readJson(req)).text, 300);
        if (!text.startsWith(`${url.origin}/me#k=`)) throw new HttpError(400, "only private profile links");
        return new Response(qrSvg(text), { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
      }
      if (p === "/api/profiles" && req.method === "POST") return await upsertProfile(req, env);
      if (p === "/api/profiles" && req.method === "DELETE") return await deleteProfile(req, env);
      if (p === "/api/matches" && req.method === "GET") return await matches(req, env);
      if (p === "/api/reveals" && req.method === "POST") return await reveal(req, env);
      if (p === "/api/reveals" && req.method === "GET") return await revealStatus(req, env);
      let m = p.match(/^\/api\/room\/([^/]+)$/);
      if (m && req.method === "GET") return await cachedRoomData(decodeURIComponent(m[1]), url, env, ctx);
      m = p.match(/^\/r\/([^/]+)$/);
      if (m && req.method === "GET") return new Response(ROOM_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
      m = p.match(/^\/dl\/([^/]+)$/);
      if (m && (req.method === "GET" || req.method === "HEAD")) return await download(m[1], req, env);
      if (p === "/install.sh" || p === "/install.ps1") return installer(p, url);
      if (p === "/skill/SKILL.md" && (req.method === "GET" || req.method === "HEAD")) {
        return new Response(req.method === "HEAD" ? null : SKILL_MD, {
          headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=60" },
        });
      }
      if (p === "/llms.txt" || p === "/index.md") return markdown(url);
      if (p === "/qr.svg") {
        return new Response(qrSvg(`${url.origin}/join`), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
      }
      if (p === "/prompt") return new Response(PROMPT_MD, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" } });
      if (p === "/join" || p === "/me") return new Response(JOIN, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
      if (p === "/skill/slopmatch.zip") {
        return new Response(SKILL_ZIP, {
          headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="slopmatch.zip"', "cache-control": "public, max-age=60" },
        });
      }
      if (p === "/") {
        if (!wantsHtml(req)) return markdown(url);
        let page = landingByOrigin.get(url.origin);
        if (!page) landingByOrigin.set(url.origin, (page = LANDING.replace("__QR_SVG__", qrSvg(`${url.origin}/join`, { live: true }))));
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", vary: "Accept, User-Agent" },
        });
      }
      return err(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401 && bearer) await failedAuth(ip, env);
        return err(e.status, e.message);
      }
      console.error(e);
      return err(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
