/**
 * Resolves a character asset path. Paths starting with '/' (e.g. /models/x/x.vrm) are relative to the app's
 * own files: the dev server root in development, the packaged renderer folder (file://) in the installed app.
 * http(s), file and data URLs pass through.
 */
export function resolveAsset(path: string): string {
  if (/^(https?|file|data|blob):/i.test(path)) return path
  if (path.startsWith('/')) return new URL('.' + path, document.baseURI).href
  return new URL(path, document.baseURI).href
}
