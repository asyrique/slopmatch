"""Generate fake Claude Code transcripts that exercise every code path, including planted secrets."""
import json, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

root = Path("fixtures/projects")
base = datetime.now(timezone.utc) - timedelta(days=5)


def user(ts, sid, cwd, content, **kw):
    return {"type": "user", "sessionId": sid, "cwd": cwd, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "uuid": str(uuid.uuid4()), "message": {"role": "user", "content": content}, **kw}


def asst(ts, sid, cwd, blocks, model="claude-opus-5-5"):
    return {"type": "assistant", "sessionId": sid, "cwd": cwd, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "uuid": str(uuid.uuid4()), "message": {"role": "assistant", "model": model, "content": blocks}}


def tool(name, **inp):
    return {"type": "tool_use", "id": "t" + uuid.uuid4().hex[:8], "name": name, "input": inp}


def result(text, err=False):
    return [{"type": "tool_result", "tool_use_id": "x", "content": text, "is_error": err}]


SECRET_PROMPT = (
    # Fake secrets are assembled at runtime so secret scanners don't flag this file.
    "Deploy with my key " + "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345" + " and AWS " + "AKIA" + "IOSFODNN7EXAMPLE, "
    "email me at grizzly@example.com, db is postgres://admin:hunter2@10.0.0.5:5432/prod, "
    "config lives in /Users/grizzly/work/acme/secrets.env and password=SuperSecret123! token: " + "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789" + " "
    "call +65 9123 4567. Acme Corp should not appear."
)

sessions = []

