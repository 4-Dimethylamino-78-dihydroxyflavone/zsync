## Menus

zsync-menu-export =
    .label = Export to zsync Project
zsync-menu-link =
    .label = Link zsync Project Folder…
zsync-menu-export-all =
    .label = Export All zsync Projects
zsync-menu-unlink =
    .label = Unlink zsync Project Folder…

## Unlinking

zsync-unlink-title = Unlink project folder
zsync-unlink-choose = Which project folder should “{ $name }” stop exporting to?
zsync-unlink-question = Stop exporting “{ $name }” to this folder?
zsync-unlink-explain = zsync can also delete the files it wrote there (annotations, bibliography, copies and images). Files you have changed since are kept, and nothing else in the folder is touched.
zsync-unlink-gone = The folder is not there any more, so there is nothing to delete.
zsync-unlink-keep = Stop Exporting
zsync-unlink-delete = Stop and Delete zsync’s Files
zsync-unlink-config = Also delete zsync.json (this folder’s zsync settings, used by your other devices too), whichever you choose
zsync-unlink-config-deleted = zsync.json was deleted; the other files were kept.
zsync-unlink-failed = zsync could not delete these (are they open in another program?); try again later:
zsync-unlink-done = Stopped exporting to { $folder }.
zsync-unlink-deleted = { $count ->
    [one] Deleted 1 file zsync had written.
   *[other] Deleted { $count } files zsync had written.
}
zsync-unlink-kept = Kept these because they changed after zsync wrote them:
zsync-unlink-nomanifest = zsync found no record of its files in this folder, so it deleted nothing.
zsync-unlink-none = No project folders on this device are linked to “{ $name }”.

## Renamed or moved folders

zsync-missing-question = The project folder for “{ $name }” is missing:
zsync-missing-explain = It may have been renamed or moved, or be on a drive that is not connected.
zsync-missing-find = Find It…
zsync-missing-skip = Skip
zsync-missing-unlink = Unlink
zsync-missing-hint = Folders that were renamed or moved can be found again in Settings → zsync.
zsync-found-one = Found it here. Use this folder from now on?
zsync-found-use = Use This Folder
zsync-found-choose = Choose the Folder Myself…
zsync-found-unplugged = It was on “{ $drive }”, which does not seem to be connected. Plug it in and export again, or choose where the folder is now.
zsync-found-unknown = zsync does not know which project this folder held, so it cannot search for it. Choose its new location yourself?
zsync-found-many = More than one folder is linked to “{ $name }”. Which one is the project now?
zsync-found-none = zsync could not find it near its old location. Choose its new location yourself?
zsync-pick-moved = Where is the project folder for “{ $name }” now?

## Linking

zsync-pick-folder = Choose the project folder for “{ $name }”
zsync-confirm-relink = { $folder } is linked to “{ $old }”. Link it to “{ $name }” instead?
zsync-error-config = This folder’s zsync.json cannot be used: { $message }
zsync-error-generic = zsync: { $message }
zsync-no-projects = No zsync project folders yet. Right-click a collection and choose “Link zsync Project Folder…”.

## Progress

zsync-exporting = zsync: exporting
zsync-exported = zsync: exported “{ $name }”
zsync-failed = zsync: export failed
zsync-done-changed = { $count ->
    [one] 1 file updated
   *[other] { $count } files updated
}
zsync-done-unchanged = Already up to date
zsync-more-warnings = …and { $count } more (listed in annotations.json)

## Settings

zsync-prefs-projects-title = Project folders on this device
zsync-prefs-projects-intro = Each folder holds a zsync.json that names its Zotero collection. To link a new collection, right-click it and choose “Link zsync Project Folder…”.
zsync-prefs-empty = No project folders yet.
zsync-prefs-add =
    .label = Add Existing Project Folder…
zsync-prefs-export-all =
    .label = Export All Now
zsync-prefs-export =
    .label = Export
zsync-prefs-show =
    .label = Show
zsync-prefs-remove =
    .label = Unlink…
zsync-prefs-find =
    .label = Find…
zsync-prefs-no-config = There is no zsync.json in { $folder }. Link a collection to it from the collection’s right-click menu instead.
zsync-prefs-auto-title = Automatic export
zsync-prefs-auto =
    .label = Export a project a few seconds after anything in its collection changes
zsync-prefs-auto-help = Only this device. Changes synced from other devices are picked up too.
zsync-prefs-status-never = not exported yet
zsync-prefs-status-ok = exported { $when }: { $items } items, { $annotations } annotations
zsync-prefs-status-error = error: { $message }
zsync-prefs-status-missing = { $message }
