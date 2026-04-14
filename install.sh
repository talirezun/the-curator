#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The Curator — Mac Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/talirezun/the-curator/main/install.sh | bash
#
# What this does:
#   1. Checks for (and optionally installs) Node.js 18+
#   2. Clones the repository to ~/the-curator
#   3. Installs Node dependencies
#   4. Builds The Curator.app (macOS desktop icon)
#   5. Opens the app — the onboarding wizard guides you through API key setup
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  🧠  The Curator — Installer${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Check macOS ───────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}Error: This installer is for macOS only.${NC}"
  exit 1
fi

# ── Check / Install Node.js ──────────────────────────────────────────────────
install_node() {
  echo ""
  echo -e "  ${BLUE}Node.js is required. Installing it now...${NC}"

  # Try Homebrew first (most common on macOS)
  if command -v brew &>/dev/null; then
    echo "  Using Homebrew to install Node.js..."
    brew install node 2>/dev/null
    return
  fi

  # No Homebrew — download the official macOS installer
  echo "  Downloading Node.js from nodejs.org..."
  NODE_VERSION="22.16.0"
  ARCH=$(uname -m)
  if [[ "$ARCH" == "arm64" ]]; then
    PKG_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.pkg"
  else
    PKG_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.pkg"
  fi

  curl -fsSL "$PKG_URL" -o /tmp/node-installer.pkg
  echo "  Running Node.js installer (you may be asked for your password)..."
  sudo installer -pkg /tmp/node-installer.pkg -target / 2>/dev/null
  rm -f /tmp/node-installer.pkg

  # Refresh PATH
  export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
}

NEED_NODE=false
if ! command -v node &>/dev/null; then
  NEED_NODE=true
else
  NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
  if [[ "$NODE_VER" -lt 18 ]]; then
    echo -e "  ${YELLOW}Node.js v${NODE_VER} detected, but v18+ is required.${NC}"
    NEED_NODE=true
  fi
fi

if [[ "$NEED_NODE" == "true" ]]; then
  # Check if running in a pipe (curl | bash) — can't prompt for input
  if [[ -t 0 ]]; then
    echo -e "  ${YELLOW}Node.js 18+ is required but not installed.${NC}"
    read -rp "  Install Node.js automatically? (Y/n): " INSTALL_CHOICE
    if [[ "${INSTALL_CHOICE,,}" == "n" ]]; then
      echo ""
      echo -e "  ${RED}Please install Node.js manually:${NC} https://nodejs.org"
      exit 1
    fi
    install_node
  else
    # Non-interactive (piped) — try auto-install
    install_node
  fi

  # Verify it worked
  if ! command -v node &>/dev/null; then
    echo ""
    echo -e "  ${RED}Node.js installation failed.${NC}"
    echo "  Please install it manually from: https://nodejs.org"
    echo "  Then run this installer again."
    exit 1
  fi
fi

echo -e "  ✓ Node.js v$(node --version | tr -d v) detected"

# ── Check git ────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  echo -e "  ${BLUE}Git not found — installing Xcode Command Line Tools...${NC}"
  xcode-select --install 2>/dev/null || true
  echo "  Please follow the popup to install, then run this installer again."
  exit 1
fi
echo -e "  ✓ Git detected"

# ── Choose install location ───────────────────────────────────────────────────
INSTALL_DIR="$HOME/the-curator"
if [[ -d "$INSTALL_DIR" ]]; then
  echo ""
  echo -e "  ${YELLOW}The Curator is already installed at $INSTALL_DIR${NC}"
  echo "  To reinstall, delete that folder first, then run this script again."
  echo "  To update, use the 'Check for Updates' button in Settings."
  exit 0
fi
echo -e "  Installing to: ${GREEN}${INSTALL_DIR}${NC}"

# ── Clone repo ────────────────────────────────────────────────────────────────
echo ""
echo "  📥  Downloading The Curator..."
git clone --depth 1 https://github.com/talirezun/the-curator.git "$INSTALL_DIR" --quiet
cd "$INSTALL_DIR"

# ── Install Node dependencies ─────────────────────────────────────────────────
echo "  📦  Installing dependencies..."
npm install --silent --no-audit --no-fund 2>/dev/null

# ── Create .env (empty — wizard will handle API keys) ────────────────────────
if [[ ! -f .env ]]; then
  touch .env
fi

# ── Build The Curator.app ─────────────────────────────────────────────────────
echo "  🔨  Building The Curator.app..."

# App icon — pre-built .icns is included in the repo (no Swift or Xcode needed)
APP_ICON="${INSTALL_DIR}/images/applet.icns"

