#!/bin/sh
#
# One-time setup: point Git at the tracked hooks directory.
#
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
git config core.hooksPath "$REPO_ROOT/.githooks"

echo "Git hooks configured. core.hooksPath set to .githooks/"
echo "The pre-commit hook will auto-bump plugin versions on commit."
