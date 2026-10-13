// Turns Claude Code transcripts into a privacy-safe builder profile. Runs entirely locally.

import { createReadStream, readdirSync, statSync, type Dirent } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { makeRedactor } from "./redact";

export const SCHEMA = "builder-fingerprint/1";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

const TEST_CMD = /\b(pytest|py\.test|unittest|(npm|pnpm|yarn|bun)( run)? test|vitest|jest|go test|cargo test|mix test|rspec|phpunit|dotnet test|make test|tox|nox|playwright test|cypress run|swift test|xcodebuild test)\b/;
const LINT_CMD = /\b(tsc|mypy|pyright|ruff|eslint|biome|clippy|golangci-lint|flake8|pylint|cargo check|go vet|swiftlint)\b/;
const INTERRUPT = /^\[Request interrupted by user/;
const CORRECTION = /^\s*(no\b|nope\b|wrong\b|that'?s (not|wrong)|not what i|undo\b|revert\b|stop\b|wait\b|actually\b|don'?t\b|why did you|you (broke|deleted|removed|forgot|missed)|still (not|broken|failing|doesn'?t|the same))/i;
const POLITE = /\b(please|pls|plz|thanks|thank you|thx|ty|cheers|appreciate|great job|nice work|well done|awesome|perfect)\b/i;
const FRUSTRATION = /(\bwtf\b|\bffs\b|\bugh+\b|\bargh+\b|\bdamn+\b|\bfuck|\bshit\b|\bcrap\b|\bseriously\b|!!+|\?\?+)/i;
const QUESTION = /\?\s*$|^(how|what|why|which|should|can|could|would|is|are|does|do)\b/i;
const EXPLORE = /\b(alternatives?|options|trade-?offs?|compare|what if|explore|brainstorm|ideas?|other ways?|pros and cons|approaches)\b/i;
const VERIFY_ASK = /\b(tests?|verify|double[- ]check|check that|make sure|validate|confirm|run it|does it work)\b/i;

const SYS_TAG = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CMD_NAME = /<command-name>\s*\/?([\w:.-]+)\s*<\/command-name>/;
const IMAGE_PH = /\[Image #\d+\]/g;
const NOISE_PREFIXES = [
  "<local-command-", "<command-message>", "<command-args>", "Caveat: The messages below",
  "<bash-input>", "<bash-stdout>", "<bash-stderr>", "[Image: original ",
  "This session is being continued from a previous conversation",
];
const CMD_TOKEN = /^[a-z][a-z0-9._-]{1,24}$/;
const CMD_WRAPPERS = new Set(["sudo", "time", "env", "npx", "bunx", "uvx", "pnpx", "nohup", "exec"]);

// ---------------------------------------------------------------- helpers
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const nwords = (t: string) => t.split(/\s+/).filter(Boolean).length;
const squash = (x: number, k: number) => r3(1 - Math.exp(-Math.max(x, 0) / k));
const ratio = (a: number, b: number) => (b ? a / b : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
}
function caps(text: string) {
  const ws = text.match(/[A-Za-z]{4,}/g) || [];
  const up = ws.filter((w) => w === w.toUpperCase());
  return up.length >= 3 && up.length / Math.max(ws.length, 1) >= 0.3;
}
function commandHeads(cmd: string) {
  const out: string[] = [];
  for (const part of cmd.split(/&&|\|\||;|\||\n/)) {
    let toks = part.trim().split(/\s+/).filter(Boolean);
    while (toks.length && (/^[A-Z_][A-Z0-9_]*=/.test(toks[0]) || CMD_WRAPPERS.has(toks[0]))) toks = toks.slice(1);
    if (toks.length && toks[0] !== "cd" && CMD_TOKEN.test(toks[0])) out.push(toks[0]);
  }
  return out;
}
function suffix(p: string) {
  const base = p.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}
function parseTs(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const withTz = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s + "Z";
  const d = new Date(withTz);
  return isNaN(d.getTime()) ? null : d;
}
class Counter extends Map<string, number> {
  add(k: string, n = 1) { this.set(k, (this.get(k) || 0) + n); }
  top(n: number, min = 1) {
    return Object.fromEntries([...this.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).filter(([, v]) => v >= min));
  }
}

// ---------------------------------------------------------------- parsing
type Kind = "prompt" | "interrupt" | "command" | "rejection";
interface Session { events: [Date, Kind, string][]; tools: [Date, string, any][]; ts: Date[] }

function classifyUser(entry: any): [Kind, string][] {
  const content = entry?.message?.content;
  const texts: string[] = [];
  let rejected = false;
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") texts.push(b.text || "");
      else if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : b.content ? JSON.stringify(b.content).slice(0, 800) : "";
        if (c.includes("doesn't want to proceed") || c.toLowerCase().includes("user rejected")) rejected = true;
      }
    }
  }
  const events: [Kind, string][] = rejected ? [["rejection", ""]] : [];
  const text = texts.join("\n").replace(SYS_TAG, "").trim();
  if (!text) return events;
  if (INTERRUPT.test(text)) return [...events, ["interrupt", ""]];
  const m = text.match(CMD_NAME);
  if (m) return [...events, ["command", m[1].replace(/^\/+/, "")]];
  if (NOISE_PREFIXES.some((p) => text.startsWith(p)) || entry.isCompactSummary) return events;
  return [...events, ["prompt", text.replace(IMAGE_PH, "[image]")]];
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

async function collect(root: string, cutoff: Date) {
  const sessions = new Map<string, Session>();
  const projects = new Set<string>();
  const models = new Counter();
  let filesRead = 0, badLines = 0;

  for (const f of walkJsonl(root)) {
    try { if (statSync(f).mtime < cutoff) continue; } catch { continue; }
    filesRead++;
    const stem = (f.split(/[\\/]/).pop() || "").replace(/\.jsonl$/, "");
    const rl = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { badLines++; continue; }
      if (!e || typeof e !== "object" || Array.isArray(e) || e.isSidechain) continue;
      if (e.type !== "user" && e.type !== "assistant") continue;
      const ts = parseTs(e.timestamp);
      if (!ts || ts < cutoff) continue;
      const sid = e.sessionId || stem;
      let s = sessions.get(sid);
      if (!s) sessions.set(sid, (s = { events: [], tools: [], ts: [] }));
      s.ts.push(ts);
      if (e.cwd) projects.add(e.cwd);
      if (e.type === "user") {
        for (const [k, t] of classifyUser(e)) s.events.push([ts, k, t]);
      } else {
        const msg = e.message || {};
        if (typeof msg.model === "string" && msg.model && !msg.model.startsWith("<")) models.add(msg.model);
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b && typeof b === "object" && b.type === "tool_use") {
            s.tools.push([ts, b.name || "?", b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {}]);
          }
        }
      }
    }
  }
  return { sessions, projects, models, readStats: { files_read: filesRead, malformed_lines: badLines } };
}

