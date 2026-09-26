# zsync

A Zotero plugin that keeps a Typst project in step with a Zotero collection.
Right-click a collection, choose **Export to zsync Project**, and zsync writes
into the project folder:

- `refs/annotations.json`: every item (keyed by citation key) and every
  highlight, underline, note, text, image and ink annotation (keyed by
  annotation key), with its exact text, your comment, colour, tags, page and
  position, and a `zotero://` link that opens Zotero at it. For highlights in
  saved email threads it also records which message in the thread holds the
  sentence (sender, sent time, signoff).
- `refs/zsync.bib`: the bibliography, through Better BibTeX's Better BibLaTeX
  (or Zotero's own BibLaTeX exporter when Better BibTeX is not installed).
- `refs/zsync/sources/`: copies of the annotated PDFs and snapshots.
- `refs/zsync/images/`: PNGs of image and ink annotations, which Zotero
  renders without you opening the PDF.

A file is only rewritten when its content changes, so exporting twice changes
nothing and git diffs stay small. Devices without Zotero compile from these
files. The full format is in [docs/SCHEMA.md](docs/SCHEMA.md).

Works with Zotero 9 and 10 on Windows, macOS and Linux (tested on Zotero
10.0.3 on Windows; checked against the 9.0.6 source).

## Install

1. Build the plugin: `node scripts/build.mjs` (writes `dist/zsync-<version>.xpi`).
2. In Zotero: **Tools → Plugins**, the gear menu, **Install Plugin From File…**,
   and pick the `.xpi`.

## Use

**Link a collection to a project folder.** Right-click the collection,
**Link zsync Project Folder…**, and pick the Typst project's folder. zsync
writes a `zsync.json` there naming the collection, remembers the folder on
this device, and exports.

**Export.** Right-click the collection, **Export to zsync Project**. **Tools →
Export All zsync Projects** exports every linked folder. A small window reports
how many files changed and any warnings (for example a PDF that is not on
this device).

**Export automatically.** In **Settings → zsync**, tick *Export a project a few
seconds after anything in its collection changes*. A new highlight, an edited
comment, an item added to or removed from the collection, or a change synced
from your phone is exported about five seconds later (after the sync
finishes). This setting is per device.

**Another device.** The project folder carries its `zsync.json`, so on another
computer open **Settings → zsync → Add Existing Project Folder…** and pick the
folder; or right-click the same collection and link the same folder.

**Settings** lists the project folders on this device with the result of the
last export, and has Export, Show and Unlink buttons for each.

### Unlinking, renaming and moving folders

- **Unlink.** Right-click the collection, **Unlink zsync Project Folder…**, or
  use **Unlink…** in Settings. You choose how far to go: *Stop Exporting*
  (the folder keeps its files), or *Stop and Delete zsync's Files*, which
  deletes what zsync wrote there. Tick *Also delete zsync.json* to remove the
  folder's zsync settings too, with either button. zsync only deletes files
  listed in its manifest whose content is still exactly what it wrote;
  anything you edited is kept and listed, and a file another program has
  open is reported and can be retried. Your own files and the folder itself
  are never deleted, and directories that zsync's files leave empty are
  removed.
- **Renamed or moved.** zsync remembers which project each folder on this
  device holds (`zsync.json` carries an `id`). When a folder disappears,
  Settings shows **Find…**, and exporting the collection asks whether to
  find it, skip it or unlink it. Find searches near the old location (a few
  levels under the nearest folder that still exists) for the same project
  and offers what it finds, and you can always choose the folder yourself.
  If the folder was on a drive that is not connected, it says so instead of
  searching other drives. Nothing moves without your say-so.
- **Your own files are safe.** If a file zsync did not write sits where an
  output goes (say, an `annotations.json` you made by hand), zsync moves it
  aside to `annotations.json.zsync-backup` before writing, and tells you.
- **Changing paths in `zsync.json`.** Point `annotations`, `bib`, `sources` or
  `images` somewhere else (or switch them off) and the next export removes
  zsync's files from the old place, under the same rule: only files still
  exactly as zsync wrote them.

### `zsync.json`

Only `collection` is required; see [docs/SCHEMA.md](docs/SCHEMA.md) for every
setting. Useful ones:

```json
{
  "zsync": 1,
  "collection": "P6MLNJX9",
  "recursive": true,
  "bib": null,
  "copySources": "none"
}
```

- `recursive: true` includes items in subcollections.
- `bib: null` skips the bibliography (for example when Better BibTeX already
  keeps one up to date).
- `copySources`: `"annotated"` (default), `"all"` or `"none"`. Copied PDFs can
  be large and private; keep them out of public repositories.

### PDFs without a parent item

A file dropped straight into a collection (a notice, a letter, a data sheet)
has no metadata in Zotero. zsync still treats it as a source: it gets an item
with a citation key, a title, a date and, where it can tell, an author, and an
entry in `refs/zsync.bib`, so its highlights can be cited like any other.
zsync reads these from a title you typed in Zotero, then from the top of the
PDF's first page, then from the file name (`2026-09-04_Source_[Title]_(id).pdf`),
then from the PDF's own metadata, and records in `inferred` which fields it
guessed.

**Letters are recognised.** A PDF that starts like a letter ("Dear …" or
"Good afternoon", or `From:`/`To:` lines, with a date, a `Letter 101`
heading or a `Re:` line, and a closing such as "Yours sincerely") becomes a
Zotero-style `letter` item: dated, titled, with the writer as author and the
addressee as recipient, and an `@letter` bib entry. A printed email becomes an
`email` item dated with its sent time.

To correct or pin anything, add it to `zsync.json`:

```json
"documents": {
  "7XK2M4PQ": { "citekey": "notice2026", "type": "letter", "title": "Room Inspection Notice", "author": "Village Office", "recipient": "Sam Resident" }
}
```

(the attachment key is in `refs/annotations.json`, or Zotero's item pane).
Cite them from `refs/zsync.bib`, which holds both Better BibTeX's entries and
these. `"standalone": "attachments"` turns this off.

### In Typst

```typ
#let z = json("/refs/annotations.json")
#let a = z.annotations.at("HLMAILAA")
#quote(attribution: a.message.from)[#a.text]
```

For a template that already understands the Better BibTeX JSON export (such
as the transcript template), add one branch to its loader:

```typ
#let zotero-library(data) = if data.at("zsync", default: none) != none {
  (items: data.items, annotations: data.annotations)
} else {
  // ...the existing Better BibTeX JSON path...
}
```

## Check a collection without installing anything

[stage0/probe.js](stage0/probe.js) is a read-only script for **Tools →
Developer → Run JavaScript** (tick *Run as async function*). With one
collection selected it reports what zsync would find there: citation keys,
attachment types, annotation types and positions, missing files, image
caches and the available export translators.

## Development

Requirements: Node 22+ and Zotero installed. Nothing to `npm install`.

```bash
node test/unit.mjs                                  # pure functions, no Zotero
node test/zt.mjs start --bbt                        # isolated Zotero on port 23124
node test/fixtures/make-fixtures.mjs && node test/seed.mjs
node test/e2e.mjs                                   # end-to-end, against that Zotero
node test/zt.mjs stop
```

`test/zt.mjs` starts a second, throwaway Zotero (its own profile and data
directory under `.zt/`, never your library) with the plugin loaded straight
from `plugin/` and a small dev-only bridge (`test/devbridge/`) that lets the
tests run JavaScript inside it. Restart it after editing plugin code.
`--bbt` copies Better BibTeX from your real profile into the test profile.

### Releasing

1. Bump `version` in `plugin/manifest.json`.
2. `node scripts/build.mjs` builds the `.xpi` and rewrites `updates.json`
   with its version, download link and SHA-256.
3. Publish the `.xpi` as a GitHub release asset named as in
   `scripts/release.json`, and push `updates.json`.

Every installed copy checks `update_url` (in `plugin/manifest.json`) for
updates, which points at `updates.json` on this repository's `main` branch.

### When Zotero releases a new major version

Run the end-to-end tests against it; if they pass, raise
`strict_max_version` in `plugin/manifest.json` (currently `10.*`) and
release. A compatibility-only change can also be published by editing the
`strict_max_version` in `updates.json` without a new `.xpi`.

## Not done yet (Stage 3)

- **Highlight crops.** Zotero renders PNGs only for image and ink
  annotations. Zotero 10's PDF worker has a private `pdf.renderArea` action
  that renders any rectangle of a page (with rotation and CropBox handled);
  Zotero 9 has no equivalent. Rects in `annotations.json` are absolute PDF
  user-space points (origin bottom-left, unrotated, including any CropBox
  offset), so cropping in Typst needs each page's box and rotation, which
  only Zotero 10's `Zotero.SDT` exposes, at a cost.
- **Downloading missing files.** zsync never downloads attachment files;
  a file Zotero has not downloaded on this device is reported as a warning.
