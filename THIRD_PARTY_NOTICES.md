# Third-party notices

This repository's own code (everything under `js/`, `css/`, `index.html`) is
original work, licensed under MIT — see `LICENSE`. It is a from-scratch
rewrite: no code was carried over from any earlier prototype, so nothing in
this repo has any provenance question tied to prior work.

Two third-party libraries are loaded at **runtime, from a CDN**, as declared
in `index.html`. Neither is vendored into this repository — nothing of theirs
is committed here, only a URL pointing at their own hosting.

## essentia.js

- **What it's used for:** key and tempo (BPM) detection (`js/essentia-bridge.js`).
- **License:** [AGPL-3.0](https://github.com/MTG/essentia.js/blob/master/LICENSE.txt).
- **Source:** https://github.com/MTG/essentia.js
- **Loaded from:** `https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/...`

AGPL-3.0 is a network-copyleft license: anyone who uses a service built with
AGPL-licensed code over a network must be able to get the corresponding
source of that service. This repository is intended to be a public GitHub
repo powering a public GitHub Pages site — the complete source (this repo)
is already freely available to anyone who uses the deployed page, which is
exactly what AGPL requires. There's nothing extra to do as long as the repo
stays public.

If this project is ever forked into something closed-source, or distributed
in a context where the source *isn't* publicly available, essentia.js would
need to be removed or replaced at that point (dropping key detection, since
permissively-licensed key-detection libraries for the browser are hard to
come by) — see the note in `README.md`.

## JSZip

- **What it's used for:** bundling chops into a single downloadable ZIP, only
  in browsers without the File System Access API (`js/io-fs.js`).
- **License:** [MIT](https://github.com/Stuk/jszip/blob/main/LICENSE.markdown) (dual MIT/GPLv3, MIT terms used here).
- **Source:** https://github.com/Stuk/jszip
- **Loaded from:** `https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js`

MIT is fully permissive — no obligations beyond keeping its own copyright
notice intact, which stays inside the library file itself and isn't
something this repo needs to do anything about.
