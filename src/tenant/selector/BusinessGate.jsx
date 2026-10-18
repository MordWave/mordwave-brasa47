import { useEffect, useRef, useState } from 'react'
import RowActionsMenu from '../../components/admin/RowActionsMenu.jsx'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import AdminsView from '../admins/AdminsView.jsx'
import { createAdminsApi } from '../admins/adminsApi.js'
import { createAdminsStore } from '../admins/adminsStore.js'
import BusinessCreateDialog from '../creation/BusinessCreateDialog.jsx'
import { createBusinessCreateApi } from '../creation/businessCreateApi.js'
import { createCreationStore } from '../creation/creationStore.js'
import BusinessManagementDialogs from '../management/BusinessManagementDialogs.jsx'
import { createBusinessManagementApi } from '../management/businessManagementApi.js'
import { createBusinessManagementStore } from '../management/managementStore.js'
import { useActiveBusiness } from '../useActiveBusiness.js'
import BusinessPicker from './BusinessPicker.jsx'
import { ChevronIcon } from './platformIcons.jsx'
import { createBusinessValidator } from './businessValidation.js'
import { useStoreState } from './useStoreState.js'

// Rendered by AdminPanel ONLY for a real SUPER_ADMIN (an ADMIN never mounts it, so an ADMIN never calls GET /businesses
// and their requests are untouched). It decides what a SUPER_ADMIN sees:
//   no business chosen  -> the picker
//   a chosen business   -> it is VERIFIED first (GET /businesses/me?businessId=: must exist and be active); until it
//                          is, no administrative panel is mounted, so nothing is requested for an unverified business
//   verified            -> the existing Admin, keyed by business, under a bar that says which restaurant it is
// It also owns the SUPER_ADMIN management dialogs (edit / suspend / reactivate by UUID, tenant/management): the same
// store serves the picker rows and the bar of the chosen restaurant. Suspending the chosen restaurant drops the
// selection at once (its panels unmount); editing it refreshes the name shown; reactivating never selects anything.
// A selection that no longer exists / is inactive is dropped; one that cannot be verified keeps the user here with a
// retry. Dev Tools "Ver como" never takes part: the real role decided that this gate exists at all.

