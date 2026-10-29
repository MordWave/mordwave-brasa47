export const SHARE_COPIED_NOTICE = 'Enlace copiado'
export const SHARE_FAILED_NOTICE = 'No pudimos compartir el enlace. Copia la dirección de esta página.'

// What the Share button does with the public link: the browser's share sheet when it has one (Web Share API), otherwise the link goes
// to the clipboard and `notify` says so. Closing the sheet (AbortError) is not an error. `nav` is injectable so this can be tested.
export async function sharePublicMenu({ url, businessName, notify, nav = globalThis.navigator }) {
  try {
    if (nav.share) {
      await nav.share({ title: businessName ? `Menú de ${businessName}` : 'Menú', url })
    } else {
      await nav.clipboard.writeText(url)
      notify(SHARE_COPIED_NOTICE)
    }
  } catch (err) {
    if (err?.name !== 'AbortError') notify(SHARE_FAILED_NOTICE)
  }
}
