import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { apiFetch } from '../../services/api'
import { translateApiError } from '../../services/errorMessages'
import PrintQr from '../../components/admin/tables/PrintQr'
import TableFormModal from '../../components/admin/tables/TableFormModal'
import TableList from '../../components/admin/tables/TableList'
import TableQrModal from '../../components/admin/tables/TableQrModal'

const POLL_MS = 12000

export default function AdminTables() {
  const { token, user } = useAuth()
  const [tables, setTables] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // null = closed, 'new' = create form, an object = editing that table.
  const [tableModal, setTableModal] = useState(null)
  const [qrTable, setQrTable] = useState(null)
  const [printQr, setPrintQr] = useState(null)
  // Table id whose open/close request is currently in flight — disables
  // that card's own action buttons without blocking the rest of the list.
  const [busyId, setBusyId] = useState(null)
  // null = closed, otherwise the table pending deletion.
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)

  // `silent` covers the periodic background poll: a transient hiccup there
  // (a dev-server restart mid-request, a dropped connection) shouldn't
  // blast the page-wide banner while the admin is mid-interaction with
  // something unrelated, like the QR modal — it just retries next tick. The
  // initial load and any explicit action (open/close/delete) still report
  // failures immediately.
  const loadTables = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const data = await apiFetch('/tables/admin', { token })
        setTables(data)
        setError('')
      } catch (err) {
        if (!silent) setError(translateApiError(err))
      } finally {
        setLoading(false)
      }
    },
    [token],
  )

  useEffect(() => {
    loadTables()
    const interval = setInterval(() => loadTables({ silent: true }), POLL_MS)
    return () => clearInterval(interval)
  }, [loadTables])

  // businessId is required by the backend DTO but is only ever read from
  // the caller's own token server-side for an ADMIN — sending the admin's
  // own (already-known) businessId here isn't the frontend "choosing" a
  // tenant, it's just satisfying that required field with the value the
  // backend will use regardless of what's sent.
  async function handleSaveTable(payload, editingId) {
    const body = editingId ? payload : { ...payload, businessId: user.businessId }
    await apiFetch(editingId ? `/tables/${editingId}` : '/tables', {
      method: editingId ? 'PATCH' : 'POST',
      token,
      body: JSON.stringify(body),
    })
    setTableModal(null)
    await loadTables()
  }

  async function handleToggleSession(table) {
    setError('')
    setBusyId(table.id)
    try {
      if (table.sessionOpen) {
        await apiFetch(`/tables/${table.id}/sessions/current`, { method: 'PATCH', token })
      } else {
        await apiFetch(`/tables/${table.id}/sessions`, { method: 'POST', token })
      }
      await loadTables()
    } catch (err) {
      setError(translateApiError(err))
    } finally {
      setBusyId(null)
    }
  }

  function handlePrintQr(table, dataUrl) {
    setPrintQr({ table, dataUrl })
    setTimeout(() => {
      window.print()
      setPrintQr(null)
    }, 50)
  }

  function requestDeleteTable(table) {
    setDeleteError('')
    setDeleteTarget(table)
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleteError('')
    setDeleting(true)
    try {
      await apiFetch(`/tables/${deleteTarget.id}`, { method: 'DELETE', token })
      setDeleteTarget(null)
      await loadTables()
    } catch (err) {
      // Stays open so the admin sees why (e.g. 409 TABLE_HAS_OPEN_SESSION)
      // instead of the dialog just vanishing. TABLE_HAS_OPEN_SESSION is
      // shared with the deactivate flow (same backend errorCode for both),
      // so it's special-cased here rather than in the shared translator —
      // deactivate keeps its own "...antes de desactivarla." wording.
      setDeleteError(
        err.code === 'TABLE_HAS_OPEN_SESSION'
          ? 'Cierra la sesión de esta mesa antes de eliminarla.'
          : translateApiError(err),
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="admin-menu">
      <div className="admin-menu__section-head">
        <h2>Gestión de mesas</h2>
        <button type="button" className="btn btn--primary btn--small" onClick={() => setTableModal('new')}>
          + Nueva mesa
        </button>
      </div>

      {error && <p className="admin-menu__error">{error}</p>}

      <TableList
        tables={tables}
        loading={loading}
        busyId={busyId}
        onEdit={setTableModal}
        onToggleSession={handleToggleSession}
        onViewQr={setQrTable}
        onDelete={requestDeleteTable}
      />

      {tableModal && (
        <TableFormModal
          table={tableModal === 'new' ? null : tableModal}
          onClose={() => setTableModal(null)}
          onSave={handleSaveTable}
        />
      )}

      {qrTable && (
        <TableQrModal
          table={qrTable}
          token={token}
          onClose={() => setQrTable(null)}
          onPrint={handlePrintQr}
        />
      )}

      {deleteTarget && (
        <div className="confirm-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog__text">¿Eliminar la mesa “{deleteTarget.name}”?</p>
            <p className="confirm-dialog__subtext">Los pedidos históricos se conservarán.</p>
            {deleteError && <p className="admin-menu__form-error">{deleteError}</p>}
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? 'Eliminando…' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}

      <PrintQr data={printQr} />
    </div>
  )
}
