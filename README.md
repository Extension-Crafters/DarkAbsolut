# DarkAbsolut

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

## Description

My eyes are worn...
She brazenly plumbs the depths of the darkness that separates her from my pupil.  
Please kill all the lights in this world!
Turn off the light waiting to the end of humanity...
  
[DarkAbsolut website](https://extension-crafters.github.io/DarkAbsolut/)

A cross-browser (Chrome / Firefox MV3) extension that automatically applies a
dark theme to websites that don't already provide one. It uses smart detection
to skip sites that are already dark, and offers a popup UI with a global kill
switch and per-domain/subdomain disable.

## Features

- **Automatic dark mode** via CSS `filter: invert(1) hue-rotate(180deg)` on
  `<html>`, with re-inversion of media (images, videos, embeds, canvases,
  SVG `<image>`) and elements with CSS background images so visual content
  keeps its real colors. Iframes are intentionally *not* counter-inverted
  so HTML content embedded in same-origin iframes (e.g. Gmail message
  bodies, compose windows) is darkened along with the rest of the page.
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

The content script runs at `document_start` in every frame, asks the
background worker whether the URL is enabled, then once the body is available
checks if the page is already dark. If not, it injects a `<style>` and
toggles `<html data-darkabsolut="on">` to activate the inversion rules. A
`MutationObserver` keeps newly-inserted background-image elements re-inverted.

The service worker stores state in `chrome.storage.local`:

```json
{ globalEnabled: true, disabledDomains: [{ domain, includeSubdomains }] }
```

It also updates the toolbar badge (`off`, `—`, or empty).

## File layout

```text
manifest.json
src/
  content/                    classic scripts injected in order by the manifest
    00-namespace.js           shared `DA` namespace + attribute constants
    colors.js                 pure color math (parse, luminance, HSL, …)
    detect.js                 dark-theme detection (viewport sampling, fallbacks)
    styles.js                 CSS generation + style-tag injection
    elements.js               per-element tagging and pre-lightening
    controller.js             lifecycle, observers, message handling
  background/                 service worker, loaded as ES modules
    index.js                  entry point (install hook, tab listeners)
    storage.js                chrome.storage.local wrapper + defaults
    matching.js               URL / hostname / disabled-list rules
    badge.js                  toolbar badge updates
    messaging.js              runtime message router
popup/
  popup.html  popup.css  popup.js     main popup UI
  io.html     io.css     io.js        Import / Export page
  shared.js                            $() / send() / active-tab helpers
invert.css                   (reference; runtime CSS is injected by the content script)
icons/icon.svg + icon{16,32,48,128}.png
tests/                       Playwright tests, see below
package-extension.sh         builds DarkAbsolut.zip for distribution
```

## Running the tests

All test assets live under `tests/`:

```text
tests/test-extension.js             End-to-end: loads the unpacked extension, checks invert on/off
tests/test-dark.js                  Playwright runner (navigates a real page)
tests/test-core.js                  Standalone inversion core, injected by the runner
tests/visual-audit.js               Loads the real extension, screenshots fixtures (+ live
                                    sites with --live) and scores darkness from real pixels
tests/fixtures.js                   Synthetic header/banner patterns (regression fixtures)
tests/diag.js                       Diagnose one URL: dumps the header element chain + screenshot
tests/lib/png.js                    Dependency-free PNG decoder used by the visual audit
tests/screenshots/                  Generated output (screenshots + swatches, gitignored)
tests/screenshots/test-result.png   Swatch screenshot written by the runner
tests/screenshots/test-swatches.html Generated swatch comparison page
```

Headless note: the audit/diag harnesses load the unpacked extension via
Playwright with `channel: 'chromium'` + `--headless=new`. The default
`chrome-headless-shell` cannot load extensions, so that channel is required.

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

## Project website (GitHub Pages)

A static landing page lives in [`docs/`](docs/) (`index.html` + `style.css` +
`assets/`). To publish it, open the repo's **Settings → Pages** and set the
source to **Deploy from a branch**, branch `master`, folder `/docs`. It then
serves at `https://extension-crafters.github.io/DarkAbsolut/`.

The page presents the project, its features and screenshots, and install
instructions. Replace the `href="#"` placeholders on the “Add to Chrome / Firefox”
buttons in `docs/index.html` with the real listing URLs once the extension is
published. The page is excluded from the distributable zip by
`package-extension.sh`.

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
