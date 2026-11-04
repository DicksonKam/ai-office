#!/bin/zsh
# Stop the AI Office LaunchAgent and move its plist to the Trash (nothing is deleted permanently).
set -euo pipefail
LABEL="local.ai-office"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ -f "$PLIST" ]; then
  osascript -e "tell application \"Finder\" to delete POSIX file \"$PLIST\"" >/dev/null
  echo "Stopped $LABEL; plist moved to the Trash."
else
  echo "$LABEL was not installed."
fi
