#!/usr/bin/env bun
// slopmatch: local builder profiling + slopmatch client. One binary, no runtime needed.

import { parseArgs } from "node:util";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { buildFingerprint, previewText } from "./fingerprint";

const VERSION = "0.3.0";
const DEFAULT_URL = "https://slopmatch.lol";
const DIMS = ["planning", "delegation_size", "verification", "steering", "exploration",
  "verbosity", "curiosity", "warmth", "frustration", "night_owl"];

const HELP = `slopmatch ${VERSION} - find people who build the way you do

Local (nothing leaves your machine):
  slopmatch extract [--days 90] [--path DIR] [--redact-terms "Acme,Jane"] [--no-samples] [--quiet]
  slopmatch skills

Server (default https://slopmatch.lol; needs: slopmatch config --room ROOM):
  slopmatch config [--url URL] [--room ROOM]
  slopmatch publish [--card FILE] [--yes]        dry run unless --yes
  slopmatch matches [--mode similar|complement] [--limit 3]
  slopmatch reveal <handle> --contact "telegram @me"
  slopmatch status
  slopmatch delete --yes

Global: --url, --room override config. Env: SLOPMATCH_URL, SLOPMATCH_ROOM, SLOPMATCH_HOME.`;

// ---------------------------------------------------------------- paths & config
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p);
const HOME = resolve(expandHome(process.env.SLOPMATCH_HOME || "~/.slopmatch"));
const CONFIG = join(HOME, "config.json");
const FINGERPRINT = join(HOME, "fingerprint.json");
const DEFAULT_TRANSCRIPTS = join(resolve(expandHome(process.env.CLAUDE_CONFIG_DIR || "~/.claude")), "projects");
const SKILL_DIRS = ["~/.claude/skills", "~/.claude/plugins", "~/.codex/skills", "~/.agents/skills",
  "~/.config/opencode/skills", "./.claude/skills", "./.agents/skills"];

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}
const out = (x: unknown) => process.stdout.write((typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\n");

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
const loadConfig = () => readJson(CONFIG) || {};
function saveConfig(cfg: any) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  try { chmodSync(CONFIG, 0o600); } catch {}
}

// ---------------------------------------------------------------- args
const { values: v, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        url: { type: "string" }, room: { type: "string" },
        days: { type: "string" }, path: { type: "string" }, samples: { type: "string" },
        "no-samples": { type: "boolean" }, "redact-terms": { type: "string" }, out: { type: "string" },
        quiet: { type: "boolean" }, card: { type: "string" }, yes: { type: "boolean" },
        mode: { type: "string" }, limit: { type: "string" }, contact: { type: "string" },
        help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      },
    });
  } catch (e: any) {
    die(`${e.message}\n\n${HELP}`);
  }
})();

function target() {
  const cfg = loadConfig();
  const url = (v.url || process.env.SLOPMATCH_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, "");
  const room = v.room || process.env.SLOPMATCH_ROOM || cfg.room || "";
  if (!room) die("No room set. Run: slopmatch config --room <room>");
  return { cfg, url, room, key: `${url}|${room}` };
}

function identity() {
  const t = target();
  const ident = t.cfg.identities?.[t.key];
  if (!ident) die("You haven't published a profile in this room yet. Run: slopmatch publish");
  return { ...t, ident };
}

