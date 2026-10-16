import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import BusinessManagementDialogs from '../management/BusinessManagementDialogs.jsx'
import { createBusinessManagementApi } from '../management/businessManagementApi.js'
import { createBusinessManagementStore } from '../management/managementStore.js'
import { useActiveBusiness } from '../useActiveBusiness.js'
import BusinessPicker from './BusinessPicker.jsx'
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

function TenantBar({ business, onChange, management }) {
  return (
    <div className="admin-panel__tenant" role="region" aria-label="Negocio que estás administrando">
      <div className="admin-panel__tenant-info">
        {business.logoUrl ? (
          <img className="admin-panel__tenant-logo" src={business.logoUrl} alt="" />
        ) : (
          <span className="admin-panel__tenant-logo admin-panel__tenant-logo--placeholder" aria-hidden="true">
            {String(business.name ?? '?').trim().slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="admin-panel__tenant-text">
          <span className="admin-panel__tenant-label">Administrando</span>
          <strong className="admin-panel__tenant-name">{business.name}</strong>
          <span className="admin-panel__tenant-slug">{business.slug}</span>
        </span>
      </div>
      <div className="admin-panel__tenant-actions">
        <button type="button" className="btn btn--outline btn--small" onClick={() => management.openEdit(business)}>
          Editar
        </button>
        <button type="button" className="btn btn--outline btn--small business-card__suspend" onClick={() => management.openSuspend(business)}>
          Suspender
        </button>
        <button type="button" className="btn btn--outline btn--small" onClick={onChange} title="Volver a la selección de negocios">
          Cambiar negocio
        </button>
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
    if (businessId === null) {
      return (
        <BusinessPicker
          notice={notice}
          management={management}
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
          <TenantBar business={state.business} onChange={clearActiveBusiness} management={management} />
          {children}
        </>
      )
    }

    if (state.status === 'error' && state.businessId === businessId) {
      return (
        <section className="business-picker" role="alert">
          <h2 className="business-picker__title">No pudimos comprobar el negocio</h2>
          <p className="business-picker__hint">No se cargó ningún dato hasta poder verificar que el negocio existe y está activo.</p>
          <div className="business-picker__actions">
            <button type="button" className="btn btn--primary btn--small" onClick={() => validator.validate(businessId)}>
              Reintentar
            </button>
            <button type="button" className="btn btn--outline btn--small" onClick={clearActiveBusiness}>
              Elegir otro negocio
            </button>
          </div>
        </section>
      )
    }

    return (
      <p className="business-picker__status" role="status">
        {state.status === 'unauthorized' ? 'Tu sesión expiró. Inicia sesión nuevamente.' : 'Comprobando negocio…'}
      </p>
    )
  })()

  return (
    <>
      {view}
      <BusinessManagementDialogs store={management} />
    </>
  )
}
