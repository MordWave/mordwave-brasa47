import { confirmationMatches } from './adminsStore.js'

// What the "Eliminar administrador" dialog shows and allows for a given store `removal` and the text typed so far. Pure, so the
// rules that matter (the final button is enabled ONLY when the typed e-mail matches AND nothing is in flight; the dialog cannot be
// closed or sent twice while a request or a check is pending) are testable without a DOM.
//   removal: { admin: { id, email }, phase: 'idle'|'deleting'|'refused'|'ambiguous'|'checking', error }
export function removalDialogModel(removal, typed) {
  const phase = removal.phase
  const matches = confirmationMatches(typed, removal.admin.email)
  const inFlight = phase === 'deleting' || phase === 'checking'
  return {
    phase,
    matches,
    inFlight,
    // the field is editable only while the person can still send the deletion. It is READ-ONLY, never disabled: a disabled
    // control drops keyboard focus, and the dialog must keep it
    inputReadOnly: phase !== 'idle',
    // the final button exists while the deletion can be (or is being) sent; after a refusal or an unknown outcome it is gone
    showFinal: phase === 'idle' || phase === 'deleting',
    canConfirm: phase === 'idle' && matches,
    finalLabel: phase === 'deleting' ? 'Eliminando…' : 'Eliminar definitivamente',
    // an unknown outcome is resolved by re-reading the list, never by sending the deletion again on its own
    showRefresh: phase === 'ambiguous' || phase === 'checking',
    refreshLabel: phase === 'checking' ? 'Actualizando…' : 'Actualizar lista',
    closeLabel: phase === 'idle' || phase === 'deleting' ? 'Cancelar' : 'Cerrar',
    closeDisabled: inFlight,
    // a quiet hint while typing, never an error
    typedHint: phase === 'idle' && typed.trim() !== '' && !matches ? 'Todavía no coincide con el correo del administrador.' : '',
    fieldInvalid: phase === 'idle' && (removal.error?.kind === 'confirmation-mismatch' || removal.error?.kind === 'invalid'),
  }
}
