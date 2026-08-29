#!/usr/bin/env bash
# Publishes this folder to a new GitHub repository.
# Usage:  ./publish.sh [repo-name]        (default: claude-limits)
set -euo pipefail

REPO="${1:-claude-limits}"
cd "$(dirname "$0")"

if [ ! -f manifest.json ]; then
  echo "Run this from the project folder (manifest.json not found)." >&2
  exit 1
fi

if [ ! -d .git ]; then
  git init -b main
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit — the tree is already staged as committed."
else
  git commit -m "Claude Limits: floating plan-usage panel as a Claude Desktop extension

Shows Claude plan usage in a small always-on-top panel pinned to the corner
of the Claude Desktop window. The panel is started by the extension's MCP
server when the app launches and closes together with it.

- four looks (card, compact, bar, icon), four languages, adjustable font size
- bars fill with consumption; yellow from 80%, red from 90%
- data is read from the local usage cache only, nothing leaves the machine
- chat tools: show_limits, get_limits, overlay_status, overlay_restart, diagnose"
fi

echo
echo "Files that will be published:"
git ls-files
echo

if command -v gh >/dev/null 2>&1; then
  gh repo create "$REPO" --public --source=. --remote=origin --push
  echo "Done: $(gh repo view "$REPO" --json url -q .url)"
else
  cat <<'HINT'
GitHub CLI (gh) is not installed.

Either install it:
    sudo apt install gh && gh auth login
and run this script again, or create the repository by hand at
https://github.com/new (name it claude-limits, do NOT add a README,
.gitignore or licence), then run:

    git remote add origin https://github.com/<your-user>/claude-limits.git
    git push -u origin main
HINT
fi
