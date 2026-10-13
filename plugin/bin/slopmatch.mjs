// slopmatch CLI, bundled from cli/src in https://github.com/asyrique/slopmatch. Needs Node 18+.
// @bun

// src/cli.ts
import { parseArgs } from "util";
import { chmodSync, existsSync, mkdirSync, readdirSync as readdirSync2, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join as join2, resolve, relative, sep } from "path";

// src/fingerprint.ts
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

// src/redact.ts
var longNumber = (m) => (m.match(/\d/g) || []).length >= 9 ? "[number]" : m;
var REDACTIONS = [
  [/```[\s\S]*?(```|$)/g, "[code block]"],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, "[key]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[secret]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[secret]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[secret]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[secret]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[secret]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[secret]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)\S+/gi, "$1$2[secret]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S*/g, "[url]"],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "[email]"],
  [/\bhttps?:\/\/[^\s)>\]"']+/g, "[url]"],
  [/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]"],
  [/\b[A-Za-z]:\\[^\s]+/g, "[path]"],
  [/(~|\.{1,2})?(\/[\w.@+-]+){2,}\/?/g, "[path]"],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[blob]"],
  [/`[^`\n]{40,}`/g, "[code]"],
  [/\+?\d[\d\s().-]{7,}\d/g, longNumber]
];
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function makeRedactor(customTerms) {
  const custom = customTerms.map((t) => t.trim()).filter(Boolean).map((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "gi"));
  return (input) => {
    let text = input;
    let hits = 0;
    for (const [re, repl] of REDACTIONS) {
      text = text.replace(re, (...args) => {
        hits++;
        const match = args[0];
        if (typeof repl === "function")
          return repl(match);
        return repl.replace(/\$(\d)/g, (_, i) => typeof args[+i] === "string" ? args[+i] : "");
      });
    }
    for (const re of custom) {
      text = text.replace(re, () => {
        hits++;
        return "[redacted]";
      });
    }
    return [text.replace(/[ \t]+/g, " ").trim(), hits];
  };
}

// src/fingerprint.ts
var SCHEMA = "builder-fingerprint/1";
var EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
var WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
var TEST_CMD = /\b(pytest|py\.test|unittest|(npm|pnpm|yarn|bun)( run)? test|vitest|jest|go test|cargo test|mix test|rspec|phpunit|dotnet test|make test|tox|nox|playwright test|cypress run|swift test|xcodebuild test)\b/;
var LINT_CMD = /\b(tsc|mypy|pyright|ruff|eslint|biome|clippy|golangci-lint|flake8|pylint|cargo check|go vet|swiftlint)\b/;
var INTERRUPT = /^\[Request interrupted by user/;
var CORRECTION = /^\s*(no\b|nope\b|wrong\b|that'?s (not|wrong)|not what i|undo\b|revert\b|stop\b|wait\b|actually\b|don'?t\b|why did you|you (broke|deleted|removed|forgot|missed)|still (not|broken|failing|doesn'?t|the same))/i;
var POLITE = /\b(please|pls|plz|thanks|thank you|thx|ty|cheers|appreciate|great job|nice work|well done|awesome|perfect)\b/i;
var FRUSTRATION = /(\bwtf\b|\bffs\b|\bugh+\b|\bargh+\b|\bdamn+\b|\bfuck|\bshit\b|\bcrap\b|\bseriously\b|!!+|\?\?+)/i;
var QUESTION = /\?\s*$|^(how|what|why|which|should|can|could|would|is|are|does|do)\b/i;
var EXPLORE = /\b(alternatives?|options|trade-?offs?|compare|what if|explore|brainstorm|ideas?|other ways?|pros and cons|approaches)\b/i;
var VERIFY_ASK = /\b(tests?|verify|double[- ]check|check that|make sure|validate|confirm|run it|does it work)\b/i;
var SYS_TAG = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
var CMD_NAME = /<command-name>\s*\/?([\w:.-]+)\s*<\/command-name>/;
var IMAGE_PH = /\[Image #\d+\]/g;
var NOISE_PREFIXES = [
  "<local-command-",
  "<command-message>",
  "<command-args>",
  "Caveat: The messages below",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "[Image: original ",
  "This session is being continued from a previous conversation"
];
var CMD_TOKEN = /^[a-z][a-z0-9._-]{1,24}$/;
var CMD_WRAPPERS = new Set(["sudo", "time", "env", "npx", "bunx", "uvx", "pnpx", "nohup", "exec"]);
var r3 = (x) => Math.round(x * 1000) / 1000;
var nwords = (t) => t.split(/\s+/).filter(Boolean).length;
var squash = (x, k) => r3(1 - Math.exp(-Math.max(x, 0) / k));
var ratio = (a, b) => b ? a / b : 0;
var sum = (xs) => xs.reduce((a, b) => a + b, 0);
var mean = (xs) => xs.length ? sum(xs) / xs.length : 0;
function median(xs) {
  if (!xs.length)
    return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs, p) {
  if (!xs.length)
    return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
}
function caps(text) {
  const ws = text.match(/[A-Za-z]{4,}/g) || [];
  const up = ws.filter((w) => w === w.toUpperCase());
  return up.length >= 3 && up.length / Math.max(ws.length, 1) >= 0.3;
}
function commandHeads(cmd) {
  const out = [];
  for (const part of cmd.split(/&&|\|\||;|\||\n/)) {
    let toks = part.trim().split(/\s+/).filter(Boolean);
    while (toks.length && (/^[A-Z_][A-Z0-9_]*=/.test(toks[0]) || CMD_WRAPPERS.has(toks[0])))
      toks = toks.slice(1);
    if (toks.length && toks[0] !== "cd" && CMD_TOKEN.test(toks[0]))
      out.push(toks[0]);
  }
  return out;
}
function suffix(p) {
  const base = p.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}
function parseTs(s) {
  if (typeof s !== "string" || !s)
    return null;
  const withTz = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s + "Z";
  const d = new Date(withTz);
  return isNaN(d.getTime()) ? null : d;
}

class Counter extends Map {
  add(k, n = 1) {
    this.set(k, (this.get(k) || 0) + n);
  }
  top(n, min = 1) {
    return Object.fromEntries([...this.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).filter(([, v]) => v >= min));
  }
}
function classifyUser(entry) {
  const content = entry?.message?.content;
  const texts = [];
  let rejected = false;
  if (typeof content === "string")
    texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object")
        continue;
      if (b.type === "text")
        texts.push(b.text || "");
      else if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : b.content ? JSON.stringify(b.content).slice(0, 800) : "";
        if (c.includes("doesn't want to proceed") || c.toLowerCase().includes("user rejected"))
          rejected = true;
      }
    }
  }
  const events = rejected ? [["rejection", ""]] : [];
  const text = texts.join(`
