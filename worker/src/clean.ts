/**
 * Swear filter for text other people see: card fields and reveal contacts.
 * Shared by the Worker (enforces) and the CLI (warns before sending).
 *
 * Design: catch common disguises (f*ck, sh1t, fuuuck, f u c k) without blocking real names or innocent words.
 * - Roots that never occur inside names are matched as substrings.
 * - Everything else must be the whole word (with listed suffixes), so "Dikshit", "Shittu", "Cockburn",
 *   "Scunthorpe", "Pissarro", "Slutsky", "Niggli", "flame retardant" and "babirusa" all pass.
 * - Words that are also common names or initials (dick, cock, willy, fanny, babi, cb, diu, sial, Lan Jiao)
 *   are deliberately not blocked on their own.
 */

// substring-safe: no real names or ordinary words contain these
const SUBSTR = ["fuck", "motherf", "asshole", "arsehole", "cocksucker", "dickhead", "faggot", "nigger", "nigga", "pukimak", "cheebye", "chibai", "cibai"];

// whole words only (after normalising); stems allow the listed suffixes
const WORDS = [
  /^(bull|horse|dip|chicken|ape)?shit(s|ty|ter|ters|head|heads|hole|holes|show|post|posting|ting|e)?$/,
  /^bitch(es|y|ing|ed)?$/, /^(son)?ofabitch$/, /^bastards?$/, /^cunts?$/, /^twats?$/, /^wank(er|ers|ing)?$/,
  /^(dumb|jack|smart|bad|kick|lazy|fat)?ass(es|hat|hats|wipe)?$/, /^arse(s|wipe)?$/, /^bollocks?$/,
  /^slut(s|ty)?$/, /^whores?$/, /^retard(s|ed)?$/, /^piss(ed|ing|er)?$/, /^crap(py|s)?$/,
  /^(god)?damn(ed|it)?$/, /^dammit$/, /^douche(bag|bags)?$/, /^jizz$/, /^fuk(ing|in|ed|er|ers|s)?$/,
  /^knn$/, /^ccb$/, /^puki$/, /^nabei$/, /^pundek$/, /^sohai$/, /^kanina(bu)?$/, /^lancau$/,
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "|": "i" };
const squeeze = (s: string) => s.replace(/(.)\1+/g, "$1");
const SUBSTR_SQ = SUBSTR.map(squeeze);

function badToken(t: string): boolean {
  if (!t) return false;
  if (SUBSTR.some((r) => t.includes(r)) || WORDS.some((re) => re.test(t))) return true;
  // stretched letters ("fuuuck", "shiiit"): compare with repeats squeezed out, only when the token had repeats
  const sq = squeeze(t);
  if (sq !== t) {
    if (SUBSTR_SQ.some((r) => sq.includes(r))) return true;
    if (WORDS.some((re) => re.test(sq))) return true;
  }
  return false;
}

/** True if the text contains a blocked word. */
export function hasBadWords(text: string): boolean {
  let s = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // spaced-out letters: "f u c k", "s.h.i.t" -> "fuck", "shit"
  s = s.replace(/\b([a-z0-9@$!*])(?:[\s._\-]+([a-z0-9@$!*])\b)+/g, (m) => m.replace(/[\s._\-]+/g, ""));
  // tokens keep leet characters and * so "f*ck" and "sh1t" stay one word
  const raw = s.split(/[^a-z0-9@$!*|+]+/).filter(Boolean);
  for (const r of raw) {
    const leet = (x: string) => x.split("").map((c) => LEET[c] ?? c).join("");
    // "@name" in a contact is a handle, so drop the "@" ...
    const base = leet(r.replace(/^@+/, ""));
    const variants = base.includes("*") ? ["u", "i", "a", "o"].map((v) => base.replace(/\*+/g, v)) : [base];
    for (const v of variants) for (const t of v.split(/[^a-z]+/)) if (badToken(t)) return true;
    // ... but "@sshole" is still a disguise: read the "@" as "a" for the roots that never occur in names
    if (r.startsWith("@")) for (const t of leet(r).split(/[^a-z]+/)) if (SUBSTR.some((x) => t.includes(x))) return true;
  }
  return false;
}
