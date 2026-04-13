#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The Curator — Mac Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/talirezun/the-curator/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

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

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}Error: Node.js is required but not installed.${NC}"
  echo "  → Download it from: https://nodejs.org  (choose the LTS version)"
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [[ "$NODE_VER" -lt 18 ]]; then
  echo -e "${RED}Error: Node.js 18 or later is required. You have v${NODE_VER}.${NC}"
  echo "  → Update at: https://nodejs.org"
  exit 1
fi
echo -e "  ✓ Node.js v$(node --version | tr -d v) detected"

# ── Choose install location ───────────────────────────────────────────────────
INSTALL_DIR="$HOME/the-curator"
if [[ -d "$INSTALL_DIR" ]]; then
  echo ""
  echo -e "${YELLOW}The Curator is already installed at $INSTALL_DIR${NC}"
  echo "  To reinstall, delete that folder first, then run this script again."
  exit 0
fi
echo -e "  Installing to: ${GREEN}${INSTALL_DIR}${NC}"

# ── Clone repo ────────────────────────────────────────────────────────────────
echo ""
echo "  📥  Downloading The Curator…"
git clone --depth 1 https://github.com/talirezun/the-curator.git "$INSTALL_DIR" --quiet
cd "$INSTALL_DIR"

# ── Install Node dependencies ─────────────────────────────────────────────────
echo "  📦  Installing dependencies…"
npm install --silent --no-audit --no-fund

# ── Gemini API key ────────────────────────────────────────────────────────────
echo ""
echo -e "  ${BLUE}A free Google Gemini API key is required.${NC}"
echo "  Get one at: https://aistudio.google.com/app/apikey"
echo "  (It's free — no credit card needed for standard use)"
echo ""
read -rp "  Paste your Gemini API key (Enter to skip and add later): " GEMINI_KEY
echo ""

if [[ -n "${GEMINI_KEY// /}" ]]; then
  echo "GEMINI_API_KEY=${GEMINI_KEY}" > .env
  echo -e "  ${GREEN}✓ API key saved${NC}"
else
  cp .env.example .env
  echo -e "  ${YELLOW}⚠  Skipped — edit ${INSTALL_DIR}/.env before starting${NC}"
fi

# ── Build The Curator.app ─────────────────────────────────────────────────────
echo ""
echo "  🔨  Building The Curator.app…"

# Generate brain icon via Swift
cat > /tmp/curator_icon.swift << 'SWIFTEOF'
import AppKit
import Foundation
let size = 1024
let nsSize = NSSize(width: size, height: size)
let image = NSImage(size: nsSize)
image.lockFocus()
NSColor(red: 0.38, green: 0.40, blue: 0.93, alpha: 1.0).setFill()
NSBezierPath(roundedRect: NSRect(x:0,y:0,width:size,height:size), xRadius:200, yRadius:200).fill()
NSColor(red: 0.55, green: 0.57, blue: 0.98, alpha: 0.25).setFill()
NSBezierPath(roundedRect: NSRect(x:30,y:30,width:size-60,height:size-60), xRadius:170, yRadius:170).fill()
let emoji = "🧠" as NSString
let font = NSFont.systemFont(ofSize: 640)
let attrs: [NSAttributedString.Key: Any] = [.font: font]
let ts = emoji.size(withAttributes: attrs)
emoji.draw(at: NSPoint(x:(Double(size)-ts.width)/2, y:(Double(size)-ts.height)/2-10), withAttributes: attrs)
image.unlockFocus()
let tiff = image.tiffRepresentation!
let bmp = NSBitmapImageRep(data: tiff)!
let png = bmp.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "/tmp/curator_icon_1024.png"))
SWIFTEOF
swift /tmp/curator_icon.swift 2>/dev/null

ICONSET=/tmp/CuratorIcon.iconset
rm -rf "$ICONSET" && mkdir "$ICONSET"
for SIZE in 16 32 128 256 512; do
  sips -z $SIZE $SIZE /tmp/curator_icon_1024.png --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  sips -z $((SIZE*2)) $((SIZE*2)) /tmp/curator_icon_1024.png --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
sips -z 1024 1024 /tmp/curator_icon_1024.png --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o /tmp/CuratorIcon.icns 2>/dev/null

NODE_PATH="$(which node)"
cat > /tmp/TheCurator.applescript << ASEOF
property serverPort : "3333"
property appURL : "http://localhost:3333"
property projectPath : "${INSTALL_DIR}"
property nodePath : "${NODE_PATH}"

on run
    try
        do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
        open location appURL
        return
    end try
    do shell script "cd " & quoted form of projectPath & " && nohup " & nodePath & " src/server.js >> /tmp/the-curator.log 2>&1 & echo \$! > /tmp/the-curator.pid"
    set attempts to 0
    repeat
        delay 1
        set attempts to attempts + 1
        try
            do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
            exit repeat
        end try
        if attempts > 15 then
            display dialog "The Curator could not start." & return & return & "Check " & projectPath & "/.env has a valid GEMINI_API_KEY." & return & return & "Log: /tmp/the-curator.log" buttons {"OK"} default button 1 with icon stop
            return
        end if
    end repeat
    open location appURL
end run
ASEOF

osacompile -o "${INSTALL_DIR}/The Curator.app" /tmp/TheCurator.applescript 2>/dev/null
cp /tmp/CuratorIcon.icns "${INSTALL_DIR}/The Curator.app/Contents/Resources/applet.icns"
touch "${INSTALL_DIR}/The Curator.app"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅  The Curator installed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  App location : ${INSTALL_DIR}"
echo "  Dock icon    : ${INSTALL_DIR}/The Curator.app"
echo ""
echo -e "  ${BLUE}Last step:${NC}"
echo "  1. Open Finder"
echo "  2. Press Cmd+Shift+G and type: ${INSTALL_DIR}"
echo "  3. Drag  'The Curator.app'  to your Dock"
echo "  4. Double-click the Dock icon to launch 🚀"
echo ""
if [[ -z "${GEMINI_KEY// /}" ]]; then
  echo -e "  ${YELLOW}Remember to add your Gemini API key:${NC}"
  echo "  Edit: ${INSTALL_DIR}/.env"
  echo ""
fi
