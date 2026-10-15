import { useRef } from 'react'
import { THEME_OPTIONS as OPTIONS, nextOptionIndex } from '../theme/toggleModel.js'
import { useTheme } from '../theme/useTheme.js'

function Icon({ name }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (name === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    )
  }
  if (name === 'dark') {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

// Reusable Sistema / Claro / Oscuro selector (radio group, arrow-key navigation).
//   variant="segmented"  icon + label (Admin)
//   variant="compact"    icons only, quiet (customer menu: must not compete with the restaurant's branding)
// Renders nothing while dark mode is not rolled out (see theme/flag.js).
export default function ThemeToggle({ variant = 'segmented', className = '' }) {
  const { preference, setPreference, enabled } = useTheme()
  const refs = useRef([])
  if (!enabled) return null

  const onKeyDown = (event, option) => {
    const next = nextOptionIndex(option.value, event.key)
    if (next === null) return
    event.preventDefault()
    setPreference(OPTIONS[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div className={`theme-toggle theme-toggle--${variant} ${className}`.trim()} role="radiogroup" aria-label="Tema de la aplicación">
      {OPTIONS.map((option, index) => {
        const selected = preference === option.value
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            title={option.label}
            tabIndex={selected ? 0 : -1}
            className={`theme-toggle__option${selected ? ' theme-toggle__option--selected' : ''}`}
            onClick={() => setPreference(option.value)}
            onKeyDown={(event) => onKeyDown(event, option)}
          >
            <Icon name={option.value} />
            {variant === 'segmented' && <span className="theme-toggle__label">{option.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
