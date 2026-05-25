#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/zhangmiao/Documents/Codex/xhs-hotspot-poster"
PLIST="$HOME/Library/LaunchAgents/com.codex.xhs-hotspot-poster.plist"
PYTHON_BIN="$(command -v python3)"

mkdir -p "$PROJECT_DIR/logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex.xhs-hotspot-poster</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_BIN</string>
    <string>-m</string>
    <string>xhs_hotspot_poster</string>
    <string>--once</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/logs/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "Installed daily job: $PLIST"

