import { expect, test } from "bun:test";
import { hasBadWords } from "../src/clean";

const BLOCKED = [
  "fuck this", "F*CK", "fuuuuck yeah", "f u c k", "f.u.c.k", "motherfucker", "sh1t", "shiiit", "bullshit ideas", "$h!t",
  "what a bitch", "b1tch", "dumbass", "asshole", "@sshole", "a$$hole", "cunt", "C U N T", "cunts", "wanker", "bollocks",
  "piss off", "crappy code", "goddamn", "dickhead", "cocksucker", "slut", "whore", "retarded", "fuking",
  "knn", "ccb", "pukimak", "cheebye", "chibai", "cibai", "kanina", "lancau",
];
const ALLOWED = [
  // names and surnames
  "Dick Smith", "telegram @dick_wong", "Dikshit", "Shittu", "Cockburn", "Hitchcock", "Pissarro", "Slutsky", "Niggli",
  "Phuc Nguyen", "Lan Jiao", "CB Tan", "Bich Ngoc", "Kuntz", "Willy Wonka", "Fanny Price", "Randy", "Butts",
  "Assange", "Cassandra", "Sexton", "Fukuda", "Mike Crapo", "Babi", "Diu Wing", "Sial", "Hoare", "Dong", "Wang",
  // ordinary words and places
  "Scunthorpe", "class", "assistant", "cockpit", "cockatoo", "hello", "hell yeah", "flame retardant", "shiitake",
  "pass the assert", "as soon as", "Fukuoka", "Fukushima", "great tit", "pin prick", "bass", "Essex", "Sussex",
  "dictionary", "kimchi", "Pakistan", "analysis", "therapist", "grape", "document",
  // our own handles and words
  "babirusa", "gremlin-tarsier", "kiasu-sunbear", "kancheong-sunbear", "plans like an architect, ships like a raccoon",
  "ships whatsapp bots at 2am", "telegram @orangutan_ships", "sunbear@2am.dev", "+65 9123 4567", "find me at the snack table",
];

test.each(BLOCKED)("blocks %p", (s) => expect(hasBadWords(s)).toBe(true));
test.each(ALLOWED)("allows %p", (s) => expect(hasBadWords(s)).toBe(false));
