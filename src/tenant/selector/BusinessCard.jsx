import { useId } from 'react'
import RowActionsMenu from '../../components/admin/RowActionsMenu.jsx'
import { businessMenuItems } from './cardActions.js'
import { ChevronIcon } from './platformIcons.jsx'

function initialsOf(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  return (words.length === 0 ? '?' : words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase()
}

function Logo({ business }) {
  return business.logoUrl ? (
    <img className="biz-card__logo" src={business.logoUrl} alt="" loading="lazy" />
  ) : (
    <span className="biz-card__logo biz-card__logo--placeholder" aria-hidden="true">
      {initialsOf(business.name)}
    </span>
  )
}

// One restaurant, with ONLY what the list endpoint really returns: logo (or initials), name, slug and status.
//  - an ACTIVE business has one primary action, "Administrar" (a real button: the only way to enter a business);
//  - a SUSPENDED one can never be entered from here: it explains why and offers "Reactivar" instead;
//  - the secondary actions live in the contextual "⋯" menu (RowActionsMenu: keyboard and screen-reader friendly), with
//    "Suspender" last, apart and in the danger colour. Every action opens the same confirmation dialogs as before; none of
//    them selects the business, and none is rendered unless the SUPER_ADMIN gate handed over the management callbacks.
export default function BusinessCard({ business, onSelect, management, isNew = false }) {
  const nameId = useId()
  const { name, slug, active } = business
  const items = businessMenuItems(business, management)
  return (
    <article className={`biz-card${active ? '' : ' biz-card--inactive'}${isNew ? ' biz-card--new' : ''}`} aria-labelledby={nameId}>
      <header className="biz-card__head">
        <Logo business={business} />
        <div className="biz-card__id">
          <h3 id={nameId} className="biz-card__name">
            {name}
          </h3>
          <p className="biz-card__slug">
            <span className="biz-card__slug-label">slug</span> <code>{slug}</code>
          </p>
        </div>
        {items.length > 0 && <RowActionsMenu label={`Más acciones de ${name}`} items={items} />}
      </header>

      <div className="biz-card__status">
        <span className={`biz-status biz-status--${active ? 'active' : 'inactive'}`}>
          <span className="biz-status__dot" aria-hidden="true" />
          {active ? 'Activo' : 'Suspendido'}
        </span>
        {isNew && <span className="biz-card__new">Recién creado</span>}
      </div>
      {!active && <p className="biz-card__hint">Suspendido: no se puede administrar hasta reactivarlo.</p>}

      <div className="biz-card__footer">
        {active ? (
          <button type="button" className="btn btn--small biz-card__cta biz-card__cta--main" onClick={() => onSelect(business.id)} aria-label={`Administrar ${name}`}>
            Administrar
            <ChevronIcon width={16} height={16} />
          </button>
        ) : (
          management && (
            <button type="button" className="btn btn--outline btn--small biz-card__cta" onClick={() => management.onActivate(business)} aria-label={`Reactivar ${name}`}>
              Reactivar
            </button>
          )
        )}
      </div>
    </article>
  )
}
