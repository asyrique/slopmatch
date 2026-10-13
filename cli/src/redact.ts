// Redaction for prompt samples. Order matters: code blocks and secrets first, then URLs, paths, blobs.

type Repl = string | ((match: string) => string);

const longNumber = (m: string) => ((m.match(/\d/g) || []).length >= 9 ? "[number]" : m);

const REDACTIONS: [RegExp, Repl][] = [
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
  [/\+?\d[\d\s().-]{7,}\d/g, longNumber],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeRedactor(customTerms: string[]) {
  const custom = customTerms.map((t) => t.trim()).filter(Boolean).map((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "gi"));

  return (input: string): [string, number] => {
    let text = input;
    let hits = 0;
    for (const [re, repl] of REDACTIONS) {
      text = text.replace(re, (...args: any[]) => {
        hits++;
        const match = args[0] as string;
        if (typeof repl === "function") return repl(match);
        return repl.replace(/\$(\d)/g, (_, i) => (typeof args[+i] === "string" ? args[+i] : ""));
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