// The contextual header of a chosen business: where you are (breadcrumb "Negocios / <business>"), the way back to the list,
// and the business-level actions. It replaces the old four-button bar and is the ONLY navigation row between the platform
// header and the business panels. "Suspender" is not a peer of the everyday actions: it sits last in the "⋯" menu, in the
// danger colour, and still opens its confirmation dialog.
export function TenantBar({ business, onChange, management, onAdmins }) {
  return (
    <div className="context-bar" role="region" aria-label="Negocio que estás administrando">
      <div className="context-bar__where">
        <nav className="breadcrumb" aria-label="Ruta">
          <button type="button" className="breadcrumb__back" onClick={onChange} aria-label="Cambiar negocio: volver a la lista de negocios" title="Volver a la selección de negocios">
            <ChevronIcon direction="left" width={16} height={16} />
            Negocios
          </button>
          <span className="breadcrumb__sep" aria-hidden="true">
            /
          </span>
          <span className="breadcrumb__current" aria-current="page">
            Administrando
          </span>
        </nav>
        <div className="context-bar__business">
          {business.logoUrl ? (
            <img className="context-bar__logo" src={business.logoUrl} alt="" />
          ) : (
            <span className="context-bar__logo context-bar__logo--placeholder" aria-hidden="true">
              {String(business.name ?? '?').trim().slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="context-bar__text">
            <strong className="context-bar__name">{business.name}</strong>
            <span className="context-bar__slug">{business.slug}</span>
          </span>
        </div>
      </div>
      <div className="context-bar__actions">
        <button type="button" className="btn btn--outline btn--small" onClick={() => management.openEdit(business)}>
          Editar
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={() => onAdmins(business)}>
          Administradores
        </button>
        <RowActionsMenu label={`Más acciones de ${business.name}`} items={[{ key: 'suspend', label: 'Suspender', destructive: true, onSelect: () => management.openSuspend(business) }]} />
      </div>
    </div>
  )
}

export default function BusinessGate({ onBusiness, children }) {
  const { token } = useAuth()
  const { businessId, isBusinessReady, setActiveBusiness, clearActiveBusiness, confirmActiveBusiness, scopePath } = useActiveBusiness()
  const [notice, setNotice] = useState('')

  // always the latest token / scoping when a validation starts (declared before the effects that use it)
  const toast = useToast()
  const latest = useRef({ token, scopePath, businessId, toast, clearActiveBusiness })
  useEffect(() => {
    latest.current = { token, scopePath, businessId, toast, clearActiveBusiness }
  })
  const [validator] = useState(() =>
    createBusinessValidator({
      fetchBusiness: () => apiFetch(latest.current.scopePath('/businesses/me'), { token: latest.current.token }),
    }),
  )
  const [management] = useState(() => createBusinessManagementStore({ api: createBusinessManagementApi({ getToken: () => latest.current.token }) }))
  // "Crear negocio" (POST /businesses): the dialog and its store, mounted here — i.e. only for a real SUPER_ADMIN.
  const [creation] = useState(() => createCreationStore({ api: createBusinessCreateApi({ getToken: () => latest.current.token }) }))
  // The "Administradores" view (SUPER_ADMIN only, like everything in this gate): opened for any restaurant by id — from a
  // picker row (suspended ones included) or from the bar of the chosen one — and it replaces the picker / panels while open.
  const [admins] = useState(() => createAdminsStore({ api: createAdminsApi({ getToken: () => latest.current.token }) }))
  const adminsState = useStoreState(admins)
  useEffect(() => () => admins.close(), [admins])
  const state = useStoreState(validator)

  // What happened in a management dialog. The chosen restaurant is read from `latest` (the selection at the moment the
  // answer arrives), never from a closure captured when the dialog was opened.
  useEffect(
    () =>
      management.onChange((event) => {
        const { toast: notify, businessId: selected, clearActiveBusiness: drop } = latest.current
        const isSelected = typeof selected === 'string' && selected.toLowerCase() === String(event.businessId).toLowerCase()
        const name = event.business?.name ?? ''
        if (event.type === 'updated') {
          notify.success(`Cambios guardados en «${name}».`)
          if (isSelected) validator.refresh(event.business)
        } else if (event.type === 'deactivated') {
          notify.success(`«${name}» quedó suspendido. Sus sesiones de mesa abiertas se cerraron.`)
          if (isSelected) {
            setNotice(`«${name}» quedó suspendido. Elige otro negocio.`)
            drop()
          }
        } else if (event.type === 'activated') {
          notify.success(`«${name}» fue reactivado. Las sesiones de mesa anteriores no se reabrieron.`)
        } else if (event.type === 'missing') {
          notify.error('Este restaurante ya no existe.')
          if (isSelected) {
            setNotice('El negocio que estabas administrando ya no existe. Elige otro.')
            drop()
          }
        }
      }),
    [management, validator],
  )

  useEffect(() => {
    if (businessId) validator.validate(businessId)
    else validator.reset()
  }, [businessId, validator])

  useEffect(() => {
    if (state.businessId !== businessId || businessId === null) return
    if (state.status === 'valid') {
      confirmActiveBusiness(businessId)
      onBusiness(state.business)
      setNotice('')
    } else if (state.status === 'not-found') {
      setNotice('El negocio que tenías seleccionado ya no existe. Elige otro.')
      clearActiveBusiness()
    } else if (state.status === 'inactive') {
      setNotice('El negocio que tenías seleccionado está suspendido y no se puede administrar. Elige otro.')
      clearActiveBusiness()
    }
  }, [state, businessId, confirmActiveBusiness, clearActiveBusiness, onBusiness])

  const view = (() => {
    if (adminsState.business !== null) return <AdminsView store={admins} onBack={admins.close} />

    if (businessId === null) {
      return (
        <BusinessPicker
          notice={notice}
          management={management}
          admins={admins}
          creation={creation}
          onSelect={(id) => {
            setNotice('')
            setActiveBusiness(id)
          }}
        />
      )
    }

    if (isBusinessReady && state.status === 'valid' && state.businessId === businessId) {
      return (
        <>
          <TenantBar business={state.business} onChange={clearActiveBusiness} management={management} onAdmins={admins.open} />
          {children}
        </>
      )
    }

    if (state.status === 'error' && state.businessId === businessId) {
      return (
        <section className="platform platform--narrow" role="alert">
          <div className="platform__state platform__state--error">
            <h2 className="platform__state-title">No pudimos comprobar el negocio</h2>
            <p className="platform__state-text">No se cargó ningún dato hasta poder verificar que el negocio existe y está activo.</p>
            <div className="platform__state-actions">
              <button type="button" className="btn btn--primary btn--small" onClick={() => validator.validate(businessId)}>
                Reintentar
              </button>
              <button type="button" className="btn btn--outline btn--small" onClick={clearActiveBusiness}>
                Elegir otro negocio
              </button>
            </div>
          </div>
        </section>
      )
    }

    return (
      <p className="platform__status platform__status--page" role="status">
        {state.status === 'unauthorized' ? 'Tu sesión expiró. Inicia sesión nuevamente.' : 'Comprobando negocio…'}
      </p>
    )
  })()

  return (
    <>
      {view}
      <BusinessManagementDialogs store={management} />
      <BusinessCreateDialog
        store={creation}
        onManage={(business) => {
          creation.close()
          setNotice('')
          setActiveBusiness(business.id)
        }}
        onAddAdmin={(business) => {
          creation.close()
          admins.open(business)
        }}
      />
    </>
  )
}
