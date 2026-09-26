# zsync file formats

zsync reads one Zotero collection and writes a snapshot of it into a project
folder. Two files define the contract: `zsync.json` (you write it, or zsync
creates it the first time you link a collection) and `refs/annotations.json`
(zsync writes it, Typst reads it).

All paths inside these files are **relative to the project folder** and use
forward slashes. In Typst, prefix them with `/` to make them independent of
the file that loads them: `image("/" + a.image)`.

## `zsync.json`: which collection, and where the output goes

Lives in the project root. Only `collection` is required.

```json
{
  "zsync": 1,
  "library": "user",
  "collection": "P6MLNJX9",
  "name": "Village housing 2026",
  "recursive": false,
  "annotations": "refs/annotations.json",
  "bib": "refs/zsync.bib",
  "bibTranslator": "Better BibLaTeX",
  "bibStripFields": ["file"],
  "copySources": "annotated",
  "sources": "refs/zsync/sources",
  "renderImages": true,
  "images": "refs/zsync/images",
  "manifest": "refs/zsync/manifest.json"
}
```

| key | default | meaning |
|---|---|---|
| `zsync` | `1` | format version |
| `id` | written when the folder is linked | a random id for this project folder, so zsync can recognise it after it is renamed or moved (copies of the folder share it); leave it alone |
| `library` | `"user"` | `"user"` for My Library, `"group:<groupID>"` for a group (the group ID from zotero.org, which is the same on every device) |
| `collection` | required | the collection's 8-character key |
| `name` | | the collection's name when it was linked; informational only |
| `recursive` | `false` | include items in subcollections |
| `annotations` | `"refs/annotations.json"` | where the annotation snapshot goes |
| `bib` | `"refs/zsync.bib"` | where the bibliography goes; `null` to skip it |
| `bibTranslator` | `"Better BibLaTeX"` | export translator, by label or translator ID; falls back to Zotero's built-in `"BibLaTeX"` when it is not installed |
| `bibStripFields` | `["file"]` | top-level fields removed from each bib entry (the `file` field holds absolute local paths that differ between devices) |
| `copySources` | `"annotated"` | copy attachment files into the project: `"none"`, `"annotated"` (only attachments that have annotations) or `"all"` |
| `sources` | `"refs/zsync/sources"` | where copies go, as `<attachment key>.<ext>` |
| `renderImages` | `true` | write PNGs for image and ink annotations (rendered by Zotero without opening the reader) |
| `images` | `"refs/zsync/images"` | where PNGs go, as `<annotation key>.png` |
| `manifest` | `"refs/zsync/manifest.json"` | bookkeeping: hashes, versions and the time of the last export that changed something |
| `standalone` | `"items"` | files with no parent Zotero item: `"items"` gives each one an item of its own, with inferred metadata and a bib entry (see [Standalone documents](#standalone-documents)); `"attachments"` lists them only under `attachments` |
| `documents` | `{}` | metadata for standalone documents, keyed by attachment key: `{ "7XK2M4PQ": { "citekey": "notice2026", "type": "letter", "title": "Room Inspection Notice", "date": "2026-09-04", "author": "Village Office", "recipient": "Sam Resident" } }`. Every field is optional; `author` and `recipient` may be lists |

Only the list of project folders is per device (a Zotero preference); everything
else travels with the project.

## `refs/annotations.json`: the snapshot Typst reads

```json
{
  "zsync": 1,
  "collection": { "key": "P6MLNJX9", "name": "zsync fixture", "library": "library" },
  "items": {
    "newman2026meeting": {
      "key": "BT5Z52BF",
      "citekey": "newman2026meeting",
      "type": "email",
      "title": "RE: [EXTERNAL] Meeting - Room inspection",
      "short-title": null,
      "date": "2026-09-21",
      "date-iso": "2026-09-21",
      "url": null,
      "creators": [{ "name": "Alex Newman", "role": "author" }],
      "extra": { "Email-Sent-ISO": "2026-09-21T16:33:00" },
      "tags": [],
      "select": "zotero://select/library/items/BT5Z52BF",
      "attachments": ["6QMFBBEU"],
      "annotations": ["HLMAILAA"],
      "standalone": false,
      "inferred": {}
    },
    "HOUSINGInspectionNotice2026": {
      "key": "7XK2M4PQ",
      "citekey": "HOUSINGInspectionNotice2026",
      "type": "document",
      "title": "HOUSING Inspection Notice for Room 12",
      "short-title": null,
      "date": "2026-09-04",
      "date-iso": "2026-09-04",
      "url": null,
      "creators": [],
      "extra": {},
      "tags": [],
      "select": "zotero://select/library/items/7XK2M4PQ",
      "attachments": ["7XK2M4PQ"],
      "annotations": ["HLNTCAAA"],
      "standalone": true,
      "inferred": { "title": "filename", "date": "filename" }
    }
  },
  "attachments": {
    "6QMFBBEU": {
      "key": "6QMFBBEU",
      "item": "BT5Z52BF",
      "citekey": "newman2026meeting",
      "title": "thread",
      "filename": "thread.html",
      "content-type": "text/html",
      "reader": "snapshot",
      "file": "refs/zsync/sources/6QMFBBEU.html",
      "open": "zotero://open/library/items/6QMFBBEU",
      "annotations": ["HLMAILAA"]
    }
  },
  "annotations": {
    "HLMAILAA": {
      "key": "HLMAILAA",
      "citekey": "newman2026meeting",
      "item": "BT5Z52BF",
      "attachment": "6QMFBBEU",
      "type": "highlight",
      "text": "bicycles are a fire hazard they may not be stored in the corridors",
      "comment": "the rule they cite",
      "color": "#ffd400",
      "tags": [],
      "page": null,
      "page-index": null,
      "sort": "00000758",
      "position": { "type": "CssSelector", "value": "#quote", "refinedBy": { "type": "TextPositionSelector", "start": 3, "end": 69 } },
      "rects": null,
      "next-page-rects": null,
      "image": null,
      "author": null,
      "created": "2026-09-25T22:58:07Z",
      "modified": "2026-09-25T22:58:07Z",
      "link": "zotero://open/library/items/6QMFBBEU?annotation=HLMAILAA",
      "message": {
        "from": "Robin Oldham <robin.oldham@example.org>",
        "sent": "Thursday, 17 September 2026 19:52",
        "sent-iso": "2026-09-17T19:52:00",
        "to": "Sam Resident <sam@example.org>",
        "subject": "[EXTERNAL] Meeting - Room inspection",
        "signoff": "Robin Oldham",
        "index": 2,
        "count": 2
      }
    }
  },
  "warnings": []
}
```

### `items`, keyed by citation key

Every regular item in the collection (and its subcollections when `recursive`),
keyed by its citation key (Zotero 8+'s native field, which Better BibTeX fills).
An item without a citation key is keyed by its Zotero item key and listed in
`warnings`.

- `type` is Zotero's item type (`email`, `document`, `journalArticle`, …).
- `title` is the title, or its equivalent for types without one (an email's
  subject, a statute's name, a case name).
- `date` is the date as entered in Zotero; `date-iso` is the parsed part of it
  (`"2025"`, `"2026-09"` or `"2026-09-17"`), or `null`.
- `creators`: `name` is "First Last", or the single-field name; `role` is
  Zotero's creator type (`author`, `recipient`, `editor`, …).
- `extra` is the Extra field parsed into `Key: value` lines, the same rule as
  the transcript template's `parse-extra`.
- `attachments` and `annotations` list keys in reading order.
- `standalone` is `true` for an item zsync made for a file without a parent
  item; `inferred` then says which fields it guessed and from where (see
  below). Both are always present, so Typst code can read them without
  defaults.

In annotations and attachments, `citekey` is always the key of their item in
`items` (or `null`), and `item` its Zotero key.

### Standalone documents

A file that sits in the collection without a parent Zotero item (a scanned
notice, a letter, a data sheet) has no citation key, title, date or author
in Zotero. With `"standalone": "items"` (the default) zsync gives it an item
of its own, whose Zotero key is the attachment's. Its type is `document`, or
`letter`/`email` when the text shows one (or whatever `documents.<key>.type`
sets). zsync also adds an entry for it to the bib: `@letter` for a letter or
email when the bib translator writes BibLaTeX (the default, Better BibLaTeX),
`@misc` otherwise, so a template can cite it like any other source. Its fields
come from, in order:

1. `documents` in `zsync.json`, for that attachment key (never marked inferred);
2. the attachment's title, if someone edited it in Zotero (`"zotero-title"`);
3. for PDFs, the text at the top of the first page (`"text"`): a **letter**
   (a greeting such as "Dear …" or "Good afternoon", or `From:`/`To:` lines,
   plus some of: a date line, a `Letter 101` heading, `Re:`/`Subject:`, a
   closing such as "Yours sincerely" with a name under it) becomes
   `type: "letter"` with its date, a title (the `Letter NNN` heading or the
   subject), the writer as `author` and the addressee as `recipient`. A
   printed **email** (`From:`, `To:`, `Sent:`/`Date:` and `Subject:`) becomes
   `type: "email"`, dated with its sent time;
4. the file name (`"filename"`), read as
   `<date>[-<hhmm>]_<source>_[<title>]_(<id>)`:
   - a leading `2026-09-04` or `2026-09-21-0100` is the date;
   - `Source_[Title]` gives an author and a title; without brackets the whole
     name is the title (underscores become spaces), and no author is guessed;
   - a trailing `_(...)`, `_OPTIMISED`, `_REDACTED`, `_SIGNED`, `_final`,
     `-ii` or `(1)` is dropped;
5. the PDF's own metadata (`"pdf"`): Title, Author and CreationDate, for
   whatever the steps above left open. Meaningless values ("Microsoft Word -
   draft.docx", "scan0001", "Administrator") are ignored.

An explicit `Source_[Title]` in the file name beats a title found in the
text; a date or writer found in a letter's text beats the file name's. The
type is `document` unless the text shows a letter or email.
`inferred.type`/`inferred.recipients` say when those came from the text.

The citation key follows Better BibTeX's `auth.lower + shorttitle(3,3) + year`
(`housingofficeTenancyRulesSummary2025`), made unique with `a`, `b`, … (the
file added to Zotero first gets the plain key). Once given, a key stays with
its document for as long as it still fits the document's title and author, so
an existing `@key` never starts pointing at another document; if a key does
change (the title changed), `warnings` says so. Set
`documents.<key>.citekey` to pin one. When a document's PDF is not on the
device doing the export, zsync keeps the description the last export found,
so the key and type do not depend on which device exported. Bib entries are
only added when the bib translator writes BibTeX/BibLaTeX; cite them from
`refs/zsync.bib`, since another bibliography file will not contain them (with
`"bib": null`, `warnings` says they have no entries).

A PDF is read at most once per device and version of the file (Zotero's PDF
worker extracts its first two pages' lines and its metadata); files over
80 MB are not read.

### `attachments`, keyed by attachment key

File attachments of those items, plus standalone files that sit directly in
the collection. `file` is the project-relative path of the copy (see
`copySources`), or `null`. `reader` is `pdf`, `epub` or `snapshot`, or `null`
for files Zotero cannot annotate.

### `annotations`, keyed by annotation key

| field | meaning |
|---|---|
| `type` | `highlight`, `underline`, `note`, `text`, `image` or `ink` |
| `text` | the highlighted or underlined text, as Zotero stored it; `null` for other types |
| `comment` | your comment, or `null` |
| `color` | `#rrggbb` |
| `tags` | tag names, sorted |
| `page` | the page label shown in Zotero (`"iv"`, `"12"`), or `null` |
| `page-index` | 0-based page number in the PDF, or `null` |
| `sort` | Zotero's sort index; sorting by it gives reading order |
| `position` | Zotero's position object, parsed; its shape depends on the reader type |
| `rects` | PDF only: `[[x1, y1, x2, y2], …]` in PDF user-space points, origin at the bottom left of the unrotated page (MediaBox coordinates, not relative to the CropBox) |
| `next-page-rects` | PDF only: the part of a highlight that continues on the next page, or `null` |
| `image` | project-relative PNG path for image and ink annotations (when `renderImages`), else `null` |
| `author` | the author's name in group libraries, else `null` |
| `created`, `modified` | UTC, ISO 8601 |
| `link` | opens Zotero at this annotation |
| `message` | HTML snapshots of email threads only: the message in the thread that contains the highlight (see below), else `null` |

#### `message`: which email in a thread holds the highlight

A saved email thread is filed under its newest message, but the sentence you
highlighted is often in an older, quoted message, written by someone else,
days earlier. For highlights in HTML snapshots zsync finds the
`From:` / `Sent:` / `To:` / `Subject:` header block just before the highlight and
reports it: `from`, `sent` (as written), `sent-iso` (local time, when the date
could be parsed), `to`, `subject`, the `signoff` (the line after "Kind
regards" and friends), and `index` / `count` (1 is the newest message, at the
top). It is `null` when the snapshot has no such headers or its file is not on
this device.

### `warnings`

Human-readable notes about anything zsync had to skip: an attachment whose file
is not on this device, an item without a citation key, an image annotation
Zotero could not render, a file it moved aside or could not delete.

## `refs/zsync/manifest.json`: what zsync owns

Bookkeeping, rewritten only when something in it changes: `outputs`
(annotations file → SHA-256), `bib` (`path`, `translator`, `sha256`),
`sources` and `images` (attachment or annotation key → `path`, `sha256`),
`documents` (what each standalone document was described as, with its
citation key), `retry` (files zsync could not delete last time, tried again
on every export), and the time, plugin and Zotero versions of the last
export that changed something.

It is what makes cleaning up safe. zsync deletes a file only when the
manifest lists it, its content still has the recorded SHA-256, and the
current export does not write that path (compared without regard to case,
as Windows and macOS do). A file zsync did not write that sits where an
output goes is moved aside to `<name>.zsync-backup` (then `-2`, `-3`, …)
rather than overwritten, and `warnings` says so. If the manifest is moved in
`zsync.json`, the next export finds the old one and retires it.

## Using it from Typst

```typ
#let z = json("/refs/annotations.json")
#let a = z.annotations.at("HLMAILAA")
#quote(attribution: a.message.from)[#a.text]
```

For the transcript template, whose `zotero-library` expects
`(items: citekey -> item, annotations: key -> highlight)`, the zsync file is
already in that shape:

```typ
#let zotero-library(data) = if data.at("zsync", default: none) != none {
  (items: data.items, annotations: data.annotations)
} else {
  // ...the existing BetterBibTeX JSON path...
}
```
