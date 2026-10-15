import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useConfirm } from '../../context/ConfirmContext'
import { useToast } from '../../context/ToastContext'
import { apiFetch } from '../../services/api'
import { DEV_TOOLS_BUILD_ENABLED } from '../../devtools/buildFlag.js'
import { translateApiError } from '../../services/errorMessages'
import PrintQr from '../../components/admin/tables/PrintQr'
import TableFormModal from '../../components/admin/tables/TableFormModal'
import TableList from '../../components/admin/tables/TableList'
import TableQrModal from '../../components/admin/tables/TableQrModal'

const POLL_MS = 12000

// Shared with the delete confirm below — TABLE_HAS_OPEN_SESSION is the same
// backend errorCode for both deactivate and delete, so each call site maps
// it to its own wording via useConfirm's mapError instead of the shared
// translator picking one generic message for both.
function mapDeleteError(err) {
  return err.code === 'TABLE_HAS_OPEN_SESSION'
    ? 'Cierra la sesión de esta mesa antes de eliminarla.'
    : translateApiError(err)
}

export default function AdminTables({ businessName }) {
  const { token, user } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [tables, setTables] = useState([])
  const [loading, setLoading] = useState(true)
  // Page-load failure only — individual action results go through Toast.
  const [error, setError] = useState('')
  // null = closed, 'new' = create form, an object = editing that table.
  const [tableModal, setTableModal] = useState(null)
  const [qrTable, setQrTable] = useState(null)
  const [printQr, setPrintQr] = useState(null)
  // Table id whose open request is currently in flight — disables that
  // card's own action buttons. Closing a session goes through the confirm
  // dialog instead, which already blocks the whole page while open.
  const [busyId, setBusyId] = useState(null)

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
    if (table.sessionOpen) {
      // Closing disconnects every device currently at that table — worth a
      // confirmation. The dialog itself already blocks the rest of the
      // page while open, so busyId isn't needed for this branch.
      const ok = await confirm({
        title: `¿Cerrar la sesión de "${table.name}"?`,
        message: 'Los clientes conectados a esta mesa perderán acceso al menú y no podrán seguir pidiendo.',
        variant: 'destructive',
        confirmLabel: 'Cerrar sesión',
        onConfirm: () => apiFetch(`/tables/${table.id}/sessions/current`, { method: 'PATCH', token }),
      })
      if (ok) {
        toast.success('Sesión cerrada.')
        await loadTables()
      }
      return
    }

    setBusyId(table.id)
    try {
      await apiFetch(`/tables/${table.id}/sessions`, { method: 'POST', token })
      toast.success('Mesa abierta.')
      await loadTables()
    } catch (err) {
      toast.error(translateApiError(err))
    } finally {
      setBusyId(null)
    }
  }

  function handlePrintQr(table, dataUrl) {
    setPrintQr({ table, dataUrl, businessName })
    setTimeout(() => {
      window.print()
      setPrintQr(null)
    }, 50)
  }

  async function handleDeleteTable(table) {
    const ok = await confirm({
      title: `¿Eliminar la mesa "${table.name}"?`,
      message: 'Los pedidos históricos se conservarán.',
      variant: 'destructive',
      onConfirm: () => apiFetch(`/tables/${table.id}`, { method: 'DELETE', token }),
      mapError: mapDeleteError,
    })
    if (ok) {
      toast.success('Mesa eliminada.')
      await loadTables()
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
        onDelete={handleDeleteTable}
      />

      {tableModal && (
        <TableFormModal
          table={tableModal === 'new' ? null : tableModal}
          existingNames={DEV_TOOLS_BUILD_ENABLED ? tables.map((t) => t.name) : undefined}
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

      <PrintQr data={printQr} />
    </div>
  )
}
