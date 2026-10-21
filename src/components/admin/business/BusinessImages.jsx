import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { EMPTY_IMAGE_OPS, createImageOpsStore } from '../../../branding/imageOpsStore.js'
import { checkCoverDimensions, checkCoverFile } from '../../../branding/coverGeometry.js'
import { loadImageElement } from '../../../branding/coverCanvas.js'
import { useConfirm } from '../../../context/ConfirmContext'
import { homeCoverFor } from '../../customer/homeCover.js'
import { normalizeMediaUrl } from '../../../utils/mediaUrl.js'
import PhotoCropModal from '../menu/PhotoCropModal'
import CoverCropModal from './CoverCropModal'

// "Imágenes del restaurante": welcome-screen cover and logo of THE business being edited (an ADMIN's own, or the one a SUPER_ADMIN
// selected: the `request` function the parent passes is already scoped to it). It lives inside the existing "Negocio" tab.
//
// All the rules about what counts as done / not done / unknown live in branding/imageOpsStore.js. This component only shows them:
// the pictures on screen are the ones the server confirmed (never an optimistic value), and an operation whose outcome is unknown
// is shown as such, with a button to read the real state again (never an automatic retry).
//
//   business      the loaded business (id, name, slug, active, logoUrl, coverUrl)
//   request       (path, options) -> Promise<body>, scoped + authenticated
//   describeError (error) -> Spanish sentence for a definitive refusal
//   onConfirmed   (body) -> the business as the server confirmed it
//   previewBranding  the restaurant as it looks with the form's unsaved values (for the in-context review of a cut)
const BUSY_TEXT = {
  'cover-upload': 'Subiendo portada…',
  'cover-remove': 'Quitando portada…',
  'logo-upload': 'Subiendo logo…',
  'logo-remove': 'Quitando logo…',
  recheck: 'Consultando el estado actual…',
}

const OP_WHAT = { 'cover-upload': 'la portada', 'cover-remove': 'la portada', 'logo-upload': 'el logo', 'logo-remove': 'el logo' }
const OP_VERB = { 'cover-upload': 'subir', 'cover-remove': 'quitar', 'logo-upload': 'subir', 'logo-remove': 'quitar' }

function probeImage(url) {
  return loadImageElement(url).then(
    (image) => ({ ok: true, width: image.naturalWidth, height: image.naturalHeight }),
    () => ({ ok: false }),
  )
}