// ---------------------------------------------------------------- analysis
export interface PromptRec { s: number; open: boolean; reaction: boolean; text: string }

function analyze(sessions: Map<string, Session>, projects: Set<string>, models: Counter) {
  const m = new Counter();
  const prompts: PromptRec[] = [];
  const promptWords: number[] = [], activeMin: number[] = [];
  const wordsBeforeEdit: number[] = [], toolsPerPrompt: number[] = [], testsPerEditSession: number[] = [];
  const hours = new Array(24).fill(0);
  let weekend = 0, planSessions = 0, editSessions = 0;
  const toolCounts = new Counter(), exts = new Counter(), cmds = new Counter(), slash = new Counter();
  let first: Date | null = null, last: Date | null = null;
  const c = (k: string) => m.get(k) || 0;

  const minTs = (s: Session) => (s.ts.length ? Math.min(...s.ts.map((d) => d.getTime())) : Infinity);
  const ordered = [...sessions.values()].sort((a, b) => minTs(a) - minTs(b));
  let si = -1;
  for (const s of ordered) {
    const events = [...s.events].sort((a, b) => a[0].getTime() - b[0].getTime());
    const tools = [...s.tools].sort((a, b) => a[0].getTime() - b[0].getTime());
    const sp = events.filter((e) => e[1] === "prompt");
    if (!sp.length && !tools.length) continue;
    si++;
    m.add("sessions");
    const tsSorted = [...s.ts].sort((a, b) => a.getTime() - b.getTime());
    if (!first || tsSorted[0] < first) first = tsSorted[0];
    if (!last || tsSorted[tsSorted.length - 1] > last) last = tsSorted[tsSorted.length - 1];
    let act = 0;
    for (let i = 1; i < tsSorted.length; i++) act += Math.min((tsSorted[i].getTime() - tsSorted[i - 1].getTime()) / 1000, 1800);
    activeMin.push(act / 60);

    let prevKind: Kind | null = null, seenPrompt = false;
    for (const [ts, kind, text] of events) {
      if (kind === "prompt") {
        promptWords.push(nwords(text));
        hours[ts.getHours()]++;
        if (ts.getDay() === 0 || ts.getDay() === 6) weekend++;
        const flags = {
          polite: POLITE.test(text),
          frustrated: FRUSTRATION.test(text) || caps(text),
          correction: CORRECTION.test(text),
          question: QUESTION.test(text.trim()),
          explore: EXPLORE.test(text),
          verify_ask: VERIFY_ASK.test(text),
        };
        for (const [k, v] of Object.entries(flags)) if (v) m.add(k);
        m.add("prompts");
        prompts.push({
          s: si, open: !seenPrompt, text,
          reaction: prevKind === "interrupt" || prevKind === "rejection" || flags.correction || flags.frustrated,
        });
        seenPrompt = true;
      } else if (kind === "interrupt") m.add("interrupts");
      else if (kind === "rejection") m.add("rejections");
      else if (kind === "command") slash.add(text);
      prevKind = kind;
    }

    const firstEdit = tools.find(([, n]) => EDIT_TOOLS.has(n))?.[0];
    let tests = 0, planned = false;
    for (const [, name, inp] of tools) {
      toolCounts.add(name);
      const fp = inp.file_path || inp.notebook_path || "";
      if (typeof fp === "string" && fp && (EDIT_TOOLS.has(name) || name === "Read")) {
        const ext = suffix(fp);
        if (ext.length > 1 && ext.length <= 8) exts.add(ext);
      }
      if (name === "Bash") {
        const cmd = String(inp.command ?? "");
        if (TEST_CMD.test(cmd)) { tests++; m.add("test_runs"); }
        if (LINT_CMD.test(cmd)) m.add("lint_runs");
        for (const h of commandHeads(cmd)) cmds.add(h);
      }
      if (name === "ExitPlanMode") planned = true;
    }
    if (planned) planSessions++;
    if (firstEdit) {
      editSessions++;
      wordsBeforeEdit.push(sum(sp.filter(([ts]) => ts <= firstEdit).map(([, , t]) => nwords(t))));
      testsPerEditSession.push(tests);
    }
    if (sp.length) toolsPerPrompt.push(tools.length / sp.length);
  }

  const P = Math.max(c("prompts"), 1), S = Math.max(c("sessions"), 1);
  const tc = (set: Set<string>) => sum([...set].map((t) => toolCounts.get(t) || 0));
  const edits = tc(EDIT_TOOLS), reads = tc(READ_TOOLS), web = tc(WEB_TOOLS);
  const night = [22, 23, 0, 1, 2, 3, 4].reduce((a, h) => a + hours[h], 0);
  const r1 = (x: number) => Math.round(x * 10) / 10, r2 = (x: number) => Math.round(x * 100) / 100;

  const metrics = {
    prompt_words_median: median(promptWords),
    prompt_words_p90: pct(promptWords, 0.9),
    words_before_first_edit_median: median(wordsBeforeEdit),
    plan_mode_session_share: r3(ratio(planSessions, S)),
    edit_session_share: r3(ratio(editSessions, S)),
    tool_calls_per_prompt_median: r2(median(toolsPerPrompt)),
    subagent_calls: (toolCounts.get("Task") || 0) + (toolCounts.get("Agent") || 0),
    todo_list_calls: toolCounts.get("TodoWrite") || 0,
    test_runs_per_edit_session: r2(mean(testsPerEditSession)),
    lint_or_typecheck_runs: c("lint_runs"),
    read_to_edit_ratio: r2(ratio(reads, edits)),
    web_lookups: web,
    interrupts_per_100_prompts: r1((100 * c("interrupts")) / P),
    rejections_per_100_prompts: r1((100 * c("rejections")) / P),
    correction_prompt_share: r3(c("correction") / P),
    polite_prompt_share: r3(c("polite") / P),
    frustrated_prompt_share: r3(c("frustrated") / P),
    question_prompt_share: r3(c("question") / P),
    explore_prompt_share: r3(c("explore") / P),
    verify_ask_share: r3(c("verify_ask") / P),
  };

  // 0..1 heuristic dimensions for matching: relative tendencies, not quality scores.
  const dimensions = {
    planning: r3(0.7 * squash(median(wordsBeforeEdit), 120) + 0.3 * Math.min(1, 3 * ratio(planSessions, S))),
    delegation_size: squash(median(toolsPerPrompt), 12),
    verification: r3(0.6 * Math.min(1, mean(testsPerEditSession) / 3) + 0.4 * Math.min(1, (4 * c("verify_ask")) / P)),
    steering: squash((c("interrupts") + c("rejections") + c("correction")) / P, 0.25),
    exploration: r3(0.5 * squash(ratio(reads + web, edits + 1), 3) + 0.5 * Math.min(1, (5 * c("explore")) / P)),
    verbosity: squash(median(promptWords), 50),
    curiosity: squash(c("question") / P, 0.4),
    warmth: squash(c("polite") / P, 0.25),
    frustration: squash(c("frustrated") / P, 0.1),
    night_owl: r3(night / P),
  };

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    analysis: {
      coverage: {
        sessions: c("sessions"),
        projects: projects.size,
        human_prompts: c("prompts"),
        active_hours: r1(sum(activeMin) / 60),
        first_activity: day(first),
        last_activity: day(last),
      },
      dimensions,
      metrics,
      stack: {
        file_types: exts.top(12),
        shell_commands: cmds.top(15, 3),
        tools: toolCounts.top(15),
        slash_commands: slash.top(10),
        models: models.top(5),
      },
      rhythm: {
        prompts_by_local_hour: hours,
        weekend_share: r3(weekend / P),
        session_active_minutes_median: r1(median(activeMin)),
      },
    },
    prompts,
  };
}

