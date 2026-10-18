/**
 * Resolves a character asset path. Paths starting with '/' (e.g. /models/x/x.vrm) are relative to the app's
 * own files: the dev server root in development, the packaged renderer folder (file://) in the installed app.
 * http(s), file, data and deskmate:// URLs pass through.
 */
export function resolveAsset(path: string): string {
  // deskmate://character/<id>/… is a model in a character's own folder (one added in Setup lives under user data)
  if (/^(https?|file|data|blob|deskmate):/i.test(path)) return path
  if (path.startsWith('/')) return new URL('.' + path, document.baseURI).href
  return new URL(path, document.baseURI).href
}
