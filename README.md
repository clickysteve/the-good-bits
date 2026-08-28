# The Good Bits

**Live app: https://clickysteve.github.io/the-good-bits/**

Point it at folders (or individual files) of long source recordings - solo
horns, Rhodes, drum breaks - and it finds candidate musical phrases for you
to audition and load into hardware samplers later. It does **not** try to
replace your own chopping/sampling decisions; it's a fast first-pass editor.

Everything runs client-side: no server, no upload, nothing leaves your
browser. That's also what makes it possible to host for free as a static
site on GitHub Pages.

## Features

- **A choice of interface styles.** The three buttons top-right (Classic,
  Terminal, Console) swap the whole page's look on the fly, restyling the
  actual controls rather than just recoloring them: Classic is the default,
  Terminal turns buttons and checkboxes into bracketed `[ ]` ASCII-style
  text on a scanlined CRT-green screen, and Console turns them into chunky
  red/blue hardware buttons and toggle switches on a beige-grey chassis
  with rack ears down each side, after a classic rack sampler. Purely
  cosmetic (nothing about detection or export changes), and your choice is
  remembered in this browser.
- **Auto or manual detection settings.** Auto mode (on by default) just uses
  sensible defaults per mode, so you don't have to make any decisions to get
  started - flip it off if you want to hand-tune silence sensitivity, phrase
  length targets, fade/click protection, and so on.
- **Loudness-adaptive silence detection.** Instead of one fixed volume
  threshold for every file, each recording's own noise floor is measured and
  the threshold is set relative to it - so quiet and hot recordings both
  behave sensibly.
