# Mac App Setup

This guide turns The Curator into a proper Mac app that lives in your Dock. After following these steps, you can double-click the icon to start the server and open the app — no Terminal needed.

---

## What you'll end up with

- A **The Curator.app** with a brain 🧠 icon in your Dock
- Double-click → server starts silently in the background → browser opens automatically
- A **■ Stop** button inside the app to shut it down cleanly
- Double-click the icon again to restart

---

## Prerequisites

Complete the main [User Guide](user-guide.md) first — the app must be installed and working from the terminal before you create the Dock shortcut.

---

## Step 1 — Generate the brain icon

Open Terminal, go to your `the-curator` folder, and run this command exactly:

```bash
swift - << 'EOF'
import AppKit, Foundation

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
try! png.write(to: URL(fileURLWithPath: "/tmp/brain_icon_1024.png"))
print("Icon created ✓")
EOF
```

Then build the icon files:

```bash
ICONSET=/tmp/BrainIcon.iconset
rm -rf $ICONSET && mkdir $ICONSET

for SIZE in 16 32 128 256 512; do
  sips -z $SIZE $SIZE /tmp/brain_icon_1024.png \
    --out $ICONSET/icon_${SIZE}x${SIZE}.png > /dev/null
  sips -z $((SIZE*2)) $((SIZE*2)) /tmp/brain_icon_1024.png \
    --out $ICONSET/icon_${SIZE}x${SIZE}@2x.png > /dev/null
done
sips -z 1024 1024 /tmp/brain_icon_1024.png \
  --out $ICONSET/icon_512x512@2x.png > /dev/null

iconutil -c icns $ICONSET -o /tmp/BrainIcon.icns
echo "Brain icon ready ✓"
```

---

## Step 2 — Create the app

Replace `/Users/YOUR_USERNAME/the-curator` in the command below with the actual path to your project folder (tip: type `pwd` in Terminal while inside the folder to see the full path).

```bash
# Adjust this path to match your setup
PROJECT="/Users/YOUR_USERNAME/the-curator"

cat > /tmp/TheCurator.applescript << ASEOF
property serverPort : "3333"
property appURL : "http://localhost:3333"
property projectPath : "${PROJECT}"
property nodePath : "/usr/local/bin/node"

on run
    try
        do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
        open location appURL
        return
    end try

    do shell script "cd " & quoted form of projectPath & " && nohup " & nodePath & " src/server.js >> /tmp/the-curator.log 2>&1 & echo $! > /tmp/the-curator.pid"

    set attempts to 0
    repeat
        delay 1
        set attempts to attempts + 1
        try
            do shell script "curl -s --max-time 1 " & appURL & " > /dev/null 2>&1"
            exit repeat
        end try
        if attempts > 15 then
            display dialog "The Curator could not start." & return & return & "Check that your .env file has a valid GEMINI_API_KEY." & return & return & "Log: /tmp/the-curator.log" buttons {"OK"} default button 1 with icon stop
            return
        end if
    end repeat

    open location appURL
end run
ASEOF

osacompile -o "${PROJECT}/The Curator.app" /tmp/TheCurator.applescript
cp /tmp/BrainIcon.icns "${PROJECT}/The Curator.app/Contents/Resources/applet.icns"
touch "${PROJECT}/The Curator.app"
echo "App created ✓"
```

---

## Step 3 — Add to Dock

1. Open **Finder**
2. Navigate to your `the-curator` folder
3. You will see **The Curator.app** with the brain icon
4. **Drag it to your Dock** — place it between your other apps

That's it. You can now double-click it at any time.

---

## How to use it

| Action | How |
|--------|-----|
| Start the app | Click the Dock icon |
| Stop the app | Click **■ Stop** in the top-right of the browser UI |
| Restart the app | Click the Dock icon again after stopping |
| View logs (if something goes wrong) | Open Terminal and run: `cat /tmp/the-curator.log` |

---

## Troubleshooting

**"The Curator could not start" dialog appears**

The most common cause is a missing or invalid API key. Check that:
- The `.env` file exists inside your `the-curator` folder (not `.env.example`)
- It contains `GEMINI_API_KEY=` followed by your actual key

View the full error log with:
```bash
cat /tmp/the-curator.log
```

**"node: command not found" in the log**

Node.js is not installed at `/usr/local/bin/node`. Find your Node path:
```bash
which node
```

Then edit the app's AppleScript and replace `/usr/local/bin/node` with the path returned by that command. To edit the script, right-click `The Curator.app` → **Show Package Contents** → `Contents/Resources/Scripts` → open `main.scpt` in Script Editor.

**The icon doesn't appear in the Dock**

macOS caches icons. Force a refresh:
```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/path/to/the-curator/The Curator.app"
killall Dock
```

**I moved the `the-curator` folder**

The app has the old path hardcoded. Delete `The Curator.app` from your project folder and repeat Step 2 with the new path.
