"""
pytest discovery shim — adds the repo root to sys.path so test files in
this folder can do `from scanner import ...` without packaging gymnastics.

Lives at /Users/nolojik/Documents/logdhan/tests/conftest.py.
The repo root contains scanner.py and is a sibling of this `tests/` dir.
"""
import sys
import os

# Add the parent dir (repo root) so `from scanner import ...` works
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)
