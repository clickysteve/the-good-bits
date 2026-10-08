# Design language

Good Bits is one of a collection of independent browser instruments, with
emmm, FrakMC, Feelers and ANVIL. The principle is **same designer, same
instrument family, different instrument**: someone moving between them should
recognise the controls, frames and states at once, while each instrument's
interface stays shaped by its own job. Good Bits' job is sample processing,
so its waveforms, not its chrome, are the centre of the screen.

This page records the shared conventions Good Bits follows and what stays its
own. It was written when Good Bits adopted the collection look (October 2026),
after comparing the emmm, FrakMC and Feelers repositories. Feelers keeps a page
like this one (its `docs/DESIGN.md`); the two describe the same conventions
from each instrument's side, and neither depends on the other.

All of it is implemented in `css/style.css`, which draws only through the
custom properties in its `:root` block. `test/contrast.test.mjs` checks every
text role against its surface (4.5:1 minimum).

## Shared with the collection

- **Ink on paper.** A light ground (the desktop), lighter panels (paper), one
  near-black ink for frames, text and fills. Colour is never decoration.
- **Square geometry.** No rounded corners anywhere, including chips and pills.
- **Hard frames and shadows.** 1.5-2px ink frames; panels and windows cast a
  3px hard offset shadow, primary and transport buttons 2px. No blur, no
  gradients, no glow.
- **Selection is inversion.** On, active and selected controls are ink with
  paper text: segmented buttons, chips, mode cards, the chosen character.
- **Two title treatments.** A solid ink strip with tracked capitals marks a
  section (settings rail, log, inspector). A pin-striped bar with the title
  knocked out in a paper box marks a window (every workspace panel), after
  FrakMC's GEM title bars.
- **Compact type.** The system monospace only, at 10-13px. Labels are small,
  uppercase and letter-spaced; values and file names are bold. No web fonts:
  the app renders the same offline.
- **Restrained signal colour.** Yellow = selected, queued or overridden.
  Green = playing / running. Red = danger, mute, errors. Amber = warnings.
  Each signal is one colour, used the same way on every screen.
- **Readouts.** Measured or derived values the musician reads rather than
  edits (ratios, detected values, the naming preview, seeds, the conform line)
  sit in green-on-black LCD boxes, as in Feelers.
- **Controls.** Mutually exclusive choices are segmented buttons sharing one
  frame. Selects are framed white wells with emmm's pop-up triangle. Check
  boxes are GEM squares, filled when on. Sliders are a framed white trough with
  a solid ink thumb.
- **Interaction states.** Press = a 1px (2px for shadowed buttons) nudge into
  the shadow. Focus = a 3px selection-yellow ring. Disabled = 40% opacity.
  Drag-over = emmm's 12.5% dot screen. Muted or excluded = a diagonal hatch.
  Busy = a stepped two-state blink, never a fade.
- **Dialogs.** In-app only. A double frame (ink, paper gap, ink) with a hard
  offset shadow over a dot screen; no blur. The default button has the heavier
  frame and shadow.
- **Transport and bars.** The action that does the work (PROCESS, GENERATE,
  NEW, play) is the default button: heavier frame plus shadow, never a colour
  fill, since fill means "selected" here. Bottom bars keep transport and
  "write files" actions apart with a 2px rule.
- **Density over layout.** An instrument panel, not a web page: dense, framed,
  everything visible, no cards-with-whitespace or hero areas.

## Palette roles

Good Bits' role names predate the collection; this is how they map. Adopting
a shared palette system later means remapping this block, not the stylesheet.

| Collection role | Good Bits token | Used for |
| --- | --- | --- |
| desktop | `--bg` | ground behind panels (with the `--dot-grid`) |
| paper | `--bg-panel` | panels, buttons, inverted text on ink |
| (well) | `--bg-raised` | inputs, waveform wells, raised rows |
| ink | `--ink`, `--text`, `--border` | fills, text and frames (one colour, three jobs) |
| dim | `--text-faint`, `--text-dim` | labels, hints, secondary values |
| selection | `--selection` | selection, focus, queued, overridden |
| activity | `--good` | playing, solo, success |
| warning | `--warn`, `--danger` | warnings; errors, mute |
| (text on a signal fill) | `--on-signal`, `--on-accent` | white on green, red, orange |
| (readout) | `--lcd-bg`, `--lcd-text` | LCD readouts |
| (soft) | `--soft`, `--accent-dim` | badge fill, inactive marker tags |

## Good Bits' own

**Source → analysis / transformation → audible result → export.** Every
workspace is laid out along that line, and the waveform is the largest, most
contrasted thing in it. The chrome stays monochrome so the audio reads first.

- **Waveforms** are ink on a white well (`--wave-bg`, `--wave-fill`), framed
  like any other well. They are drawn on canvas from the `--wave-*` tokens, so
  they follow the palette.
- **Waveform colour carries information only:**
  - slice / cut markers: orange (`--wave-marker`, `--accent`);
  - playhead and the selected marker: blue (`--wave-handle`, `--accent-2`);
  - the selected region or fragment: selection yellow (`--wave-region-sel`);
  - alternating chop regions and beat / bar grid: faint ink washes
    (`--wave-region-a/b`, `--wave-grid`, `--wave-grid-bar`);
  - the played part of a PLAY NICE mix: orange over the ink.
- **Transformation intensity** is a four-step ramp (`--heat-1` ... `--heat-4`,
  paper grey to orange to red), shown as the heavy top edge of a STRETCH FX
  card, with its word (`MELTING`, `MALFUNCTION`) in orange. Never used as text
  colour on its own.
- **Workspace structure.** CHOP / STRETCH / BOTH share a settings rail and a
  result stage; PLAY NICE, FLIP, STRETCH FX and LAB are self-contained
  workspaces of windows with their own bottom bar. Each window has the
  pin-striped title bar with a summary on the right.
- **Rows you click down.** FLIP variations, PLAY NICE loops and kept LAB
  mutants are framed rows. FLIP's waveforms share one time axis; its playing
  row gets a green edge and a stale one is hatched. A soloed PLAY NICE loop
  gets the same green edge; a muted one is hatched.

## When adding to Good Bits

Use an existing role before adding a colour; add a token before writing a
literal; give any new text role a pairing in `test/contrast.test.mjs`. If a
class sets `display`, add a `[hidden] { display: none; }` rule for it whenever
the JS hides it with the `hidden` attribute (`test/hidden-attribute.test.mjs`).