`).replace(SYS_TAG, "").trim();
  if (!text)
    return events;
  if (INTERRUPT.test(text))
    return [...events, ["interrupt", ""]];
  const m = text.match(CMD_NAME);
  if (m)
    return [...events, ["command", m[1].replace(/^\/+/, "")]];
  if (NOISE_PREFIXES.some((p) => text.startsWith(p)) || entry.isCompactSummary)
    return events;
  return [...events, ["prompt", text.replace(IMAGE_PH, "[image]")]];
}
function* walkJsonl(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory())
      yield* walkJsonl(p);
    else if (e.isFile() && e.name.endsWith(".jsonl"))
      yield p;
  }
}
async function collect(root, cutoff) {
  const sessions = new Map;
  const projects = new Set;
  const models = new Counter;
  let filesRead = 0, badLines = 0;
  for (const f of walkJsonl(root)) {
    try {
      if (statSync(f).mtime < cutoff)
        continue;
    } catch {
      continue;
    }
    filesRead++;
    const stem = (f.split(/[\\/]/).pop() || "").replace(/\.jsonl$/, "");
    const rl = createInterface({ input: createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line)
        continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        badLines++;
        continue;
      }
      if (!e || typeof e !== "object" || Array.isArray(e) || e.isSidechain)
        continue;
      if (e.type !== "user" && e.type !== "assistant")
        continue;
      const ts = parseTs(e.timestamp);
      if (!ts || ts < cutoff)
        continue;
      const sid = e.sessionId || stem;
      let s = sessions.get(sid);
      if (!s)
        sessions.set(sid, s = { events: [], tools: [], ts: [] });
      s.ts.push(ts);
      if (e.cwd)
        projects.add(e.cwd);
      if (e.type === "user") {
        for (const [k, t] of classifyUser(e))
          s.events.push([ts, k, t]);
      } else {
        const msg = e.message || {};
        if (typeof msg.model === "string" && msg.model && !msg.model.startsWith("<"))
          models.add(msg.model);
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
function analyze(sessions, projects, models) {
  const m = new Counter;
  const prompts = [];
  const promptWords = [], activeMin = [];
  const wordsBeforeEdit = [], toolsPerPrompt = [], testsPerEditSession = [];
  const hours = new Array(24).fill(0);
  let weekend = 0, planSessions = 0, editSessions = 0;
  const toolCounts = new Counter, exts = new Counter, cmds = new Counter, slash = new Counter;
  let first = null, last = null;
  const c = (k) => m.get(k) || 0;
  const minTs = (s) => s.ts.length ? Math.min(...s.ts.map((d) => d.getTime())) : Infinity;
  const ordered = [...sessions.values()].sort((a, b) => minTs(a) - minTs(b));
  let si = -1;
  for (const s of ordered) {
    const events = [...s.events].sort((a, b) => a[0].getTime() - b[0].getTime());
    const tools = [...s.tools].sort((a, b) => a[0].getTime() - b[0].getTime());
    const sp = events.filter((e) => e[1] === "prompt");
    if (!sp.length && !tools.length)
      continue;
    si++;
    m.add("sessions");
    const tsSorted = [...s.ts].sort((a, b) => a.getTime() - b.getTime());
    if (!first || tsSorted[0] < first)
      first = tsSorted[0];
    if (!last || tsSorted[tsSorted.length - 1] > last)
      last = tsSorted[tsSorted.length - 1];
    let act = 0;
    for (let i = 1;i < tsSorted.length; i++)
      act += Math.min((tsSorted[i].getTime() - tsSorted[i - 1].getTime()) / 1000, 1800);
    activeMin.push(act / 60);
    let prevKind = null, seenPrompt = false;
    for (const [ts, kind, text] of events) {
      if (kind === "prompt") {
        promptWords.push(nwords(text));
        hours[ts.getHours()]++;
        if (ts.getDay() === 0 || ts.getDay() === 6)
          weekend++;
        const flags = {
          polite: POLITE.test(text),
          frustrated: FRUSTRATION.test(text) || caps(text),
          correction: CORRECTION.test(text),
          question: QUESTION.test(text.trim()),
          explore: EXPLORE.test(text),
          verify_ask: VERIFY_ASK.test(text)
        };
        for (const [k, v] of Object.entries(flags))
          if (v)
            m.add(k);
        m.add("prompts");
        prompts.push({
          s: si,
          open: !seenPrompt,
          text,
          reaction: prevKind === "interrupt" || prevKind === "rejection" || flags.correction || flags.frustrated
        });
        seenPrompt = true;
      } else if (kind === "interrupt")
        m.add("interrupts");
      else if (kind === "rejection")
        m.add("rejections");
      else if (kind === "command")
        slash.add(text);
      prevKind = kind;
    }
    const firstEdit = tools.find(([, n]) => EDIT_TOOLS.has(n))?.[0];
    let tests = 0, planned = false;
    for (const [, name, inp] of tools) {
      toolCounts.add(name);
      const fp = inp.file_path || inp.notebook_path || "";
      if (typeof fp === "string" && fp && (EDIT_TOOLS.has(name) || name === "Read")) {
        const ext = suffix(fp);
        if (ext.length > 1 && ext.length <= 8)
          exts.add(ext);
      }
      if (name === "Bash") {
        const cmd = String(inp.command ?? "");
        if (TEST_CMD.test(cmd)) {
          tests++;
          m.add("test_runs");
        }
        if (LINT_CMD.test(cmd))
          m.add("lint_runs");
        for (const h of commandHeads(cmd))
          cmds.add(h);
      }
      if (name === "ExitPlanMode")
        planned = true;
    }
    if (planned)
      planSessions++;
    if (firstEdit) {
      editSessions++;
      wordsBeforeEdit.push(sum(sp.filter(([ts]) => ts <= firstEdit).map(([, , t]) => nwords(t))));
      testsPerEditSession.push(tests);
    }
    if (sp.length)
      toolsPerPrompt.push(tools.length / sp.length);
  }
  const P = Math.max(c("prompts"), 1), S = Math.max(c("sessions"), 1);
  const tc = (set) => sum([...set].map((t) => toolCounts.get(t) || 0));
  const edits = tc(EDIT_TOOLS), reads = tc(READ_TOOLS), web = tc(WEB_TOOLS);
  const night = [22, 23, 0, 1, 2, 3, 4].reduce((a, h) => a + hours[h], 0);
  const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
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
    interrupts_per_100_prompts: r1(100 * c("interrupts") / P),
    rejections_per_100_prompts: r1(100 * c("rejections") / P),
    correction_prompt_share: r3(c("correction") / P),
    polite_prompt_share: r3(c("polite") / P),
    frustrated_prompt_share: r3(c("frustrated") / P),
    question_prompt_share: r3(c("question") / P),
    explore_prompt_share: r3(c("explore") / P),
    verify_ask_share: r3(c("verify_ask") / P)
  };
  const dimensions = {
    planning: r3(0.7 * squash(median(wordsBeforeEdit), 120) + 0.3 * Math.min(1, 3 * ratio(planSessions, S))),
    delegation_size: squash(median(toolsPerPrompt), 12),
    verification: r3(0.6 * Math.min(1, mean(testsPerEditSession) / 3) + 0.4 * Math.min(1, 4 * c("verify_ask") / P)),
    steering: squash((c("interrupts") + c("rejections") + c("correction")) / P, 0.25),
    exploration: r3(0.5 * squash(ratio(reads + web, edits + 1), 3) + 0.5 * Math.min(1, 5 * c("explore") / P)),
    verbosity: squash(median(promptWords), 50),
    curiosity: squash(c("question") / P, 0.4),
    warmth: squash(c("polite") / P, 0.25),
    frustration: squash(c("frustrated") / P, 0.1),
    night_owl: r3(night / P)
  };
  const day = (d) => d ? d.toISOString().slice(0, 10) : null;
  return {
    analysis: {
      coverage: {
        sessions: c("sessions"),
        projects: projects.size,
        human_prompts: c("prompts"),
        active_hours: r1(sum(activeMin) / 60),
        first_activity: day(first),
        last_activity: day(last)
      },
      dimensions,
      metrics,
      stack: {
        file_types: exts.top(12),
        shell_commands: cmds.top(15, 3),
        tools: toolCounts.top(15),
        slash_commands: slash.top(10),
        models: models.top(5)
      },
      rhythm: {
        prompts_by_local_hour: hours,
        weekend_share: r3(weekend / P),
        session_active_minutes_median: r1(median(activeMin))
      }
    },
    prompts
  };
}
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = seed + 1831565813 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pickSamples(prompts, n, redact) {
  const rand = mulberry32(42);
  const cands = [];
  for (const p of prompts) {
    let [red, hits] = redact(p.text);
    const wc = nwords(red);
    if (wc < 3 || (red.match(/\[/g) || []).length > wc / 3)
      continue;
    if (red.length > 600)
      red = red.slice(0, 600).replace(/\s+\S*$/, "") + " …";
    cands.push({ ...p, red, hits });
  }
  const buckets = {
    opener: cands.filter((x) => x.open),
    reaction: cands.filter((x) => x.reaction && !x.open),
    mid: cands.filter((x) => !x.open && !x.reaction)
  };
  const quota = { opener: Math.floor(n / 3), reaction: Math.floor(n / 3) };
  quota.mid = n - quota.opener - quota.reaction;
  const chosen = [];
  const used = new Set;
  const take = (pool, k, label) => {
    const arr = [...pool];
    for (let i = arr.length - 1;i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const bySession = new Map;
    for (const x of arr)
      (bySession.get(x.s) || bySession.set(x.s, []).get(x.s)).push(x);
    let got = 0;
    while (got < k && [...bySession.values()].some((v) => v.length)) {
      for (const list of bySession.values()) {
        if (got >= k)
          break;
        const x = list.pop();
        if (x && !used.has(x)) {
          used.add(x);
          chosen.push([label, x]);
          got++;
        }
      }
    }
  };
  for (const label of ["opener", "reaction", "mid"])
    take(buckets[label], quota[label], label);
  if (chosen.length < n)
    take(cands.filter((x) => !used.has(x)), n - chosen.length, "extra");
  chosen.sort((a, b) => a[1].s - b[1].s || Number(a[0] !== "opener") - Number(b[0] !== "opener"));
  return {
    samples: chosen.map(([kind, x]) => ({ kind, session: x.s, text: x.red })),
    hits: sum(chosen.map(([, x]) => x.hits))
  };
}
async function buildFingerprint(o) {
  const cutoff = new Date(Date.now() - o.days * 86400000);
  const { sessions, projects, models, readStats } = await collect(o.path, cutoff);
  const { analysis, prompts } = analyze(sessions, projects, models);
  const profile = {
    schema: SCHEMA,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    window_days: o.days,
    source: "claude-code",
    ...analysis,
    method: "heuristic-v1: dimensions are 0-1 relative tendencies from regex + tool-usage counts"
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
    ...readStats
  };
  return profile;
}
function previewText(profile) {
  const win = process.platform === "win32";
  const bar = (x) => {
    const full = Math.round(x * 10);
    return (win ? "#" : "█").repeat(full) + (win ? "." : "░").repeat(10 - full);
  };
  const c = profile.coverage;
  const lines = [
    "",
    `Builder fingerprint - last ${profile.window_days} days`,
    `  ${c.sessions} sessions · ${c.projects} projects · ${c.human_prompts} prompts · ${c.active_hours} active hours`,
    "",
    ...Object.entries(profile.dimensions).map(([k, v]) => `  ${k.padEnd(16)} ${bar(v)}  ${v.toFixed(2)}`)
  ];
  const st = profile.stack;
  if (Object.keys(st.file_types).length)
    lines.push("", "  file types : " + Object.keys(st.file_types).join(" "));
  if (Object.keys(st.shell_commands).length)
    lines.push("  commands   : " + Object.keys(st.shell_commands).join(" "));
  if (Object.keys(st.models).length)
    lines.push("  models     : " + Object.keys(st.models).join(" "));
  const samples = profile.samples || [];
  if (samples.length) {
    lines.push("", `Samples (${samples.length}) - the ONLY prompt text kept. None of it is uploaded by publish:`, "");
    for (const s of samples) {
      const t = s.text.replace(/\n/g, " ");
      lines.push(`  [${s.kind.padEnd(8)}] ${t.slice(0, 220)}${t.length > 220 ? "…" : ""}`);
    }
  }
  return lines.join(`
