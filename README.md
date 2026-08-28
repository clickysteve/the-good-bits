# Auto Sample Chopper

**Live app: https://clickysteve.github.io/the-good-bits/**

Point it at folders (or individual files) of long source recordings — solo
horns, Rhodes, drum breaks — and it finds candidate musical phrases for you
to audition and load into hardware samplers later. It does **not** try to
replace your own chopping/sampling decisions; it's a fast first-pass editor.

Everything runs client-side: no server, no upload, nothing leaves your
browser. That's also what makes it possible to host for free as a static
site on GitHub Pages.

## Features

- **Auto or manual detection settings.** Auto mode (on by default) just uses
  sensible defaults per mode, so you don't have to make any decisions to get
  started — flip it off if you want to hand-tune silence sensitivity, phrase
  length targets, fade/click protection, and so on.
- **Loudness-adaptive silence detection.** Instead of one fixed volume
  threshold for every file, each recording's own noise floor is measured and
  the threshold is set relative to it — so quiet and hot recordings both
  behave sensibly.
- **Auto key and tempo detection** (via [essentia.js](https://mtg.github.io/essentia.js/), see licensing note below), shown per source file and baked into the output folder/file name.
- **Tempo-locked drum chopping.** When a confident tempo is detected, drum
  break boundaries snap to the beat grid so chop lengths are exact whole
  numbers of beats and loop cleanly, instead of just landing near a target
  length.
- **Click-free boundaries.** Every cut point is snapped to the nearest
  zero-crossing and gets a short fade in/out, so chops don't pop at the edges.
- **Folders or individual files.** Add whole folders, or pick loose files
  directly — both feed the same pipeline.
- **Optional per-subfolder batching.** Point it at one parent folder full of
  session subfolders and have each subfolder processed as its own
  independent source (own `wav/`, own `chops/`), instead of one flat batch.
- **In-browser audition.** Every generated chop gets an inline audio player
  in the results panel — no need to dig through Finder to hear what you got.
- **A batch that survives one bad file.** If a single file fails to decode
  or analyze, it's logged and skipped; the rest of the batch keeps going.

## Quick start

**You must serve this folder over local HTTP — do not just double-click
`index.html`.** Chrome (and other browsers) refuse to load this app's
JavaScript at all from a `file://` URL, which makes every button on the page
silently do nothing. The page will detect this and show a red banner if you
open it the wrong way. (This only matters for running it locally — the
live GitHub Pages link above is already served correctly.)

Pick whichever of these you have available and run it from inside this
folder:

```
python3 -m http.server 8000
```

or, if you have Node:

```
npx http-server -c-1 .
```

Then open the URL it prints (typically `http://localhost:8000`).

## Using it

Choose a mode, then either **Add Source Folder** (repeatable, to build a
multi-folder batch) or **Add Individual Files** (pick one or more loose
audio files). Auto mode is on by default, so you can go straight to
**Process Batch** — untick it if you want to adjust the detection
parameters first.

If a folder you add contains several session subfolders rather than audio
files directly, tick **"Treat each subfolder as its own source"** before
adding it, and each qualifying subfolder becomes its own independent batch
entry with its own `wav/`/`chops/` output, instead of everything being
flattened into one.

For individual files: in Chrome/Edge you'll be asked to pick a destination
folder the first time (there's no way for a browser to write back next to a
loose file without asking) — that choice is remembered for the rest of the
session.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo's Settings → Pages, set the source to the branch/folder
   containing `index.html` (root, or `/docs` if you move it there).
3. GitHub Pages serves over HTTPS automatically, which is required for the
   File System Access API and for Web Audio use — no extra configuration
   needed.

No build step, no bundler, no dependencies to install — it's a static site.

## Output: direct-to-folder vs. ZIP

- **Chrome / Edge** (and other browsers supporting the File System Access
  API): chops are written straight into each source folder's `wav/` and
  `chops/` subfolders. The first time you add a folder, the browser will
  ask you to confirm read/write access to it.
- **Safari / Firefox** (no File System Access API): there's no way for a
  web page to write directly to your filesystem in these browsers, so the
  whole batch is bundled into one ZIP file for you to download and unzip
  wherever you like. The ZIP mirrors the exact same folder structure a
  direct-write run would have produced.

The app detects which mode it's in and tells you at the top of the page.

## Folder layout

```
Source Folder/
    original source files
    wav/       <- 24-bit WAV copies of any non-WAV source (WAV sources aren't duplicated here)
    chops/
        <source file name> [key, tempo]/
            01.wav
            02.wav
            ...
```

The `[key, tempo]` tag (e.g. `sax_take3 [Am, 96 BPM]`) is appended to the
containing folder name, not repeated on every numbered chop, since key and
tempo are detected once per source recording and every chop from it shares
the same tag. It's only added when detection actually succeeds — if key/tempo
detection is off or unavailable, the folder just keeps its plain name.

Re-running a folder deletes and replaces its previously-generated numbered
chops (anything you've renamed or added yourself is left alone).

## Format support

`.wav` and `.aif`/`.aiff` are parsed by hand-written readers built into this
app, so they work identically and reliably in every browser at the source's
original sample rate and bit depth — no dependency on what the browser
happens to support natively.

`.mp3`, `.m4a`, and `.flac` go through the browser's built-in audio decoder
(`decodeAudioData`). Support for these varies a little by browser — Chrome
and Firefox are the most permissive, Safari is pickier about FLAC in
particular. If a file can't be decoded, you'll see a clear error for that
file in the log and the batch continues with everything else; it won't fail
silently.

## Parameters

**Sax/Trumpet and Rhodes** share the same pipeline: find non-silent regions
above an adaptive threshold, merge nearby ones, then split anything too long
at its quietest nearby point rather than an arbitrary timestamp.

- *Silence sensitivity* — how many dB above the file's own measured noise
  floor counts as "still silence." Lower = only near-total silence breaks a
  phrase (good for Rhodes, so a chord's decay doesn't get treated as a gap).
  Higher = more readily splits on quieter moments (good for horns, so
  breaths register as phrase breaks).
- *Minimum silence to count as a gap* / *Bridge gaps shorter than* — protects
  against a short breath or the gap between chord attacks fragmenting one
  musical idea into several.
- *Minimum/preferred/maximum phrase length* — target lengths; only the
  "maximum" is a hard cap, and even then the actual cut point is chosen at a
  natural low-energy moment nearby rather than exactly at the cap.
- *Padding* — extra room left on each side of a detected phrase before
  fade/zero-crossing snapping happens.

**Drums** walks the file in preferred-length chunks, snapping each boundary
to a nearby detected transient (or the quietest nearby point if none is
found), then — if "snap to tempo grid" is on and a confident tempo was
detected — nudging that boundary onto the nearest beat line so the chop's
length is a whole number of beats.

**Export settings** (all modes): fade length and zero-crossing search window
control click protection at every cut; export bit depth is 16 or 24-bit.

All of the above are hidden behind **Auto** by default (see Features) —
they're only relevant once you switch to manual tuning. None of these
values are "correct" in some absolute sense — they're reasonable starting
points. Turn them up or down and reprocess; nothing is destructive to your
original files.

## Licensing note on essentia.js

Key and tempo detection uses [essentia.js](https://github.com/MTG/essentia.js),
loaded from a CDN, which is licensed **AGPL-3.0**. That's a network-copyleft
license: if you deploy an app using it publicly, the corresponding source
must be available to anyone who uses it over the network. A public GitHub
Pages repo (source visible in the repo that serves the Pages site) already
satisfies that. It's worth knowing about if you ever want to keep a fork of
this app closed-source — in that case, dropping essentia.js for a
permissively-licensed alternative (e.g. a standalone BPM-detection library)
would be the way around it, at the cost of losing key detection specifically
(BPM-only alternatives are easier to find than good in-browser key detection).
See `THIRD_PARTY_NOTICES.md` for the full breakdown, and `LICENSE` for this
repo's own (MIT) license.

## Testing

The core detection algorithms, the WAV/AIFF codec, and the folder/file
grouping logic are pure functions with no browser dependencies, so they're
unit-tested with plain Node:

```
node test/dsp.test.mjs
node test/io-fs.test.mjs
```

There are also two optional browser-integration tests that exercise the
real essentia.js/JSZip pipeline and the actual page's DOM in a real browser
(requires the `playwright` package):

```
npm install --no-save playwright && npx playwright install chromium
npx http-server -c-1 . -p 8877 &
node test/run-smoke.mjs
node test/run-ui-check.mjs
```

## Known limitations / natural next steps

- Analysis runs on the main thread. It yields between files so the page
  stays responsive, but a very large batch (hundreds of long files) will
  feel slower than a native app; moving analysis into a Web Worker is the
  natural next step if that becomes a problem.
- Zero-crossing snapping uses a single reference (the mono mix) so all
  channels of a stereo file cut at the same sample — this keeps channels
  aligned but means the snap isn't independently optimal per channel.
- Folder permissions (File System Access API) aren't remembered across page
  reloads — you'll need to re-add folders each session. Persisting handles
  via IndexedDB is possible but wasn't built in this pass.
- Drum onset detection is still a single full-spectrum energy curve — a
  multi-band version (separating kick/snare/hats) would likely improve
  boundary accuracy further on busy breaks.
