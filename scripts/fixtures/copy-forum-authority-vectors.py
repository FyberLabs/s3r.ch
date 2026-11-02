"""Copy the pinned forum group-admission cases without importing its runtime.
Usage: python3 scripts/fixtures/copy-forum-authority-vectors.py /path/to/SociACL
"""
import json
import subprocess
import sys
from pathlib import Path

PIN = "b7f9bc59e800fef8420c9ced8040c925ef7ceac7"
SOURCE = "vectors/mesh/v2/group.json"
source = json.loads(subprocess.check_output(["git", "-C", sys.argv[1], "show", f"{PIN}:{SOURCE}"]))
output = {"source": f"FyberLabs/SociACL {PIN} {SOURCE}", "context": source["context"],
          "cases": [row for row in source["accept"] if row["name"].startswith("forum-")]}
Path("lib/identity/vectors/forum-authority.json").write_text(json.dumps(output, indent=2) + "\n")