async function call(method: string, url: string, path: string, body?: unknown, token?: string) {
  let res: Response;
  try {
    res = await fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json", "user-agent": `slopmatch/${VERSION}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    die(`Could not reach ${url}: ${e.message}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) die(`Server returned ${res.status}: ${data.error || res.statusText}`);
  return data;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num01 = (x: unknown, dflt = 0.5) => {
  const n = Number(x ?? dflt);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
};

// ---------------------------------------------------------------- commands
async function cmdExtract() {
  const days = Number(v.days || 90);
  if (!Number.isFinite(days) || days <= 0) die("--days must be a positive number");
  const path = resolve(expandHome(v.path || DEFAULT_TRANSCRIPTS));
  if (!existsSync(path)) die(`No transcripts found at ${path}. Use --path to point at your Claude Code projects folder.`);
  const profile = await buildFingerprint({
    path, days, samples: Number(v.samples || 30), noSamples: !!v["no-samples"], redactTerms: v["redact-terms"] || "",
  });
  if (profile.coverage.sessions === 0) die(`No sessions in the last ${days} days under ${path}. Try --days 365.`);
  const dest = resolve(expandHome(v.out || FINGERPRINT));
  mkdirSync(resolve(dest, ".."), { recursive: true });
  writeFileSync(dest, JSON.stringify(profile, null, 2), "utf8");
  if (!v.quiet) out(previewText(profile));
  out(`Wrote ${dest}. Review the samples; they stay on this machine.`);
}

function* walkSkills(dir: string, depth = 0): Generator<string> {
  if (depth > 8) return;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkSkills(p, depth + 1);
    else if (e.isFile() && e.name === "SKILL.md") yield p;
  }
}

function fmField(fm: string, key: string) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  if (!m) return "";
  let val = m[1].trim();
  if (["|", ">", "|-", ">-"].includes(val)) {
    const rest = fm.slice((m.index || 0) + m[0].length).split(/\r?\n/).slice(1);
    const block: string[] = [];
    for (const l of rest) { if (/^[ \t]/.test(l)) block.push(l.trim()); else if (l.trim()) break; }
    val = block.join(" ").slice(0, 400);
  }
  return val.replace(/^["']|["']$/g, "");
}

function cmdSkills() {
  const seen = new Set<string>();
  const skills: { name: string; description: string; source: string }[] = [];
  for (const d of SKILL_DIRS) {
    const root = resolve(expandHome(d));
    for (const p of walkSkills(root)) {
      if (skills.length >= 200) break;
      let text = "";
      try { text = readFileSync(p, "utf8").slice(0, 4000); } catch { continue; }
      const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
      const name = fmField(fm, "name") || relative(root, p).split(sep).slice(-2, -1)[0] || "unknown";
      if (seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description: fmField(fm, "description").slice(0, 400), source: d });
    }
  }
  out({ note: "LOCAL ONLY. Derive coarse topic tags; never upload these names or descriptions.", skills });
}

function cmdConfig() {
  const cfg = loadConfig();
  if (v.url) cfg.url = v.url.replace(/\/+$/, "");
  if (v.room) cfg.room = v.room;
  saveConfig(cfg);
  out({ url: cfg.url ?? DEFAULT_URL, room: cfg.room ?? null, config: CONFIG });
}

function buildPayload(card: any, fp: any, room: string) {
  const dims = fp.dimensions || {};
  const big5 = card.big5 || {};
  const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    room,
    dims: Object.fromEntries(DIMS.map((k) => [k, r(num01(dims[k]), 3)])),
    card: {
      headline: clip(card.headline, 90),
      style: clip(card.style, 400),
      big5: Object.fromEntries("OCEAN".split("").map((k) => [k, r(num01(big5[k]), 2)])),
      topics: (Array.isArray(card.topics) ? card.topics : []).map((t: unknown) => clip(t, 30).toLowerCase()).filter(Boolean).slice(0, 8),
      file_types: Object.keys(fp.stack?.file_types || {}).slice(0, 6),
      looking_for: clip(card.looking_for || "just curious", 40),
      mode: card.mode === "complement" ? "complement" : "similar",
    },
  };
}

async function cmdPublish() {
  const t = target();
  const fp = readJson(FINGERPRINT);
  if (!fp) die("No fingerprint yet. Run: slopmatch extract");
  const cardPath = resolve(expandHome(v.card || join(HOME, "card.json")));
  const card = readJson(cardPath);
  if (!card) die(`Could not read card JSON at ${cardPath}`);
  const payload = buildPayload(card, fp, t.room);
  if (!v.yes) {
    out(`DRY RUN. This is exactly what would be sent to ${t.url}\n`);
    out(payload);
    out("\nShow this to the user. Re-run with --yes only after they approve.");
    return;
  }
  const ident = t.cfg.identities?.[t.key];
  const res = await call("POST", t.url, "/api/profiles", payload, ident?.token);
  if (res.token) {
    t.cfg.identities = { ...(t.cfg.identities || {}), [t.key]: { handle: res.handle, token: res.token } };
    saveConfig(t.cfg);
  }
  out({ handle: res.handle, room: t.room, updated: !!res.updated });
}

async function cmdMatches() {
  const { url, ident } = identity();
  const limit = Number(v.limit || 3);
  if (v.mode && !["similar", "complement"].includes(v.mode)) die("--mode must be similar or complement");
  out(await call("GET", url, `/api/matches?limit=${limit}${v.mode ? `&mode=${v.mode}` : ""}`, undefined, ident.token));
}

async function cmdReveal() {
  const { url, ident } = identity();
  const handle = positionals[1];
  if (!handle) die("Usage: slopmatch reveal <handle> --contact \"telegram @me\"");
  if (!v.contact) die("--contact is required");
  out(await call("POST", url, "/api/reveals", { handle, contact: clip(v.contact, 120) }, ident.token));
}

async function cmdStatus() {
  const { url, ident } = identity();
  out(await call("GET", url, "/api/reveals", undefined, ident.token));
}

async function cmdDelete() {
  const t = identity();
  if (!v.yes) die(`This deletes '${t.ident.handle}' and its reveals from ${t.url}. Re-run with --yes.`);
  await call("DELETE", t.url, "/api/profiles", undefined, t.ident.token);
  delete t.cfg.identities[t.key];
  saveConfig(t.cfg);
  out("Deleted.");
}

// ---------------------------------------------------------------- main
const commands: Record<string, () => unknown> = {
  extract: cmdExtract, skills: cmdSkills, config: cmdConfig, publish: cmdPublish,
  matches: cmdMatches, reveal: cmdReveal, status: cmdStatus, delete: cmdDelete,
};

if (v.version) out(VERSION);
else if (v.help || !positionals[0]) out(HELP);
else {
  const fn = commands[positionals[0]];
  if (!fn) die(`Unknown command: ${positionals[0]}\n\n${HELP}`);
  await fn();
}