# Session A: planner. long spec, plan mode, tests, polite.
sid, cwd, t = "sess-a", "/Users/x/proj-epsilon", base
lines = [
    {"type": "summary", "summary": "Plant historian ingestion", "leafUuid": "x"},
    user(t, sid, cwd, "<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
    user(t + timedelta(seconds=5), sid, cwd,
         "Please plan out an ingestion pipeline for OPC-UA tags into our historian. Requirements: dedupe on (tag, ts), "
         "backfill gaps under 5 minutes with linear interpolation, store in parquet partitioned by day, and expose a "
         "query API. Think about trade-offs between DuckDB and ClickHouse before writing anything. Compare the options "
         "and write tests first. Here is the existing schema:\n```sql\nCREATE TABLE tags (id int, name text);\n```"),
    asst(t + timedelta(minutes=1), sid, cwd, [tool("Read", file_path="/Users/x/proj-epsilon/schema.sql"),
                                              tool("Grep", pattern="tag"), tool("WebSearch", query="duckdb vs clickhouse")]),
    user(t + timedelta(minutes=1, seconds=2), sid, cwd, result("ok")),
    asst(t + timedelta(minutes=3), sid, cwd, [tool("ExitPlanMode", plan="...")]),
    user(t + timedelta(minutes=4), sid, cwd, "Looks good, thanks. Go ahead, and make sure the tests pass."),
    asst(t + timedelta(minutes=5), sid, cwd, [tool("TodoWrite", todos=[]), tool("Write", file_path="/Users/x/proj-epsilon/ingest.py", content="..."),
                                              tool("Write", file_path="/Users/x/proj-epsilon/test_ingest.py", content="...")]),
    asst(t + timedelta(minutes=6), sid, cwd, [tool("Bash", command="cd /Users/x/proj-epsilon && uv run pytest -q"),
                                              tool("Bash", command="ruff check . && mypy ingest.py"),
                                              tool("Bash", command="git status && git diff")]),
    user(t + timedelta(minutes=7), sid, cwd, "Nice work. Can you double-check the interpolation edge case at midnight?"),
    asst(t + timedelta(minutes=8), sid, cwd, [tool("Edit", file_path="/Users/x/proj-epsilon/ingest.py"), tool("Bash", command="uv run pytest -q")]),
    user(t + timedelta(minutes=9), sid, cwd, "<system-reminder>internal stuff</system-reminder>"),
    {"type": "assistant", "isSidechain": True, "sessionId": sid, "timestamp": (t + timedelta(minutes=9)).isoformat(),
     "message": {"content": [tool("Edit", file_path="/should/not/count.rs")]}},
    "this is not json {",
]
sessions.append((cwd, sid, lines))

# Session B: diver. short prompts, no plan, interrupts, rejection, frustration, late night.
sid, cwd, t = "sess-b", "/Users/x/openasia", base.replace(hour=16) + timedelta(days=1)  # 00:xx SGT
lines = [
    user(t, sid, cwd, "fix the webhook it's 500ing"),
    asst(t + timedelta(seconds=30), sid, cwd, [tool("Edit", file_path="/Users/x/openasia/src/webhook.ts"),
                                               tool("Edit", file_path="/Users/x/openasia/src/router.ts"),
                                               tool("Bash", command="npx wrangler deploy")]),
    user(t + timedelta(seconds=40), sid, cwd, result("The user doesn't want to proceed with this tool use. The tool use was rejected.", True)),
    user(t + timedelta(seconds=45), sid, cwd, "no don't deploy yet, just run it locally"),
    asst(t + timedelta(minutes=1), sid, cwd, [tool("Bash", command="npx wrangler dev"), tool("Edit", file_path="/Users/x/openasia/src/webhook.ts")]),
    user(t + timedelta(minutes=2), sid, cwd, [{"type": "text", "text": "[Request interrupted by user for tool use]"}]),
    user(t + timedelta(minutes=2, seconds=10), sid, cwd, "WHY did you DELETE the RETRY LOGIC again?? put it back"),
    asst(t + timedelta(minutes=3), sid, cwd, [tool("Edit", file_path="/Users/x/openasia/src/webhook.ts"), tool("Bash", command="npx wrangler dev")]),
    user(t + timedelta(minutes=4), sid, cwd, SECRET_PROMPT),
    asst(t + timedelta(minutes=5), sid, cwd, [tool("Task", description="audit", prompt="...")]),
    user(t + timedelta(minutes=6), sid, cwd, "still broken. ugh. just make it work"),
    asst(t + timedelta(minutes=7), sid, cwd, [tool("Edit", file_path="/Users/x/openasia/src/webhook.ts"), tool("Bash", command="npx wrangler dev")]),
    user(t + timedelta(minutes=8), sid, cwd, [{"type": "text", "text": "ok works [Image #1] ship it"}]),
    asst(t + timedelta(minutes=9), sid, cwd, [tool("Bash", command="git add -A && git commit -m wip && npx wrangler deploy")]),
]
sessions.append((cwd, sid, lines))

# Session C: research chat, no edits, questions.
sid, cwd, t = "sess-c", "/Users/x/openasia", base + timedelta(days=2, hours=3)
lines = [
    user(t, sid, cwd, "What are the options for WhatsApp template message rate limits in Bangladesh?"),
    asst(t + timedelta(seconds=20), sid, cwd, [tool("WebSearch", query="whatsapp rate limits"), tool("WebFetch", url="https://x")]),
    user(t + timedelta(minutes=3), sid, cwd, "how would that change if we batch by region? what if we use multiple numbers?"),
    asst(t + timedelta(minutes=4), sid, cwd, [{"type": "text", "text": "..."}]),
]
sessions.append((cwd, sid, lines))

# Old session outside window (should be ignored with --days 3)
sid, cwd, t = "sess-old", "/Users/x/old", datetime.now(timezone.utc) - timedelta(days=200)
sessions.append((cwd, sid, [user(t, sid, cwd, "ancient prompt that should be filtered by the window")]))

for cwd, sid, lines in sessions:
    d = root / cwd.replace("/", "-")
    d.mkdir(parents=True, exist_ok=True)
    with (d / f"{sid}.jsonl").open("w") as fh:
        for ln in lines:
            fh.write((ln if isinstance(ln, str) else json.dumps(ln)) + "\n")
print("fixtures written")
