<div align="center">

<img src="docs/screenshots/icon.png" width="96" alt="duru icon">

# duru (두루)

**Edit like a word processor. Save clean Markdown.**

A local-first Markdown document editor · Tauri 2

[한국어](README.md) · [Full syntax coverage table](FEATURE_MAP.md) · [Build log](#build-log)

</div>

<div align="center">
<img src="docs/screenshots/editor.png" width="820" alt="duru editing screen">
</div>

---

## Why this exists

As teams move their documents to Markdown, the people who *don't* know Markdown
stop being able to edit them. Someone tries to add a row to a table, deletes a `|`
by accident, and the whole document breaks. So nobody touches it again.

Reaching for a WYSIWYG editor creates the opposite problem:
**it silently deletes syntax it doesn't understand.** The content was never visible
on screen, so the user never notices it's gone.

duru aims between the two. No `**` or `|` on screen, and the file on disk stays
ordinary, human-readable Markdown.

## One promise

> **Edit it like a word processor, and nothing that was in the document disappears.**

That isn't an aspiration — it's a measurement.
All **65 items** from the Markdown Guide (Basic + Extended + Hacks) were run through
the actual conversion pipeline and round-tripped: **zero loss.**

Syntax the editor can't manipulate (footnotes, definition lists, and so on) is not
discarded either. It's frozen into a read-only block, preserved verbatim, and written
back byte-for-byte on save.

Per-item grades (creatable / editable / preserved-only) are all in [FEATURE_MAP.md](FEATURE_MAP.md).

## What it does

| | |
|---|---|
| **Tables** | Insert from the toolbar, click a cell and type, add/remove rows and columns, arrow-key navigation |
| **Formatting** | Bold, italic, underline, strikethrough, inline code (`Ctrl+B` `Ctrl+I` `Ctrl+U`) |
| **Lists** | Bullet, numbered, and to-do. `Tab`/`Shift+Tab` to nest; checkboxes toggle on click |
| **Paste** | `Ctrl+V` keeps formatting from Word, the web, and Google Docs; `Ctrl+Shift+V` parses the clipboard as Markdown |
| **Images** | Drop a file in — it's copied to `assets/` and linked by relative path |
| **Versions** | Save a snapshot of a document and see what changed, side by side |
| **Languages** | Korean · English (switchable in settings) |
| **Themes** | Light · Dark · Follow system |

### Two modes

- **Document mode** — one document at a time. Folder structure is hidden; you get a flat file list.
- **Studio mode** — many documents in tabs, with the folder tree visible.

You pick one on first launch and can switch any time in settings.

### Version control without knowing Git

If the folder is already a Git repository, a version bar appears at the bottom.

- **Save version** — record the current state
- **History** — how this document has changed over time
- **N documents changed** — what you've touched since the last save

<div align="center">
<img src="docs/screenshots/versions.png" width="820" alt="What changed — only the edited line differs">
</div>

Change one word and **only that line** shows up as changed. That's what the normalization
pass buys you — see [How it's built](#how-its-built) below.

The words *commit*, *diff*, and *staging* appear nowhere in the interface.
Only `.md` files and the `assets/` folder are ever touched, and **duru never creates
a repository for you.**

## Running it

> There's no installer yet. You'll need to build it.

You'll need [Node.js](https://nodejs.org) 20.19+ (or 22.12+), [Rust](https://rustup.rs) 1.77+, and a system
`git` if you want the version features.

```bash
npm install
npm run tauri dev             # run in development mode
npx tauri build --no-bundle   # build the executable only
```

The binary lands at `src-tauri/target/release/duru.exe`.

Developed and tested on Windows 11. Tauri should build on macOS and Linux too, but
that hasn't been verified.

## How it's built

| Area | Choice |
|---|---|
| Shell | Tauri 2 (Rust) |
| UI | Vanilla JS — no framework |
| Text input | ProseMirror (IME composition, cursor, undo) |
| Markdown parsing | remark / unified |
| The layer between | Written from scratch (`schema.js` `convert.js` `md.js` `normalize.js`) |
| Version control | System `git`, invoked with argument arrays |

**Why the conversion layer is hand-written** — keeping the "nothing disappears" promise
meant owning exactly what gets preserved and how. That decision *is* the product, so it
couldn't be delegated to an off-the-shelf library.

**The "it makes the file messy" problem** — WYSIWYG editors rewrite a document in their
own style on save, so changing one word marks the entire file as modified.
duru **normalizes the whole document once, when it's first opened.** After that,
serialization is deterministic: untouched regions are reproduced byte-for-byte.
It's the same shape as introducing a code formatter — one large first commit, quiet ones after.

## Build log

The week-by-week notes written during development are kept as they were — decisions,
the reasoning behind them, and the calls that turned out wrong. *(Korean)*

- [SPEC_v0.1.md](docs/SPEC_v0.1.md) — the spec, cut down to what would actually ship
- [WEEK1.md](WEEK1.md) · [WEEK2A.md](WEEK2A.md) · [WEEK3.md](WEEK3.md) · [WEEK4.md](WEEK4.md) — weekly work
- [FEATURE_MAP.md](FEATURE_MAP.md) — measured results across 65 syntax items
- [MODE_PLAN.md](MODE_PLAN.md) — why there are two modes
- [RESULT.md](RESULT.md) — verification results

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free to use and modify for any
noncommercial purpose.
