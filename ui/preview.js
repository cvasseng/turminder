/**
 * Which renderer a store file gets in the file panel (§18.5).
 *
 * Its own file, and a pure function of the mime type, because it is the one
 * piece of panel logic worth testing without a browser — and because the set
 * below has to agree with what `GET /api/files/raw` is willing to serve
 * inline (App. E). A test asserts that agreement; if you add a type here, add
 * it there in the same change.
 *
 * Everything not listed keeps the metadata row it has always had. No viewer
 * libraries: the browser renders images and PDFs, and that is the whole
 * feature.
 */
function previewKind(mime) {
  if (typeof mime !== 'string') return null;
  const type = mime.split(';')[0].trim().toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(type)) {
    return 'image';
  }
  return null;
}