export default function BusinessImages({ business, request, describeError, onConfirmed, previewBranding }) {
  const confirm = useConfirm()
  // the latest props, without re-creating the store when the parent re-renders
  const latest = useRef({ request, describeError, onConfirmed })
  latest.current = { request, describeError, onConfirmed }

  // One store per business: it is created when the section appears for that business and disposed when it goes away (the panel
  // remounts this on every business switch), so a late answer can never reach another business's panel.
  const [store, setStore] = useState(null)
  useEffect(() => {
    const created = createImageOpsStore({
      businessId: business.id,
      initial: { logoUrl: business.logoUrl ?? null, coverUrl: business.coverUrl ?? null },
      request: (path, options) => latest.current.request(path, options),
      describeError: (error) => latest.current.describeError(error),
      onConfirmed: (body) => latest.current.onConfirmed(body),
    })
    setStore(created)
    return () => created.dispose()
    // the images shown afterwards come from the store (what the server confirmed), not from later props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id])

  const state = useSyncExternalStore((store ?? EMPTY_IMAGE_OPS).subscribe, (store ?? EMPTY_IMAGE_OPS).getState)
  const busy = state.busy !== null

  const [fileError, setFileError] = useState('')
  const [logoCropSrc, setLogoCropSrc] = useState(null)
  const [coverCrop, setCoverCrop] = useState(null) // { src, small }
  const [failedSrc, setFailedSrc] = useState({ logo: null, cover: null })

  // object URLs of the picked pictures are released when they are no longer shown (also on unmount / business switch)
  useEffect(() => () => logoCropSrc && URL.revokeObjectURL(logoCropSrc), [logoCropSrc])
  useEffect(() => () => coverCrop && URL.revokeObjectURL(coverCrop.src), [coverCrop])

  const logoSrc = normalizeMediaUrl(state.images.logoUrl)
  const coverSrc = normalizeMediaUrl(state.images.coverUrl)
  const historical = homeCoverFor(business.slug) // Brasa 47 only (transitional): its own photo while it has no cover of its own

  async function handleLogoFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    setFileError('')
    const rawUrl = URL.createObjectURL(file)
    const probe = await probeImage(rawUrl)
    if (!probe.ok) {
      URL.revokeObjectURL(rawUrl)
      setFileError('No pudimos previsualizar esta imagen. Prueba con otro formato (JPG o PNG) o con otra foto.')
      return
    }
    setLogoCropSrc(rawUrl)
  }

  async function handleLogoCropConfirm(blob) {
    setLogoCropSrc(null)
    await store.uploadLogo(blob)
  }

  async function handleCoverFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setFileError('')
    const picked = checkCoverFile(file)
    if (!picked.ok) {
      setFileError(picked.message)
      return
    }
    const rawUrl = URL.createObjectURL(file)
    const probe = await probeImage(rawUrl)
    const dims = probe.ok ? checkCoverDimensions(probe.width, probe.height) : { ok: false, message: 'No pudimos previsualizar esta imagen. Prueba con un archivo JPG, PNG o WebP.' }
    if (!dims.ok) {
      URL.revokeObjectURL(rawUrl)
      setFileError(dims.message)
      return
    }
    setCoverCrop({ src: rawUrl, small: dims.small })
  }

  async function handleUseCover(blob) {
    const result = await store.uploadCover(blob)
    // success or an unconfirmed outcome (the banner takes over); a definitive refusal keeps the crop open so it can be tried again
    if (result.ok || result.ambiguous || result.disposed) setCoverCrop(null)
  }

  async function handleRemove(kind) {
    const isCover = kind === 'cover'
    const ok = await confirm({
      title: isCover ? '¿Quitar la portada?' : '¿Quitar el logo?',
      message: isCover
        ? historical
          ? 'Se volverá a mostrar la foto original del restaurante en la pantalla de bienvenida. Podrás subir otra portada cuando quieras.'
          : 'La pantalla de bienvenida usará un fondo neutral con los colores de tu marca. Podrás subir otra portada cuando quieras.'
        : 'La pantalla de bienvenida mostrará las iniciales del restaurante en lugar del logo. Podrás subir otro cuando quieras.',
      variant: 'destructive',
      confirmLabel: isCover ? 'Quitar portada' : 'Quitar logo',
    })
    if (!ok) return
    if (isCover) await store.removeCover()
    else await store.removeLogo()
  }

  const { notice, ambiguous } = state
  const coverUploadError = notice?.kind === 'error' && notice.op === 'cover-upload' ? notice.message : ''
  const check = ambiguous?.check
  const changedForOp = check?.status === 'done' ? (OP_WHAT[ambiguous.op] === 'la portada' ? check.coverChanged : check.logoChanged) : null

  return (
    <section className="business-images" aria-labelledby="business-images-title">
      <h3 id="business-images-title" className="business-images__title">
        Imágenes del restaurante
      </h3>
      {business.active === false && (
        <p className="business-images__note" role="note">
          Este restaurante está suspendido: tus clientes no pueden usarlo ahora, pero puedes seguir preparando su imagen.
        </p>
      )}

      <div className="admin-menu__image-field">
        <span className="admin-menu__image-label">Portada de la pantalla de bienvenida</span>
        <div className="business-images__cover-frame">
          {coverSrc && failedSrc.cover !== coverSrc ? (
            <img src={coverSrc} alt="Portada actual" className="business-images__cover-img" onError={() => setFailedSrc((f) => ({ ...f, cover: coverSrc }))} />
          ) : (
            <span className="business-images__cover-empty">
              {coverSrc
                ? 'No pudimos mostrar la portada actual.'
                : historical
                  ? 'Sin portada propia: se muestra la foto original del restaurante.'
                  : 'Sin portada: tus clientes verán un fondo neutral con los colores de tu marca.'}
            </span>
          )}
        </div>
        <div className="admin-menu__image-actions">
          <label className="btn btn--outline btn--small admin-menu__file-btn">
            {coverSrc ? 'Reemplazar portada' : 'Seleccionar portada'}
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleCoverFile} disabled={busy} hidden />
          </label>
          {coverSrc && (
            <button type="button" className="btn btn--outline btn--small business-images__remove" onClick={() => handleRemove('cover')} disabled={busy}>
              Quitar portada
            </button>
          )}
        </div>
        <p className="business-images__hint">Foto vertical (4:5) en JPG, PNG o WebP. Podrás encuadrarla y revisarla antes de subirla.</p>
      </div>

      <div className="admin-menu__image-field">
        <span className="admin-menu__image-label">Logo</span>
        <div className="admin-menu__image-preview">
          {logoSrc && failedSrc.logo !== logoSrc ? (
            <img src={logoSrc} alt="" className="admin-menu__image-thumb" onError={() => setFailedSrc((f) => ({ ...f, logo: logoSrc }))} />
          ) : (
            <span className="admin-menu__image-placeholder">Sin logo</span>
          )}
        </div>
        <div className="admin-menu__image-actions">
          <label className="btn btn--outline btn--small admin-menu__file-btn">
            {logoSrc ? 'Reemplazar logo' : 'Seleccionar logo'}
            <input type="file" accept="image/*" onChange={handleLogoFile} disabled={busy} hidden />
          </label>
          {logoSrc && (
            <button type="button" className="btn btn--outline btn--small business-images__remove" onClick={() => handleRemove('logo')} disabled={busy}>
              Quitar logo
            </button>
          )}
        </div>
      </div>

      {busy && state.busy !== 'cover-upload' && (
        <p className="admin-menu__image-status" role="status">
          {BUSY_TEXT[state.busy]}
        </p>
      )}
      {fileError && (
        <p className="admin-menu__form-error" role="alert">
          {fileError}
        </p>
      )}
      {notice && !(notice.op === 'cover-upload' && coverCrop) && (
        <div className={`business-images__notice business-images__notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button type="button" className="business-images__dismiss" onClick={() => store.dismissNotice()} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}

      {ambiguous && (
        <div className="business-images__notice business-images__notice--unknown" role="alert" data-testid="ambiguous-notice">
          <p>
            <strong>No pudimos confirmar si se pudo {OP_VERB[ambiguous.op]} {OP_WHAT[ambiguous.op]}.</strong> El servidor o la conexión no respondieron como esperábamos, así que no lo damos por hecho ni por fallido.
          </p>
          <p>Consulta el estado actual para ver qué imagen tiene guardada el restaurante.</p>
          {check?.status === 'failed' && <p>{check.message}</p>}
          {check?.status === 'done' && (
            <p>
              {changedForOp
                ? `La imagen actual es distinta de la que había antes de la operación. No podemos asegurar que ese cambio sea de esta operación: otra persona o pestaña también pudo cambiarla.`
                : `La imagen actual es la misma que antes. Esto no demuestra que la operación no vaya a completarse más tarde: el servidor puede seguir procesándola.`}
            </p>
          )}
          <p>
            Puedes volver a consultar cuantas veces quieras. Si decides repetir la operación, la anterior podría completarse después y reemplazar o quitar lo que hagas ahora.
            {ambiguous.repeated ? ' Ya repetiste una operación: el resultado final depende de cuál se confirme último.' : ''}
          </p>
          <div className="business-images__notice-actions">
            <button type="button" className="btn btn--outline btn--small" onClick={() => store.recheck()} disabled={busy}>
              {state.busy === 'recheck' ? 'Consultando…' : 'Consultar estado actual'}
            </button>
            <button type="button" className="btn btn--outline btn--small" onClick={() => store.dismissAmbiguous()} disabled={busy}>
              Cerrar aviso
            </button>
          </div>
        </div>
      )}

      {logoCropSrc && <PhotoCropModal imageSrc={logoCropSrc} onCancel={() => setLogoCropSrc(null)} onConfirm={handleLogoCropConfirm} />}
      {coverCrop && (
        <CoverCropModal
          imageSrc={coverCrop.src}
          sourceSmall={coverCrop.small}
          uploading={state.busy === 'cover-upload'}
          uploadError={coverUploadError}
          warnPending={ambiguous !== null}
          previewBranding={previewBranding}
          businessSlug={business.slug}
          onUse={handleUseCover}
          onCancel={() => setCoverCrop(null)}
        />
      )}
    </section>
  )
}
