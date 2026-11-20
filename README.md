# pi-petty

Ten terminal companions for pi coding agents. Your pet walks above the editor, catches crumbs of streaming assistant text, and naps after a meal. Petty runs standalone: it owns the pet widget, the main-session food stream, and `/petty` — and nothing else.

Works with [earendil-works/pi](https://github.com/earendil-works/pi) (`pi`) and [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`). Pets make no model or network calls.

## Install and start

### pi

Install from the public repository:

```bash
pi install https://github.com/5c0r/pi-petty
```

Or install a checkout:

```bash
git clone https://github.com/5c0r/pi-petty.git
pi install ./pi-petty
```

### oh-my-pi

Clone and link the extension:

```bash
git clone https://github.com/5c0r/pi-petty.git
mkdir -p ~/.omp/agent/extensions
ln -s "$(pwd -P)/pi-petty" ~/.omp/agent/extensions/pi-petty
```

If that registration already exists, inspect it first. Do not overwrite a real directory or unrelated extension. For an active profile or custom agent directory, use its `extensions` directory instead.

Restart `pi` or `omp`, then run `/petty`. Opening the preview sends no model request — Petty never sends any.

To exercise a local checkout without installing it, launch it directly from its parent directory:

```bash
pi --no-extensions -e ./pi-petty/index.ts
omp --no-extensions -e ./pi-petty/index.ts
```

Both hosts load `index.ts` directly. No build step or separate runtime dependency install is needed.

To uninstall from Pi, inspect `pi list` and run `pi remove <source>` with the registered Git URL or checkout path. For OMP, remove only the Petty registration symlink. Keep unrelated registrations and the checkout.

### Existing preferences

Petty keeps preferences at `<agentDir>/fireside-pet.json`. Existing files retain all supported settings. The legacy `placement` key is silently ignored on load, with no warning, migration, or file rewrite. Explicit menu **Save** omits that key.

## Ten terminal companions

The pet occupies a small strip above the main editor. It does not replace the editor or take keyboard focus.

| Name | Species |
|---|---|
| Miso | Cat |
| Toast | Corgi |
| Mochi | Slime |
| Ember | Dragon |
| Pip | Bunny |
| Soba | Fox |
| Pebble | Capybara |
| Waddles | Penguin |
| Sprout | Turtle |
| Nori | Axolotl |

Each has walking, idle/blinking, and sleeping poses. These are actual compact walking frames from [`pet-data.ts`](./pet-data.ts):

```text
Miso      =^.^=/>
Toast     U(o w)/u~
Mochi     (o_o)~
Ember     ~(o)>/\
Pip       (\(^.^)/>
Soba      ^<o.o>/~~
Pebble    n( ._.)_/>
Waddles   \(o>)_/
Sprout    ~/(==)\o
Nori      }(o.o){/~
```

Full-size sprites use three rows. Miso's first full walking frame:

```text
 /\_/\
( o.o )~
 /| |\
```

### Customize and save

Open `/petty`. Use **↑/↓** to choose a control, **←/→** to change a choice, and **Enter** to activate an action or edit a name/path.

| Setting | Choices |
|---|---|
| Pet | Any built-in companion or a local custom sprite |
| Name | Safe text, up to 24 characters |
| Color | Theme, amber, mint, rose, sky, lavender |
| Size | Compact (one row), full (three rows) |
| Speed | Slow, normal, fast |
| Personality | Calm, playful, sleepy |
| Motion | Animated, static, hidden |
| Food rain | On, off |
| Custom sprite file | Local JSON path; an absolute path is recommended |

**Random pet** selects a different built-in, never a custom file. **Random color** selects a different curated color; theme color remains a manual choice. **Surprise me** changes both while preserving other settings. Enter rerolls without closing the menu. The **`r`** shortcut triggers Surprise me outside name/path edits; inside an edit, it is ordinary text. These actions select local catalog entries and colors, not AI-generated sprites.

Default names follow the selected species. Accepting a Name edit makes it custom, even if the text is unchanged. A custom name survives pet changes, random rolls, Save, and restart.

All changes are previews until **Save preferences** succeeds. Save persists the exact selection; startup never rerolls it. **Escape** outside an edit discards the preview and restores the original settings, loaded sprite, position, animation frame, and food state. While editing a name/path, Enter accepts that field and Escape cancels that edit; neither saves preferences.

The default is Miso with calm personality, theme color, full size, slow speed, animated motion, and food rain on. The pet turns at edges, pauses on observed input activity, sleeps after inactivity, and wakes on replies. Static mode has no animation timer; hidden mode removes the sprite. The main widget and settings preview share one animation.

Small terminals use compact art and safe clipping. Unicode names remain in preferences, but only printable ASCII names appear beside the sprite. Input observation does not inspect editor text, consume keys, or save typed input; modal input can also trigger it, while some host-captured gestures bypass observation.

### Streaming crumbs

Only **visible assistant text deltas** from the main conversation become food. Thinking, tool output, whole-message snapshots, terminal controls, and unsafe glyphs do not. There is no food generation while idle.

- Crumbs are **1–3 ASCII columns** wide. The food world holds at most **10 pieces**, including the piece being munched, with **two spawns per second**. Skipped deltas are discarded, not queued.
- Food falls and lands within the pet strip. The pet chooses the nearest reachable grounded piece, runs toward it, then munches with a crumb effect and a brief `nom`. Chasing does not change your saved speed.
- After **five pieces**, the pet pauses satisfied, then takes a protected **six-second digestion nap**. Replies cannot interrupt that nap, and new food does not spawn while satisfied or digesting.
- Grounded food stays until eaten rather than expiring during rest. Falling pieces finish landing, and the pet resumes chasing leftovers after waking without needing another text delta.
- Observed input pauses movement and rejects new food for **1.5 seconds**. Existing food keeps falling. Static/hidden motion, food rain off, and noninteractive modes stop sampling.
- Compact and full views share one food world without changing each other's fall timing. Losing all drawable pet space clears transient food and stops sampling until space returns; resizing can remove pieces beyond the remaining width. A zero-space view does not erase food in another drawable view.

Toggle **Food rain** in `/petty`. Preview cancellation restores cosmetic food state without rewinding the control-sequence parser. Food sampling never changes the actual chat text.

### Custom sprites
Create a local JSON file, select **Pet: custom**, set **Custom sprite file**, and Save. Custom sprites are inert data with no scripts, imports, or network requests.

```json
{
  "version": 1,
  "label": "Robot",
  "compact": {
    "walking": [["[o_o]>"], ["[o-o]>"]],
    "idle": [["[o_o]"], ["[-_-]"]],
    "sleep": [["[-_-] z"]]
  },
  "full": {
    "walking": [
      [" /\\ ", "[o_o]", " / \\"],
      [" /\\ ", "[o-o]", " \\ /"]
    ],
    "idle": [
      [" /\\ ", "[o_o]", " / \\"],
      [" /\\ ", "[-_-]", " / \\"]
    ],
    "sleep": [["    ", "[-_-]", " z z"]]
  }
}
```

The schema requires `version: 1`, a safe nonempty label of at most 32 characters, and both `compact` and `full` sets. Each set needs `walking`, `idle`, and `sleep`, with 1–8 frames per pose. Compact frames have exactly one row; full frames have exactly three. Rows must be printable ASCII, at most 32 columns, with visible content in every frame. The loader rejects terminal controls, wide glyphs, malformed UTF-8, and files over 64 KiB. It pads rows per pose and mirrors walking frames for leftward movement.

## Privacy and performance

Pets are local animation: no model calls, network traffic, telemetry, sound, or microphone. Petty uses public interactive TUI APIs and does not mount in RPC/print modes. One animation timer serves the main widget and preview, and bounded food sampling retains only short crumb glyphs and parser state, not whole replies or control payloads.

Pet preferences are stored in `fireside-pet.json` under the active host's agent directory, normally `~/.pi/agent` or `~/.omp/agent`. Active profiles and `PI_CODING_AGENT_DIR` are honored; the path is resolved lazily at first use.

Only Save writes pet preferences. Invalid settings produce a warning and safe defaults. Invalid custom sprites produce a warning and a built-in fallback; the menu refuses to save an invalid custom selection. Pet errors escape terminal controls and display-spoofing characters before display.

## Development and runtime compatibility

```bash
cd pi-petty
bun run test
bun run typecheck
git diff --check
```

There is no build script. The package manifest registers `./index.ts` as a Pi extension; both hosts load TypeScript directly. Imports use host-provided `@earendil-works/pi-coding-agent` and `pi-tui` packages; OMP resolves those imports through its scope aliases. Behavioral tests cover pets, food, persistence, legacy-settings compatibility, preview rollback, teardown, and main-session streaming; runtime changes also need interactive smoke checks on both hosts.
