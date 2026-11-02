"""Copy the pinned upstream resolution cases, pooling repeated records verbatim.
Usage: python3 scripts/fixtures/copy-forum-recovery-vectors.py /path/to/SociACL
No upstream runtime is imported by the app or tests.
"""
import json
import subprocess
import sys
from pathlib import Path

PIN = "b7f9bc59e800fef8420c9ced8040c925ef7ceac7"
source = json.loads(subprocess.check_output([
    "git", "-C", sys.argv[1], "show", f"{PIN}:vectors/ids/records.json"
]))
pool, indexes = [], {}
def intern(record):
    key = json.dumps(record, sort_keys=True)
    if key not in indexes:
        indexes[key] = len(pool)
        pool.append(record)
    return indexes[key]

cases = []
for kind in ("accept", "reject"):
    for row in source[kind]:
        if row.get("operation") != "resolve":
            continue
        case = {k: v for k, v in row.items() if k not in (
            "operation", "input", "links", "revocations", "genesisEpubBindings", "histories"
        )}
        case["accept"] = kind == "accept"
        case["rotations"] = [intern(r) for r in row["input"]]
        for field in ("revocations", "genesisEpubBindings"):
            if field in row:
                case[field] = [intern(r) for r in row[field]]
        if "links" in row:
            case["links"] = [[key, intern(r)] for key, r in row["links"]]
        if "histories" in row:
            case["histories"] = [[key, [intern(r) for r in records]] for key, records in row["histories"]]
        cases.append(case)
context = dict(source["context"])
context["links"] = [[key, intern(r)] for key, r in context["links"]]
output = {"source": f"FyberLabs/SociACL {PIN} vectors/ids/records.json",
          "context": context, "records": pool, "cases": cases}
Path("lib/identity/vectors/forum-recovery-history.json").write_text(json.dumps(output, indent=2) + "\n")