NODE_PATH="$(which node)"
cat > /tmp/TheCurator.applescript << ASEOF
property serverPort : "3333"
property appURL : "http://localhost:3333"
property projectPath : "${INSTALL_DIR}"
property nodePath : "${NODE_PATH}"

on startServer()
    -- Kill any leftover server process to avoid port conflicts
    try
        do shell script "kill $(cat /tmp/the-curator.pid 2>/dev/null) 2>/dev/null; rm -f /tmp/the-curator.pid"
    end try
    -- Also kill anything on port 3333 as a safety net
    try
        do shell script "lsof -ti :3333 | xargs kill -9 2>/dev/null"
    end try
    delay 1
    -- Start the server
    do shell script "source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; cd " & quoted form of projectPath & " && nohup " & nodePath & " src/server.js >> /tmp/the-curator.log 2>&1 & echo \$! > /tmp/the-curator.pid"
    -- Wait for server to be ready
    set attempts to 0
    repeat
        delay 1
        set attempts to attempts + 1
        try
            do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
            exit repeat
        end try
        if attempts > 15 then
            display dialog "The Curator could not start." & return & return & "Open Settings in the app to add your API key, or check the log." & return & return & "Log: /tmp/the-curator.log" buttons {"OK"} default button 1 with icon stop
            return
        end if
    end repeat
end startServer

on run
    try
        do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
        do shell script "open " & appURL
        return
    end try
    my startServer()
    do shell script "open " & appURL
end run

on reopen
    try
        do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
        do shell script "open " & appURL
    on error
        my startServer()
        do shell script "open " & appURL
    end try
end reopen
ASEOF

osacompile -o "${INSTALL_DIR}/The Curator.app" /tmp/TheCurator.applescript 2>/tmp/the-curator-build.log
if [[ ! -f "${INSTALL_DIR}/The Curator.app/Contents/Info.plist" ]]; then
  echo -e "  ${RED}Failed to build The Curator.app${NC}"
  cat /tmp/the-curator-build.log 2>/dev/null
  echo "  You can still run the app manually: cd ~/the-curator && node src/server.js"
  echo "  Then open http://localhost:3333 in your browser."
  exit 1
fi

# Apply the brain icon
if [[ -f "$APP_ICON" ]]; then
  cp "$APP_ICON" "${INSTALL_DIR}/The Curator.app/Contents/Resources/applet.icns"
fi

# Make it a stay-open applet so it remains in the Dock after first launch.
# This is essential: when the user clicks Stop and then clicks the Dock icon,
# the "on reopen" handler fires and restarts the server automatically.
/usr/libexec/PlistBuddy -c "Add :OSAAppletStayOpen bool true" \
  "${INSTALL_DIR}/The Curator.app/Contents/Info.plist" 2>/dev/null || true

# Remove macOS quarantine flag so the app can launch without Gatekeeper prompts
xattr -rd com.apple.quarantine "${INSTALL_DIR}/The Curator.app" 2>/dev/null || true

# Ad-hoc code sign — must be the LAST modification to the .app bundle
codesign --force --deep --sign - "${INSTALL_DIR}/The Curator.app" 2>/dev/null || true

# Force macOS to recognise the new .app and refresh its icon
touch "${INSTALL_DIR}/The Curator.app"
killall Dock 2>/dev/null || true

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅  The Curator installed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  📍  Installed at: ~/the-curator"
echo ""
echo -e "  ${BOLD}To add The Curator to your Dock:${NC}"
echo "  1. Open Finder"
echo "  2. Press Cmd+Shift+G and type:  ~/the-curator"
echo "  3. Drag 'The Curator' to your Dock"
echo ""

# Auto-open: start the server and open the browser directly
# (more reliable than launching the .app, which may fail on first run
#  due to macOS Gatekeeper prompts or unsigned app restrictions)
echo -e "  ${BLUE}Starting The Curator...${NC}"
cd "${INSTALL_DIR}"
nohup "${NODE_PATH}" src/server.js >> /tmp/the-curator.log 2>&1 &
echo $! > /tmp/the-curator.pid

# Wait for server to be ready
ATTEMPTS=0
while [[ $ATTEMPTS -lt 20 ]]; do
  sleep 1
  ATTEMPTS=$((ATTEMPTS + 1))
  if curl -s --max-time 1 http://localhost:3333 > /dev/null 2>&1; then
    echo ""
    echo -e "  ${GREEN}The Curator is running at http://localhost:3333${NC}"
    echo "  The setup wizard will guide you through adding your API key."
    echo ""
    open "http://localhost:3333"
    exit 0
  fi
done

echo ""
echo -e "  ${YELLOW}The server is taking longer than expected to start.${NC}"
echo "  Check the log: cat /tmp/the-curator.log"
echo "  Or try opening http://localhost:3333 in your browser."
echo ""