// ---------------------------------------------------------------- samples
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSamples(prompts: PromptRec[], n: number, redact: (t: string) => [string, number]) {
  const rand = mulberry32(42);
  type Cand = PromptRec & { red: string; hits: number };
  const cands: Cand[] = [];
  for (const p of prompts) {
    let [red, hits] = redact(p.text);
    const wc = nwords(red);
    if (wc < 3 || (red.match(/\[/g) || []).length > wc / 3) continue;
    if (red.length > 600) red = red.slice(0, 600).replace(/\s+\S*$/, "") + " …";
    cands.push({ ...p, red, hits });
  }
  const buckets: Record<string, Cand[]> = {
    opener: cands.filter((x) => x.open),
    reaction: cands.filter((x) => x.reaction && !x.open),
    mid: cands.filter((x) => !x.open && !x.reaction),
  };
  const quota: Record<string, number> = { opener: Math.floor(n / 3), reaction: Math.floor(n / 3) };
  quota.mid = n - quota.opener - quota.reaction;
  const chosen: [string, Cand][] = [];
  const used = new Set<Cand>();

  const take = (pool: Cand[], k: number, label: string) => {
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const bySession = new Map<number, Cand[]>();
    for (const x of arr) (bySession.get(x.s) || bySession.set(x.s, []).get(x.s)!).push(x);
    let got = 0;
    while (got < k && [...bySession.values()].some((v) => v.length)) {
      for (const list of bySession.values()) {
        if (got >= k) break;
        const x = list.pop();
        if (x && !used.has(x)) { used.add(x); chosen.push([label, x]); got++; }
      }
    }
  };
  for (const label of ["opener", "reaction", "mid"]) take(buckets[label], quota[label], label);
  if (chosen.length < n) take(cands.filter((x) => !used.has(x)), n - chosen.length, "extra");

  chosen.sort((a, b) => a[1].s - b[1].s || Number(a[0] !== "opener") - Number(b[0] !== "opener"));
  return {
    samples: chosen.map(([kind, x]) => ({ kind, session: x.s, text: x.red })),
    hits: sum(chosen.map(([, x]) => x.hits)),
  };
}

// ---------------------------------------------------------------- entry
export interface FingerprintOptions {
  path: string;
  days: number;
  samples: number;
  noSamples: boolean;
  redactTerms: string;
}

export async function buildFingerprint(o: FingerprintOptions) {
  const cutoff = new Date(Date.now() - o.days * 86400_000);
  const { sessions, projects, models, readStats } = await collect(o.path, cutoff);
  const { analysis, prompts } = analyze(sessions, projects, models);
  const profile: any = {
    schema: SCHEMA,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    window_days: o.days,
    source: "claude-code",
    ...analysis,
    method: "heuristic-v1: dimensions are 0-1 relative tendencies from regex + tool-usage counts",
  };
  let hits = 0;
  if (!o.noSamples) {
    const r = pickSamples(prompts, o.samples, makeRedactor(o.redactTerms.split(",")));
    profile.samples = r.samples;
    hits = r.hits;
  }
  const terms = o.redactTerms.split(",").filter((t) => t.trim());
  profile.privacy = {
    raw_code_included: false,
    assistant_text_included: false,
    tool_output_included: false,
    project_paths_included: false,
    prompt_samples: profile.samples?.length ?? 0,
    redactions_in_samples: hits,
    custom_terms_scrubbed: terms.length,
    ...readStats,
  };
  return profile;
}

export function previewText(profile: any): string {
  const win = process.platform === "win32";
  const bar = (x: number) => {
    const full = Math.round(x * 10);
    return (win ? "#" : "█").repeat(full) + (win ? "." : "░").repeat(10 - full);
  };
  const c = profile.coverage;
  const lines = [
    "",
    `Builder fingerprint - last ${profile.window_days} days`,
    `  ${c.sessions} sessions · ${c.projects} projects · ${c.human_prompts} prompts · ${c.active_hours} active hours`,
    "",
    ...Object.entries(profile.dimensions as Record<string, number>).map(([k, v]) => `  ${k.padEnd(16)} ${bar(v)}  ${v.toFixed(2)}`),
  ];
  const st = profile.stack;
  if (Object.keys(st.file_types).length) lines.push("", "  file types : " + Object.keys(st.file_types).join(" "));
  if (Object.keys(st.shell_commands).length) lines.push("  commands   : " + Object.keys(st.shell_commands).join(" "));
  if (Object.keys(st.models).length) lines.push("  models     : " + Object.keys(st.models).join(" "));
  const samples = profile.samples || [];
  if (samples.length) {
    lines.push("", `Samples (${samples.length}) - the ONLY prompt text kept. None of it is uploaded by publish:`, "");
    for (const s of samples) {
      const t = s.text.replace(/\n/g, " ");
      lines.push(`  [${s.kind.padEnd(8)}] ${t.slice(0, 220)}${t.length > 220 ? "…" : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}
