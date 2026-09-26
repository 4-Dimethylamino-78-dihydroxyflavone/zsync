// zsync Stage 0 probe: read-only. Select ONE collection in Zotero, then
// Tools > Developer > Run JavaScript, tick "Run as async function", paste
// this file and press Run. The result shows what zsync would find in that
// collection on this device: citation keys, attachment types, annotation
// types and positions, files that are missing, image caches and export
// translators. Nothing is written anywhere.
//
// Works on Zotero 9 and 10.

const zp = Zotero.getActiveZoteroPane();
const rows = typeof zp.getCollectionTreeRows === "function" ? zp.getCollectionTreeRows() : [zp.getCollectionTreeRow()].filter(Boolean);
if (rows.length !== 1 || !rows[0].isCollection()) return "Select exactly one collection first.";
const collection = rows[0].ref;
await collection.loadDataType("childItems");

const out = {
  zotero: Zotero.version,
  collection: { name: collection.name, key: collection.key, libraryID: collection.libraryID },
  items: 0,
  itemsWithoutCitekey: [],
  attachmentsByReader: {},
  missingFiles: [],
  annotationsByType: {},
  crossPageHighlights: 0,
  snapshotHighlights: 0,
  imageAnnotationsWithoutCache: 0,
  samples: {},
  betterBibTeX: !!Zotero.BetterBibTeX,
  bibTranslators: [],
};

for (const item of collection.getChildItems(false, false)) {
  if (!item.isRegularItem() && !item.isFileAttachment()) continue;
  await item.loadAllData();
  let atts = [item];
  if (item.isRegularItem()) {
    out.items++;
    if (!item.getField("citationKey")) out.itemsWithoutCitekey.push(`${item.key} ${item.getField("title", false, true)}`);
    atts = Zotero.Items.get(item.getAttachments(false)).filter((a) => a.isFileAttachment());
  }
  for (const att of atts) {
    await att.loadDataType("childItems");
    const reader = att.attachmentReaderType || "other";
    out.attachmentsByReader[reader] = (out.attachmentsByReader[reader] || 0) + 1;
    if (!(await att.getFilePathAsync())) out.missingFiles.push(`${att.key} ${att.attachmentFilename}`);
    if (!att.attachmentReaderType) continue;
    for (const a of att.getAnnotations(false)) {
      const type = a.annotationType;
      out.annotationsByType[type] = (out.annotationsByType[type] || 0) + 1;
      let pos = null;
      try { pos = JSON.parse(a.annotationPosition); }
      catch (e) {}
      if (pos && pos.nextPageRects) out.crossPageHighlights++;
      if (pos && pos.type === "CssSelector") out.snapshotHighlights++;
      if ((type === "image" || type === "ink") && !(await Zotero.Annotations.hasCacheImage(a))) out.imageAnnotationsWithoutCache++;
      const sampleKey = `${reader}/${type}`;
      if (!out.samples[sampleKey]) {
        out.samples[sampleKey] = {
          key: a.key,
          text: a.annotationText ? a.annotationText.slice(0, 60) : null,
          comment: a.annotationComment ? a.annotationComment.slice(0, 60) : null,
          pageLabel: a.annotationPageLabel,
          sortIndex: a.annotationSortIndex,
          position: pos,
        };
      }
    }
  }
}

const exporters = await Zotero.Translators.getAllForType("export");
out.bibTranslators = exporters.filter((t) => t.target === "bib").map((t) => `${t.label} (${t.translatorID})`);
return out;
