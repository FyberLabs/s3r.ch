"""Copy child-write decision cases from the pinned upstream contract.
Usage: python3 scripts/fixtures/copy-forum-child-vectors.py /path/to/SociACL
"""
import json
import subprocess
import sys
from pathlib import Path

PIN = "b7f9bc59e800fef8420c9ced8040c925ef7ceac7"
cases = []
for family in ("post", "group"):
    path = f"vectors/mesh/v2/{family}.json"
    doc = json.loads(subprocess.check_output(["git", "-C", sys.argv[1], "show", f"{PIN}:{path}"]))
    cases.extend(dict(case, source=path) for case in doc["accept"]
                 if any(step["op"] == "check-drawer-write" for step in case["steps"]))
Path("lib/identity/vectors/forum-child.json").write_text(
    json.dumps({"source": f"FyberLabs/SociACL {PIN}", "cases": cases}, indent=2) + "\n")
