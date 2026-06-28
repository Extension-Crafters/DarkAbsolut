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

## Install

[![Add to Chrome](https://img.shields.io/badge/Add%20to%20Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/darkabsolut/nngbhpgleemmcplkompooimieedgichk)
[![Add to Firefox](https://img.shields.io/badge/Add%20to%20Firefox-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/darkabsolut/)
[![Get for Edge](https://img.shields.io/badge/Get%20for%20Edge-0C59A4?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://chromewebstore.google.com/detail/darkabsolut/nngbhpgleemmcplkompooimieedgichk)
[![Get for Opera](https://img.shields.io/badge/Get%20for%20Opera-FF1B2D?style=for-the-badge&logo=opera&logoColor=white)](https://chromewebstore.google.com/detail/darkabsolut/nngbhpgleemmcplkompooimieedgichk)

> **Microsoft Edge** and **Opera** are Chromium-based and run the same package,
> so their badges install the **Chrome Web Store** build (dedicated Edge/Opera
> listings are pending). Prefer to build it yourself? See
> [load unpacked](#install-development).

A cross-browser (Chrome / Firefox MV3) extension that automatically applies a
dark theme to websites that don't already provide one. It uses smart detection
to skip sites that are already dark, and offers a popup UI with a global kill
switch and per-domain/subdomain disable.

## Features

- **Automatic dark mode** via CSS `filter: invert(1) hue-rotate(180deg)` on
  `<html>`, with re-inversion of media (images, videos, embeds, canvases,
  SVG `<image>`) and elements with CSS background images so visual content
  keeps its real colors — including media inside **open shadow roots** (ad /
  sponsored web components), which a document stylesheet can't reach, so a
  shadow-scoped counter-invert sheet is adopted into each one. Iframes are
  intentionally *not* counter-inverted so HTML content embedded in same-origin
  iframes (e.g. Gmail message bodies, compose windows) is darkened along with
  the rest of the page.
- **Already-dark detection**: respects `color-scheme: dark` declared by the
  site and measures the effective background luminance of `html`/`body`.
- **Popup UI**:
  - Global on/off (kill switch).
  - Disable on the current domain.
  - Optional "include subdomains".
  - **Toggle shortcut**: record a keyboard combo (Ctrl/Alt/AltGr + another key;
    Esc cancels recording) that turns dark mode on/off for the current site from
    any page; removable from the same panel.
  - Reload-tab convenience button.
- **Cross-browser**: the committed `manifest.json` targets Chrome/Chromium
  (`background.service_worker`). Chrome rejects `background.scripts` and Firefox
  rejects `background.service_worker`, so a single manifest can't satisfy both —
  instead `package-extension.sh` emits a separate Firefox build whose
  `background` block is a `scripts` event page (Firefox 121+ has no extension
  service workers). It's the same ES-module entry point either way.
  `browser_specific_settings.gecko` carries the add-on id, `strict_min_version`
  and `data_collection_permissions` (none — no data is collected).

## Install (development)

### Chrome / Edge / Brave / Chromium

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. *(Optional)* To dark-mode local `file://` pages (saved HTML, generated
   reports), open the extension's **Details** and enable **Allow access to file
   URLs**. Chrome requires this toggle for any extension to run on `file://`;
   it cannot be granted from the manifest.

### Firefox (≥ 121)

Most users can install the published add-on directly from
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/darkabsolut/). The
steps below are for local development.

Firefox needs the Firefox-flavoured `background`, so build the packages first:

```bash
./package-extension.sh
```

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `DarkAbsolut-firefox.zip`.

Loading the repository's own `manifest.json` directly will fail with
*"background.service_worker is currently disabled"* — that file targets Chrome.
For permanent installation, sign the Firefox zip with Mozilla (`web-ext sign`);
the included gecko id is suitable.

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
package-extension.sh         builds per-browser zips (chrome / firefox)
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

A shell script at the repo root stages a clean copy (only the shipped files —
no `tests/`, `node_modules/`, `.claude/`, `docs/`, git metadata or screenshots)
and writes **one zip per store**, each with the `background` block that browser
accepts:

```bash
npm run package
# or directly:
./package-extension.sh
```

This produces, at the repo root:

- `DarkAbsolut-chrome.zip` — `background.service_worker`; upload to the Chrome
  Web Store (also works for Edge / Brave).
- `DarkAbsolut-firefox.zip` — `background.scripts` event page; submit to Mozilla
  AMO or sign with `web-ext sign`.

Both are gitignored (`*.zip`).


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

## Support

DarkAbsolut is free and open source. If it saves your eyes, you can sponsor its
development on [Ko-fi](https://ko-fi.com/extcrafters). Thank you! ☕
