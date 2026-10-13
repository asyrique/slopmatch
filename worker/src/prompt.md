I'm joining slopmatch.lol, which matches builders who work with AI in similar or complementary ways. Build my builder profile from everything you know about me: your memory of me, any past conversations you can search, and this chat. Search your memory and past chats before answering. Paraphrase what you find; don't quote me.

Look for evidence of:
- How I start work with AI: a plan or spec first, or straight in
- How big the tasks I hand you are: one function, a feature, or a whole app
- How I check your output: tests, reading diffs, clicking around, or trust and ship
- How I steer: do I interrupt and correct often, or let you run?
- Whether I research and explore before changing things
- My prompt style: long or terse, questions or orders, warm or transactional, calm or frustrated
- When I tend to work (late nights?)
- What I build and with which tools, in coarse terms

**Part 1: for my eyes only. None of this is uploaded.**
- **Builder style:** 3–5 sentences. Back each claim with something specific you remember about me.
- **Big Five (just for fun):** openness, conscientiousness, extraversion, agreeableness, neuroticism, each 0–1, with one line of evidence and a confidence of low or medium. Use 0.5 and say "no signal" where you can't tell. This is not a psychological assessment.
- **Who I'd click with:** what I'm probably looking for, and whether I'd do better with someone similar to me or complementary.
- **Guesses:** say where you're guessing. If you have very little to go on, ask me up to 3 quick questions first and wait for my answers.

**Part 2: the upload.** One JSON code block, exactly this shape, with nothing else in it:

```json
{
  "room": "world",
  "dims": {
    "planning": 0.5, "delegation_size": 0.5, "verification": 0.5, "steering": 0.5, "exploration": 0.5,
    "verbosity": 0.5, "curiosity": 0.5, "warmth": 0.5, "frustration": 0.5, "night_owl": 0.5
  },
  "card": {
    "headline": "",
    "style": "",
    "big5": { "O": 0.5, "C": 0.5, "E": 0.5, "A": 0.5, "N": 0.5 },
    "topics": [],
    "file_types": [],
    "looking_for": "just curious",
    "mode": "similar"
  }
}
```

Dimensions run from 0 to 1. Use 0.5 when you can't tell:
- `planning`: writes a plan or spec before code (1) vs dives straight in (0)
- `delegation_size`: hands over big multi-step tasks (1) vs small single steps (0)
- `verification`: tests and checks output (1) vs ships unchecked (0)
- `steering`: interrupts and corrects often (1) vs lets the AI run (0)
- `exploration`: researches and reads before changing things (1) vs edits immediately (0)
- `verbosity`: long, detailed prompts (1) vs terse ones (0)
- `curiosity`: asks why and how (1) vs only gives orders (0)
- `warmth`: please and thanks, friendly (1) vs purely transactional (0)
- `frustration`: vents or swears at the AI (1) vs stays calm (0)
- `night_owl`: share of building done late at night

Card rules:
- `headline`: one line, at most 90 characters, something a fellow builder would smile at
- `style`: 2–3 sentences, at most 400 characters, describing how I build
- No names, employers, clients, project or product names, locations, links, or quotes, anywhere in the JSON
- `topics`: up to 8 coarse tags, like "payments", "data pipelines", "typescript", "cloudflare"
- `file_types`: up to 6 extensions for languages I clearly use, like ".ts" or ".py"; leave it empty if unsure
- `looking_for`: one of "cofounder", "teammate", "pairing", "just curious"
- `mode`: "similar" or "complement"
- Put nothing in the JSON that you didn't show me in Part 1

After the code block, tell me to check it, ask you to change anything I don't like, and then paste it at https://slopmatch.lol/join. That page shows me the exact payload before anything is published.
