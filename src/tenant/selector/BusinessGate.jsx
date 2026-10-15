import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { apiFetch } from '../../services/api'
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
// A selection that no longer exists / is inactive is dropped; one that cannot be verified keeps the user here with a
// retry. Dev Tools "Ver como" never takes part: the real role decided that this gate exists at all.

function TenantBar({ business, onChange }) {
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
      <button type="button" className="btn btn--outline btn--small" onClick={onChange} title="Volver a la selección de negocios">
        Cambiar negocio
      </button>
    </div>
  )
}

export default function BusinessGate({ onBusiness, children }) {
  const { token } = useAuth()
  const { businessId, isBusinessReady, setActiveBusiness, clearActiveBusiness, confirmActiveBusiness, scopePath } = useActiveBusiness()
  const [notice, setNotice] = useState('')

  // always the latest token / scoping when a validation starts (declared before the effects that use it)
  const latest = useRef({ token, scopePath })
  useEffect(() => {
    latest.current = { token, scopePath }
  })
  const [validator] = useState(() =>
    createBusinessValidator({
      fetchBusiness: () => apiFetch(latest.current.scopePath('/businesses/me'), { token: latest.current.token }),
    }),
  )
  const state = useStoreState(validator)

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
      setNotice('El negocio que tenías seleccionado está inactivo y no se puede administrar. Elige otro.')
      clearActiveBusiness()
    }
  }, [state, businessId, confirmActiveBusiness, clearActiveBusiness, onBusiness])

  if (businessId === null) {
    return (
      <BusinessPicker
        notice={notice}
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
        <TenantBar business={state.business} onChange={clearActiveBusiness} />
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
}
