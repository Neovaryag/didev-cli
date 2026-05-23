#!/usr/bin/env bash
# Adds npm global bin directory to PATH in ~/.bashrc for Git Bash on Windows.
# Usage: bash scripts/setup-path.sh

set -euo pipefail

PREFIX=$(npm config get prefix 2>/dev/null)
if [ -z "$PREFIX" ]; then
  echo "Error: could not determine npm prefix. Make sure Node.js is installed."
  exit 1
fi

# Convert Windows path (C:\...) to Git Bash format (/c/...)
if [[ "$PREFIX" =~ ^[A-Za-z]:\\ ]] || [[ "$PREFIX" =~ ^[A-Za-z]:/ ]]; then
  DRIVE=$(echo "$PREFIX" | cut -c1 | tr '[:upper:]' '[:lower:]')
  REST=$(echo "$PREFIX" | cut -c3- | tr '\\' '/')
  BASH_PREFIX="/${DRIVE}/${REST}"
else
  BASH_PREFIX="$PREFIX"
fi

EXPORT_LINE="export PATH=\"${BASH_PREFIX}:\$PATH\""
BASHRC="$HOME/.bashrc"
MARKER="# didev PATH"

if grep -qF "didev PATH" "$BASHRC" 2>/dev/null || grep -qF "$BASH_PREFIX" "$BASHRC" 2>/dev/null; then
  echo "✅ PATH already configured in $BASHRC"
  echo "   Run: source ~/.bashrc"
  exit 0
fi

{
  echo ""
  echo "$MARKER"
  echo "$EXPORT_LINE"
} >> "$BASHRC"

echo "✅ Added to $BASHRC:"
echo "   $EXPORT_LINE"
echo ""
echo "   Now run: source ~/.bashrc"
echo "   Then verify: didev --version"