`) + `
`;
}

// src/cli.ts
var VERSION = "0.4.0";
var DEFAULT_URL = "https://slopmatch.lol";
var DEFAULT_ROOM = "world";
var DIMS = [
  "planning",
  "delegation_size",
  "verification",
  "steering",
  "exploration",
  "verbosity",
  "curiosity",
  "warmth",
  "frustration",
  "night_owl"
];
var HELP = `slopmatch ${VERSION} - find people who build the way you do

Local (nothing leaves your machine):
  slopmatch extract [--days 90] [--path DIR] [--redact-terms "Acme,Jane"] [--no-samples] [--quiet]
  slopmatch skills

Server (default https://slopmatch.lol, room "world": everyone, worldwide):
  slopmatch config [--url URL] [--room ROOM]
  slopmatch publish [--card FILE] [--yes]        dry run unless --yes
  slopmatch matches [--mode similar|complement] [--limit 3]
  slopmatch reveal <handle> --contact "telegram @me"
  slopmatch status
  slopmatch profile                              your profile + private link to it on the web
  slopmatch delete --yes

Global: --url, --room override config. Env: SLOPMATCH_URL, SLOPMATCH_ROOM, SLOPMATCH_HOME.`;
var expandHome = (p) => p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join2(homedir(), p.slice(1)) : p;
var HOME = resolve(expandHome(process.env.SLOPMATCH_HOME || "~/.slopmatch"));
var CONFIG = join2(HOME, "config.json");
var FINGERPRINT = join2(HOME, "fingerprint.json");
var DEFAULT_TRANSCRIPTS = join2(resolve(expandHome(process.env.CLAUDE_CONFIG_DIR || "~/.claude")), "projects");
var SKILL_DIRS = [
  "~/.claude/skills",
  "~/.claude/plugins",
  "~/.codex/skills",
  "~/.agents/skills",
  "~/.config/opencode/skills",
  "./.claude/skills",
  "./.agents/skills"
];
function die(msg) {
  process.stderr.write(msg + `
`);
  process.exit(1);
}
var out = (x) => process.stdout.write((typeof x === "string" ? x : JSON.stringify(x, null, 2)) + `
`);
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
var loadConfig = () => readJson(CONFIG) || {};
function saveConfig(cfg) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  try {
    chmodSync(CONFIG, 384);
  } catch {}
}
var { values: v, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        url: { type: "string" },
        room: { type: "string" },
        days: { type: "string" },
        path: { type: "string" },
        samples: { type: "string" },
        "no-samples": { type: "boolean" },
        "redact-terms": { type: "string" },
        out: { type: "string" },
        quiet: { type: "boolean" },
        card: { type: "string" },
        yes: { type: "boolean" },
        mode: { type: "string" },
        limit: { type: "string" },
        contact: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" }
      }
    });
  } catch (e) {
    die(`${e.message}

${HELP}`);
  }
})();
function target() {
  const cfg = loadConfig();
  const url = (v.url || process.env.SLOPMATCH_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, "");
  const room = v.room || process.env.SLOPMATCH_ROOM || cfg.room || DEFAULT_ROOM;
  return { cfg, url, room, key: `${url}|${room}` };
}
function identity() {
  const t = target();
  const ident = t.cfg.identities?.[t.key];
  if (!ident)
    die("You haven't published a profile in this room yet. Run: slopmatch publish");
  return { ...t, ident };
}

class StaleKey extends Error {
}
async function call(method, url, path, body, token) {
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        "user-agent": `slopmatch/${VERSION}`,
        ...token ? { authorization: `Bearer ${token}` } : {}
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    die(`Could not reach ${url}: ${e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token)
    throw new StaleKey(data.error || "unknown or missing token");
  if (!res.ok)
    die(`Server returned ${res.status}: ${data.error || res.statusText}`);
  return data;
}
var clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
var num01 = (x, dflt = 0.5) => {
  const n = Number(x ?? dflt);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
};
async function cmdExtract() {
  const days = Number(v.days || 90);
  if (!Number.isFinite(days) || days <= 0)
    die("--days must be a positive number");
  const path = resolve(expandHome(v.path || DEFAULT_TRANSCRIPTS));
  if (!existsSync(path))
    die(`No transcripts found at ${path}. Use --path to point at your Claude Code projects folder.`);
  const profile = await buildFingerprint({
    path,
    days,
    samples: Number(v.samples || 30),
    noSamples: !!v["no-samples"],
    redactTerms: v["redact-terms"] || ""
  });
  if (profile.coverage.sessions === 0)
    die(`No sessions in the last ${days} days under ${path}. Try --days 365.`);
  const dest = resolve(expandHome(v.out || FINGERPRINT));
  mkdirSync(resolve(dest, ".."), { recursive: true });
  writeFileSync(dest, JSON.stringify(profile, null, 2), "utf8");
  if (!v.quiet)
    out(previewText(profile));
  out(`Wrote ${dest}. Review the samples; they stay on this machine.`);
}
function* walkSkills(dir, depth = 0) {
  if (depth > 8)
    return;
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join2(dir, e.name);
    if (e.isDirectory())
      yield* walkSkills(p, depth + 1);
    else if (e.isFile() && e.name === "SKILL.md")
      yield p;
  }
}
function fmField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  if (!m)
    return "";
  let val = m[1].trim();
  if (["|", ">", "|-", ">-"].includes(val)) {
    const rest = fm.slice((m.index || 0) + m[0].length).split(/\r?\n/).slice(1);
    const block = [];
    for (const l of rest) {
      if (/^[ \t]/.test(l))
        block.push(l.trim());
      else if (l.trim())
        break;
    }
    val = block.join(" ").slice(0, 400);
  }
  return val.replace(/^["']|["']$/g, "");
}
function cmdSkills() {
  const seen = new Set;
  const skills = [];
  for (const d of SKILL_DIRS) {
    const root = resolve(expandHome(d));
    for (const p of walkSkills(root)) {
      if (skills.length >= 200)
        break;
      let text = "";
      try {
        text = readFileSync(p, "utf8").slice(0, 4000);
      } catch {
        continue;
      }
      const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
      const name = fmField(fm, "name") || relative(root, p).split(sep).slice(-2, -1)[0] || "unknown";
      if (seen.has(name))
        continue;
      seen.add(name);
      skills.push({ name, description: fmField(fm, "description").slice(0, 400), source: d });
    }
  }
  out({ note: "LOCAL ONLY. Derive coarse topic tags; never upload these names or descriptions.", skills });
}
function cmdConfig() {
  const cfg = loadConfig();
  if (v.url)
    cfg.url = v.url.replace(/\/+$/, "");
  if (v.room)
    cfg.room = v.room;
  saveConfig(cfg);
  out({ url: cfg.url ?? DEFAULT_URL, room: cfg.room ?? null, config: CONFIG });
}
function buildPayload(card, fp, room) {
  const dims = fp.dimensions || {};
  const big5 = card.big5 || {};
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    room,
    dims: Object.fromEntries(DIMS.map((k) => [k, r(num01(dims[k]), 3)])),
    card: {
      headline: clip(card.headline, 90),
      style: clip(card.style, 400),
      big5: Object.fromEntries("OCEAN".split("").map((k) => [k, r(num01(big5[k]), 2)])),
      topics: (Array.isArray(card.topics) ? card.topics : []).map((t) => clip(t, 30).toLowerCase()).filter(Boolean).slice(0, 8),
      file_types: Object.keys(fp.stack?.file_types || {}).slice(0, 6),
      looking_for: clip(card.looking_for || "just curious", 40),
      mode: card.mode === "complement" ? "complement" : "similar"
    }
  };
}
async function cmdPublish() {
  const t = target();
  const fp = readJson(FINGERPRINT);
  if (!fp)
    die("No fingerprint yet. Run: slopmatch extract");
  const cardPath = resolve(expandHome(v.card || join2(HOME, "card.json")));
  const card = readJson(cardPath);
  if (!card)
    die(`Could not read card JSON at ${cardPath}`);
  const payload = buildPayload(card, fp, t.room);
  if (!v.yes) {
    out(`DRY RUN. This is exactly what would be sent to ${t.url}
`);
    out(payload);
    out(`
Show this to the user. Re-run with --yes only after they approve.`);
    return;
  }
  const ident = t.cfg.identities?.[t.key];
  let res;
  try {
    res = await call("POST", t.url, "/api/profiles", payload, ident?.token);
  } catch (e) {
    if (!(e instanceof StaleKey))
      throw e;
    res = await call("POST", t.url, "/api/profiles", payload);
  }
  if (res.token) {
    t.cfg.identities = { ...t.cfg.identities || {}, [t.key]: { handle: res.handle, token: res.token } };
    saveConfig(t.cfg);
  }
  out({ handle: res.handle, room: t.room, updated: !!res.updated });
}
async function cmdMatches() {
  const { url, ident } = identity();
  const limit = Number(v.limit || 3);
  if (v.mode && !["similar", "complement"].includes(v.mode))
    die("--mode must be similar or complement");
  out(await call("GET", url, `/api/matches?limit=${limit}${v.mode ? `&mode=${v.mode}` : ""}`, undefined, ident.token));
}
async function cmdReveal() {
  const { url, ident } = identity();
  const handle = positionals[1];
  if (!handle)
    die('Usage: slopmatch reveal <handle> --contact "telegram @me"');
  if (!v.contact)
    die("--contact is required");
  out(await call("POST", url, "/api/reveals", { handle, contact: clip(v.contact, 120) }, ident.token));
}
async function cmdStatus() {
  const { url, ident } = identity();
  out(await call("GET", url, "/api/reveals", undefined, ident.token));
}
async function cmdProfile() {
  const { url, ident } = identity();
  const p = await call("GET", url, "/api/profiles", undefined, ident.token);
  out({ ...p, passphrase: ident.token, page: `${url}/me#k=${ident.token}`, note: "The passphrase and link work like a password: anyone with them can manage your profile. Don't share them. On another device, type the passphrase at " + `${url}/me` + "." });
}
async function cmdDelete() {
  const t = identity();
  if (!v.yes)
    die(`This deletes '${t.ident.handle}' and its reveals from ${t.url}. Re-run with --yes.`);
  await call("DELETE", t.url, "/api/profiles", undefined, t.ident.token);
  delete t.cfg.identities[t.key];
  saveConfig(t.cfg);
  out("Deleted.");
}
var commands = {
  extract: cmdExtract,
  skills: cmdSkills,
  config: cmdConfig,
  publish: cmdPublish,
  matches: cmdMatches,
  reveal: cmdReveal,
  status: cmdStatus,
  profile: cmdProfile,
  delete: cmdDelete
};
if (v.version)
  out(VERSION);
else if (v.help || !positionals[0])
  out(HELP);
else {
  const fn = commands[positionals[0]];
  if (!fn)
    die(`Unknown command: ${positionals[0]}

${HELP}`);
  try {
    await fn();
  } catch (e) {
    if (e instanceof StaleKey)
      die("Your saved profile key isn't accepted any more (deleted, or an old-format key). Run: slopmatch publish");
    throw e;
  }
}
