```text
     *        .       .    *         .               .       *
 .         *              .-""""-.         *      .        *
                       .'  .  .   '.                   .
    *       .         /  .        . \      *
                     ;    .-""""-.   ;            .       *
  .        *         |   /        \  |   .                     *
             .       ;  |  O    O  | ;        *       .
      *              \  ;   '--'   ; /                      .
   .        .         '. '.      .' .'    *         .
                        '. '----'  .'              *
      *       .           '-....-'        .        .     *
                             .                 *
  .       *        .       .       *       .         .       *
                                                             .
                          o                *      .
          *      .       /|\       .              .       *
     .                    |                  .
                 .       / \         *              *        .
  __.__.____.____.____._______.____.____.____.____.____.__
       D A R K     A B S O L U T
    "he stood alone, and the moon answered in silence."
```

# DarkAbsolut

# Description

My eyes are worn...
She brazenly plumbs the depths of the darkness that separates her from my pupil. 
Please kill all the lights in this world!
Turn off the light waiting to the end of humanity...

*DarkAbsolut*

A cross-browser (Chrome / Firefox MV3) extension that automatically applies a
dark theme to websites that don't already provide one. It uses smart detection
to skip sites that are already dark, and offers a popup UI with a global kill
switch and per-domain/subdomain disable.

## Features

- **Automatic dark mode** via CSS `filter: invert(1) hue-rotate(180deg)` on
  `<html>`, with re-inversion of media (images, videos, iframes, embeds,
  canvases, SVG `<image>`) and elements with CSS background images so visual
  content keeps its real colors.
- **Already-dark detection**: respects `color-scheme: dark` declared by the
  site and measures the effective background luminance of `html`/`body`.
- **Popup UI**:
  - Global on/off (kill switch).
  - Disable on the current domain.
  - Optional "include subdomains".
  - Reload-tab convenience button.
- **Cross-browser**: MV3 manifest with `browser_specific_settings.gecko` for
  Firefox 121+ (MV3 with service worker support).

## Install (development)

### Chrome / Edge / Brave / Chromium
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

### Firefox (≥ 121)
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json`.

For permanent installation in Firefox, the extension must be signed by Mozilla
(`web-ext sign`) — the included gecko id is suitable.

## How it works

- `content.js` runs at `document_start` in every frame, asks the background
  worker whether the URL is enabled, then once the body is available checks if
  the page is already dark. If not, it injects a `<style>` and toggles
  `<html data-darkabsolut="on">` to activate the inversion rules. A
  `MutationObserver` keeps newly-inserted background-image elements re-inverted.
- `background.js` stores state in `chrome.storage.local`:
  ```
  { globalEnabled: true, disabledDomains: [{ domain, includeSubdomains }] }
  ```
  It also updates the toolbar badge (`off`, `—`, or empty).
- `popup/` provides the UI.

## File layout

```
manifest.json
background.js
content.js
invert.css                 (reference; runtime CSS is injected by content.js)
popup/popup.html
popup/popup.css
popup/popup.js
icons/icon.svg + icon{16,32,48,128}.png
tests/                     (Playwright tests, see below)
package-extension.sh       (builds DarkAbsolut.zip for distribution)
```

## Running the tests

All test assets live under `tests/`:

```
tests/test-dark.js                  Playwright runner (navigates a real page)
tests/test-core.js                  Standalone inversion core, injected by the runner
tests/screenshots/                  Generated output (screenshots + swatches, gitignored)
tests/screenshots/test-result.png   Swatch screenshot written by the runner
tests/screenshots/test-swatches.html Generated swatch comparison page
```

Install dependencies once, then run:

```bash
npm install
npm test
# equivalent to: node tests/test-dark.js
```

The runner launches headless Chromium via Playwright, loads a reference page,
injects `tests/test-core.js`, and writes `tests/screenshots/test-result.png`
plus an updated `tests/screenshots/test-swatches.html` for visual comparison.
The `tests/screenshots/` folder is gitignored.

On first run you may need the Playwright browser binaries:

```bash
npx playwright install chromium
```

## Packaging for distribution

A shell script at the repo root builds a clean zip excluding `tests/`,
`node_modules/`, `.claude/`, git metadata and diagnostic screenshots:

```bash
npm run package
# or directly:
./package-extension.sh
```

This produces `DarkAbsolut.zip` at the repo root, ready to upload to the
Chrome Web Store or to submit to Mozilla via `web-ext sign`.

## Notes & limitations

- The CSS-filter approach is fast and universal but cannot perfectly match a
  hand-tuned dark theme. Sites with heavy custom theming may look unusual;
  use the per-domain disable in those cases.
- The "already dark" heuristic uses the computed background of `html`/`body`
  with a luminance threshold of `0.35`. Sites that defer painting their dark
  background until after first paint may briefly flash inverted; reload to
  re-evaluate.
- "Include subdomains" stores a single rule for the entered host that matches
  itself and any `*.host`. To remove a parent subdomain rule covering the
  current site, visit that parent host and toggle it off there.