- **Auto key and tempo detection** (via [essentia.js](https://mtg.github.io/essentia.js/), see licensing note below), shown per source file and baked into the output folder/file name.
- **Tempo-locked drum chopping, in bars.** Choose a chop length in bars (1,
  2, 3, 4, 6, 8, 16…) and it's converted to seconds from the detected tempo,
  then boundaries snap to the beat grid so chop lengths are exact and loop
  cleanly. If tempo isn't confidently detected on a drums-mode file, you get
  a warning and a choice: continue with a fixed fallback length, or skip
  that file - with an option to apply your choice to the rest of the batch.
- **Waveform previews.** Each processed file gets a waveform in the results
  panel with its chop boundaries and any one-shot hits marked, so you can
  see at a glance how the auto-detection carved it up before you go
  digging through the audio players.
- **Manual chop and one-shot editing.** Click **Edit chops** or
  **Edit one-shots** on any processed file to open its waveform for
  editing: drag the start/end handles to adjust cut points (they snap to
  the nearest zero-crossing when you let go, same as an export), scroll
  or use the zoom buttons to get in close, drag the waveform to pan once
  you're zoomed in, then **Save & re-export** to re-cut just that file
  with your adjustments. Editing chops and one-shots are independent -
  saving one never discards the other. This is drag-only for now - adding
  or removing regions isn't supported yet.
- **Chop into pieces is itself optional.** Untick **"Chop into pieces"** at
  the top of the Mode panel to skip chopping entirely - key/tempo
  detection, the `wav/` copy, and time-stretch/lo-fi processing all still
  run on the whole file, just nothing gets cut up. Useful when all you
  want is a stretched and/or lo-fi'd copy of a full recording. Chop,
  time-stretch, and lo-fi processing are otherwise independent switches -
  use any one, any two, or all three together.
- **Optional time-stretch.** Stretch chops on export while preserving
  pitch, either by matching every file to one target tempo (handy for
  normalizing a batch to a single BPM) or by a fixed stretch ratio applied
  to everything. Five "character" presets trade off cleanliness for
  vibe: Clean is a transparent stretch, Vintage adds the grainy warble of
  a 90s hardware sampler, Glitch pushes that further into metallic,
  low-bit territory, Warped uses short choppy grains for a wobbly,
  broken-pitch feel, and Crushed keeps smooth grains but bit-crushes
  harder than Glitch. Applies to the main chops, and also produces a
  separate processed copy of the full source track in `wav/` (see
  **Lo-fi character** below for how that file gets named when both
  time-stretch and lo-fi processing are on) - handy for dropping the
  whole recording into a sampler at the target tempo. One-shots are left
  unstretched, and a file with no confident tempo detected exports
  unstretched in target-tempo mode.
- **Optional lo-fi character.** Three independent, stackable stages
  (applied in this order): an **output-stage character** modeled on
  tape/vinyl/radio/broadcast-chain coloration (Cassette, Reel-to-Reel,
  Damaged, Vinyl, Boombox, AM Radio, VHS Hi-Fi, Bus Comp, Lathe, Phone
  Bus - each with its own Mix and Intensity), a **drive** saturation
  stage (Tape/Tube/Diode/Fuzz, with an amount knob), and a **crunch**
  bitcrusher (bit depth + sample-rate divide). Same export scope as
  time-stretch: applies to the main chops and to the full-track `wav/`
  copy, not to one-shots. The output-stage character presets are inspired
  by the output-stage designs in [Loop Saboteur](https://github.com/clickysteve/Loop-Saboteur),
  the author's own open-source glitch/chop plugin - ported here as
  offline, whole-buffer processing rather than a real-time audio-thread
  effect.
- **One-shot hit extraction (drums, optional).** Pulls individual
  kick/snare/hat/cymbal-type hits out of a break into their own
  `one shots/` folder, deduplicated so a loop's repeated hits don't all
  get kept, and named with plain sequential numbers (01.wav, 02.wav, ...)
  since the kick/snare/hat classification is a rough heuristic used only
  to group similar-sounding hits together, not reliable enough to trust
  in a filename.
- **Typable output naming, with a live preview.** Type your own chop
  filename pattern using `{name}`, `{tag}` and `{number}` tokens in any
  order or combination (a number is always included even if you leave
  `{number}` out of the pattern, so chops can never silently overwrite
  each other), pick the separator used inside the auto-generated
  key/tempo tag, and see an example of the resulting file/folder names
  update as you type.
- **Click-free boundaries.** Every cut point is snapped to the nearest
  zero-crossing and gets a short fade in/out, so chops don't pop at the edges.
- **Folders or individual files.** Add whole folders, or pick loose files
  directly - both feed the same pipeline.
- **Optional per-subfolder batching.** Point it at one parent folder full of
  session subfolders and have each subfolder processed as its own
  independent source (own `wav/`, own `chops/`), instead of one flat batch.
- **In-browser audition.** Every generated chop gets an inline audio player
  in the results panel - no need to dig through Finder to hear what you got.
- **A batch that survives one bad file.** If a single file fails to decode
  or analyze, it's logged and skipped; the rest of the batch keeps going.

The version number shown next to the title (e.g. `v0.8`) ticks up with each
meaningful change, so you can tell at a glance whether you're looking at the
latest build.

## Quick start

**You must serve this folder over local HTTP - do not just double-click
`index.html`.** Chrome (and other browsers) refuse to load this app's
JavaScript at all from a `file://` URL, which makes every button on the page
silently do nothing. The page will detect this and show a red banner if you
open it the wrong way. (This only matters for running it locally - the
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
**Process Batch** - untick it if you want to adjust the detection
parameters first.

If a folder you add contains several session subfolders rather than audio
files directly, tick **"Treat each subfolder as its own source"** before
adding it, and each qualifying subfolder becomes its own independent batch
entry with its own `wav/`/`chops/` output, instead of everything being
flattened into one.

For individual files: in Chrome/Edge you'll be asked to pick a destination
folder the first time (there's no way for a browser to write back next to a
loose file without asking) - that choice is remembered for the rest of the
session.

Untick **"Chop into pieces"** under the mode cards if you don't want the
file cut up at all - key/tempo detection, the `wav/` copy, and any
time-stretch/lo-fi processing you've turned on still run, just nothing
gets chopped. When it's on and Drums is the selected mode, an extra
options block appears: a **chop length** in bars (converted to seconds
from the detected tempo), and an opt-in checkbox to also pull out
one-shot hits into a `one shots/` folder alongside the usual break-length
chops.

The **Output naming** panel controls how chop files are named: type a
pattern using `{name}`, `{tag}` and `{number}` tokens (e.g.
`{name} {tag} {number}` or just `{number}`), pick the separator used
inside the auto-generated key/tempo tag, and a live preview underneath
shows exactly what that'll produce. Independent of mode. Your choices
(and most other settings) are remembered in this browser between visits.

Once a file has processed, its result card shows an **Edit chops** and/or
**Edit one-shots** button (whichever produced results) - click one to
open that set of boundaries on the waveform: drag a handle to move a cut
point (it snaps to the nearest zero-crossing when released), scroll or
use the Zoom in/out/Fit buttons to work at finer detail, and drag the
waveform itself to pan around once zoomed in. **Save & re-export** re-cuts
just that file's chops or one-shots with your edits, without touching the
other set. The optional **Time-stretch** panel (section 6) and **Lo-fi
character** panel (section 7) both apply to every export in the batch,
not per-file: turn time-stretch on, pick a mode (match a target tempo, or
a fixed ratio) and a character, and it's baked into every chop as it's
exported - including a manual re-export from the editor - plus a
full-length processed copy of each source file. The lo-fi stages
(output-stage character, drive, crunch) stack the same way and share that
full-length copy: when time-stretch and lo-fi are both on, you get one
combined `<name> stretched lofi.wav`, not two separate files.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo's Settings → Pages, set the source to the branch/folder
   containing `index.html` (root, or `/docs` if you move it there).
3. GitHub Pages serves over HTTPS automatically, which is required for the
   File System Access API and for Web Audio use - no extra configuration
   needed.

No build step, no bundler, no dependencies to install - it's a static site.

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
    wav/       <- 24-bit WAV copies of any non-WAV source (WAV sources aren't duplicated here);
                  also holds a full-track processed copy whenever time-stretch and/or a lo-fi
                  stage is on, named "<name> stretched.wav", "<name> lofi.wav", or
                  "<name> stretched lofi.wav" depending on which are active
    chops/
        <source file name> C#m 120bpm/
            01.wav
            02.wav
            ...
    one shots/                          <- only when the drums one-shot option is on
        <source file name> C#m 120bpm/
            01.wav
            02.wav
            ...
```

The `C#m 120bpm`-style tag is plain text (no brackets or commas) and is
appended to the containing folder name by default, not repeated on every
numbered chop, since key and tempo are detected once per source recording
and every chop from it shares the same tag - see **Output naming** above for
the options to change the separator, or drop the tag from the folder name
entirely. It's only added when detection actually succeeds - if key/tempo
detection is off or unavailable, names just keep their plain form.

Re-running a folder deletes and replaces its previously-generated numbered
chops and one-shots (anything you've renamed or added yourself is left
alone).

## Format support

`.wav` and `.aif`/`.aiff` are parsed by hand-written readers built into this
app, so they work identically and reliably in every browser at the source's
original sample rate and bit depth - no dependency on what the browser
happens to support natively.

`.mp3`, `.m4a`, and `.flac` go through the browser's built-in audio decoder
(`decodeAudioData`). Support for these varies a little by browser - Chrome
and Firefox are the most permissive, Safari is pickier about FLAC in
particular. If a file can't be decoded, you'll see a clear error for that
file in the log and the batch continues with everything else; it won't fail
silently.

## Parameters

**Sax/Trumpet and Rhodes** share the same pipeline: find non-silent regions
above an adaptive threshold, merge nearby ones, then split anything too long
at its quietest nearby point rather than an arbitrary timestamp.

- *Silence sensitivity* - how many dB above the file's own measured noise
  floor counts as "still silence." Lower = only near-total silence breaks a
  phrase (good for Rhodes, so a chord's decay doesn't get treated as a gap).
  Higher = more readily splits on quieter moments (good for horns, so
  breaths register as phrase breaks).
- *Minimum silence to count as a gap* / *Bridge gaps shorter than* - protects
  against a short breath or the gap between chord attacks fragmenting one
  musical idea into several.
- *Minimum/preferred/maximum phrase length* - target lengths; only the
  "maximum" is a hard cap, and even then the actual cut point is chosen at a
  natural low-energy moment nearby rather than exactly at the cap.
- *Padding* - extra room left on each side of a detected phrase before
  fade/zero-crossing snapping happens.

**Drums** walks the file in chunks sized from the chosen **chop length in
bars** and the detected tempo (falling back to a fixed length if no
confident tempo was found), snapping each boundary to a nearby detected
transient (or the quietest nearby point if none is found), then - if "snap
to tempo grid" is on and a confident tempo was detected - nudging that
boundary onto the nearest beat line so the chop's length is a whole number
of beats. *Onset sensitivity* is the one manual knob left for drums, behind
Auto like everything else.

**One-shot extraction** (drums, opt-in) finds the same onsets, trims each
hit to where it decays back toward the noise floor (or the next onset,
whichever comes first, capped around 1.2s), then sorts each hit into a
rough kick/snare/hat/cymbal/perc bucket from its low/mid/high energy
balance and duration, purely so hits that look like repeats of the same
sound can be deduplicated - keeping only the loudest few per bucket, so a
break with the same kick sample hit forty times doesn't produce forty
near-identical files. The bucket itself isn't reliable enough to trust in
a filename, so the kept hits are written out as plain sequential numbers.

**Export settings** (all modes): fade length and zero-crossing search window
control click protection at every cut; export bit depth is 16 or 24-bit.

All of the above are hidden behind **Auto** by default (see Features) -
they're only relevant once you switch to manual tuning. None of these
values are "correct" in some absolute sense - they're reasonable starting
points. Turn them up or down and reprocess; nothing is destructive to your
original files.

## Licensing note on essentia.js

Key and tempo detection uses [essentia.js](https://github.com/MTG/essentia.js),
loaded from a CDN, which is licensed **AGPL-3.0**. That's a network-copyleft
license: if you deploy an app using it publicly, the corresponding source
must be available to anyone who uses it over the network. A public GitHub
Pages repo (source visible in the repo that serves the Pages site) already
satisfies that. It's worth knowing about if you ever want to keep a fork of
this app closed-source - in that case, dropping essentia.js for a
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
node test/timestretch.test.mjs
node test/outputstage.test.mjs
```

There are also a few optional browser-integration tests that exercise the
real essentia.js/JSZip pipeline, the page's DOM wiring, and (for
`run-e2e-check.mjs`) a full process-a-file run through the actual UI, in a
real browser (requires the `playwright` package):

```
npm install --no-save playwright && npx playwright install chromium
npx http-server -c-1 . -p 8877 &
node test/run-smoke.mjs
node test/run-ui-check.mjs
node test/run-e2e-check.mjs   # needs a fixture WAV - see the file's header comment
```

## Known limitations / natural next steps

- Analysis runs on the main thread. It yields between files so the page
  stays responsive, but a very large batch (hundreds of long files) will
  feel slower than a native app; moving analysis into a Web Worker is the
  natural next step if that becomes a problem.
- Zero-crossing snapping uses a single reference (the mono mix) so all
  channels of a stereo file cut at the same sample - this keeps channels
  aligned but means the snap isn't independently optimal per channel.
- Folder permissions (File System Access API) aren't remembered across page
  reloads - you'll need to re-add folders each session. Persisting handles
  via IndexedDB is possible but wasn't built in this pass.
- Drum onset detection (for chop *boundaries*) is still a single
  full-spectrum energy curve - a multi-band version would likely improve
  boundary accuracy further on busy breaks.
- One-shot classification is a simple band-energy/duration heuristic, not a
  trained model - it's a reasonable sort for kick/snare/hat/cymbal-ish
  sounds for grouping repeats, but will mislabel unusual or layered hits;
  that's why it's used internally for dedupe only and never shown in a
  filename. Always worth a quick listen through the `one shots/` folder.
- The manual editor (chops and one-shots) only lets you drag existing
  boundaries - adding or removing regions isn't supported yet.
- Time-stretch and the lo-fi stages are each one setting for the whole
  batch, not per-chop; proper per-chop controls would need the editor
  built out further first.
