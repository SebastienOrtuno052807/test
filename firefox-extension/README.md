# Save to OpenReader — Firefox extension

One-click saving to your OpenReader library, just like the Readwise extension.

## Install (1 minute)

1. Open Firefox and go to `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on…**
3. Pick the `manifest.json` file in this folder
4. The 📖 button appears in your toolbar — click it on any article to save it

> Temporary add-ons stay installed until you quit Firefox. To keep it
> permanently, it needs a free Mozilla signature (addons.mozilla.org →
> Submit → unlisted signing).

## Use

- **Toolbar button** → popup → **Save this page**
- **Right-click** any page or link → **Save to OpenReader**
- The **server URL** field in the popup tells the extension where your
  OpenReader runs. It defaults to Talos's hosted link; if that link ever
  changes (or you run OpenReader on your own computer), paste the new
  address there — e.g. `http://127.0.0.1:8765` for a local copy.

## Files

- `manifest.json` — extension manifest (Manifest V2, Firefox-native)
- `popup.html` / `popup.js` — toolbar popup UI
- `background.js` — right-click context menus + save notifications
- `icons/` — extension icons
