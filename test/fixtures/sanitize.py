#!/usr/bin/env python3
"""Turn a real Claude Code transcript (.jsonl) into a fixture with no user content.

Deny by default: every string is replaced unless its key is structural (KEEP) or the value is
a uuid / timestamp / semver. Text lengths are kept so size-limit logic can be tested.
Usage: sanitize.py <in.jsonl> <out.jsonl> [max_lines]
"""
import json, re, sys

KEEP = {"type", "role", "version", "subtype", "stop_reason", "name", "isSidechain", "userType",
        "entrypoint", "level", "isMeta", "isCompactSummary", "hookEvent", "permissionMode",
        "stop_sequence", "model", "operation", "mode"}
SAFE = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
                  r"|\d{4}-\d\d-\d\dT[\d:.]+Z?|\d+\.\d+\.\d+|toolu_\w+|msg_\w+|req_\w+)$")
PLACEHOLDER = {"cwd": "/work/acme/billing-api", "gitBranch": "feature/PAY-42-webhooks",
               "transcript_path": "/home/dev/.claude/projects/-work-acme-billing-api/session.jsonl"}

def scrub(v, key=None):
    if isinstance(v, dict):
        return {k: scrub(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x, key) for x in v]
    if isinstance(v, str):
        if key in PLACEHOLDER: return PLACEHOLDER[key]
        if key in KEEP or SAFE.match(v): return v
        return f"<{key or 'str'}:{len(v)}>"
    return v

src, dst = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 80
with open(src) as f, open(dst, "w") as out:
    for i, line in enumerate(f):
        if i >= limit: break
        try: out.write(json.dumps(scrub(json.loads(line)), ensure_ascii=False) + "\n")
        except json.JSONDecodeError: out.write('"<unparseable line>"\n')
