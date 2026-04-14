#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Rebuilds The Curator.app from the current install.sh AppleScript template.
# Called by the update endpoint after git pull to ensure the .app stays current.
# Also called manually if the .app gets corrupted or needs rebuilding.
#
# Usage: bash scripts/build-app.sh [install-dir]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_PATH="$(which node 2>/dev/null || echo '/usr/local/bin/node')"
APP_ICON="${INSTALL_DIR}/images/applet.icns"

echo "[build-app] Building The Curator.app at ${INSTALL_DIR}..."

# Generate the AppleScript source
cat > /tmp/TheCurator.applescript << ASEOF
property appURL : "http://localhost:3333"
property projectPath : "${INSTALL_DIR}"

on doStart()
    try
        do shell script "lsof -ti :3333 | xargs kill -9 2>/dev/null"
    end try
    delay 0.5
    do shell script "source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; cd " & quoted form of projectPath & " && nohup node src/server.js >> /tmp/the-curator.log 2>&1 &"
    set attempts to 0
    repeat
        delay 1
        set attempts to attempts + 1
        try
            do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
            return
        end try
        if attempts > 20 then
            display dialog "The Curator could not start." & return & return & "Log: /tmp/the-curator.log" buttons {"OK"} default button 1 with icon stop
            return
        end if
    end repeat
end doStart

on run
    try
        do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
        do shell script "open " & appURL
        return
    end try
    my doStart()
end run

on reopen
    try
        do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
        do shell script "open " & appURL
    on error
        my doStart()
    end try
end reopen
ASEOF

# Compile
osacompile -o "${INSTALL_DIR}/The Curator.app" /tmp/TheCurator.applescript 2>/tmp/the-curator-build.log
if [[ ! -f "${INSTALL_DIR}/The Curator.app/Contents/Info.plist" ]]; then
  echo "[build-app] ERROR: osacompile failed"
  cat /tmp/the-curator-build.log 2>/dev/null
  exit 1
fi

# Apply icon
if [[ -f "$APP_ICON" ]]; then
  cp "$APP_ICON" "${INSTALL_DIR}/The Curator.app/Contents/Resources/applet.icns"
fi

# Stay-open so on reopen works
/usr/libexec/PlistBuddy -c "Add :OSAAppletStayOpen bool true" \
  "${INSTALL_DIR}/The Curator.app/Contents/Info.plist" 2>/dev/null || true

# Sign and clean
xattr -rd com.apple.quarantine "${INSTALL_DIR}/The Curator.app" 2>/dev/null || true
codesign --force --deep --sign - "${INSTALL_DIR}/The Curator.app" 2>/dev/null || true
touch "${INSTALL_DIR}/The Curator.app"

echo "[build-app] Done."
