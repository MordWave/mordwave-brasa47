export const LINK_COPIED_NOTICE = 'Enlace copiado'
export const LINK_COPY_FAILED_NOTICE = 'No pudimos copiar el enlace. Selecciónalo y cópialo a mano.'

// Copies a link to the clipboard: the Clipboard API first, then `selectAndCopy` (a synchronous fallback for browsers without it, e.g.
// selecting the field and running the copy command; it returns true when it worked). Resolves to 'copied' or 'failed', never throws.
// `nav` is injectable so this can be tested.
export async function copyLink({ url, nav = globalThis.navigator, selectAndCopy }) {
  try {
    await nav.clipboard.writeText(url)
    return 'copied'
  } catch {
    // no Clipboard API, or the browser refused: try the fallback
  }
  try {
    if (selectAndCopy?.()) return 'copied'
  } catch {
    // the fallback failed too
  }
  return 'failed'
}
