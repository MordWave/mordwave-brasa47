const paths = {
  burger: (
    <g>
      <path d="M6 13c0-4.5 4.5-8 10-8s10 3.5 10 8" />
      <circle cx="12" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="20" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <path d="M5 13.5h22a1.6 1.6 0 0 1 1.6 1.8c-.4 2.7-2.3 3.7-4.1 3.7H7.5c-1.8 0-3.7-1-4.1-3.7a1.6 1.6 0 0 1 1.6-1.8Z" />
      <path d="M6.5 21h19l-1.1 4a2 2 0 0 1-1.9 1.5H9.5a2 2 0 0 1-1.9-1.5l-1.1-4Z" />
    </g>
  ),
  pizza: (
    <g>
      <path d="M16 5 25.5 23.5A10.5 10.5 0 0 1 6.5 23.5Z" />
      <path d="M9.8 19.8a8.6 8.6 0 0 0 12.4 0" />
      <circle cx="14.2" cy="13.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="15.8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.3" cy="18.2" r="1.3" fill="currentColor" stroke="none" />
    </g>
  ),
  drink: (
    <g>
      <path d="M10 6h12l-2 18a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2L10 6Z" />
      <path d="M9 6h14" />
      <path d="M13 11c1 1 2 1 3 0s2-1 3 0" />
    </g>
  ),
  fries: (
    <g>
      <path d="M7 13h18l-2 12a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2L7 13Z" />
      <path d="M11 13V8M15 13V6M17 13V6M21 13V8" />
    </g>
  ),
  dessert: (
    <g>
      <path d="M16 6c1.6 0 2.6 1.4 2.2 2.8C20.4 9.4 22 11.4 22 14H10c0-2.6 1.6-4.6 3.8-5.2C13.4 7.4 14.4 6 16 6Z" />
      <path d="M8 14h16l-1.6 10.4a2 2 0 0 1-2 1.6H11.6a2 2 0 0 1-2-1.6L8 14Z" />
    </g>
  ),
  star: (
    <g>
      <path d="M16 4.5 18.8 13.2 27.5 16 18.8 18.8 16 27.5 13.2 18.8 4.5 16 13.2 13.2Z" />
    </g>
  ),
  // Added for the category dropdown of the shareable menu. The table (QR) menu never asks for them: it only uses the names above.
  coffee: (
    <g>
      <path d="M6 12h16v6.5a6.5 6.5 0 0 1-6.5 6.5h-3A6.5 6.5 0 0 1 6 18.5V12Z" />
      <path d="M22 14.5h2.2a3 3 0 0 1 0 6H21.6" />
      <path d="M11 4.5c-1.2 1.6 1.2 2.6 0 4.5M16 4.5c-1.2 1.6 1.2 2.6 0 4.5" />
      <path d="M5 28h18" />
    </g>
  ),
  beer: (
    <g>
      <path d="M7.5 11h14v14a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2V11Z" />
      <path d="M21.5 14h2.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2.5" />
      <path d="M6.5 11a3 3 0 0 1 2.2-4.8 3.6 3.6 0 0 1 6.4-.4A3.2 3.2 0 0 1 21.5 8.5a2.6 2.6 0 0 1 0 2.5" />
      <path d="M12 15v8M17 15v8" />
    </g>
  ),
  wine: (
    <g>
      <path d="M9.5 4h13c0 7.4-1.8 11.5-6.5 11.5S9.5 11.4 9.5 4Z" />
      <path d="M10 9.5h12" />
      <path d="M16 15.5V26" />
      <path d="M11 27.5h10" />
    </g>
  ),
  bowl: (
    <g>
      <path d="M4.5 14h23c0 6.8-5 11-11.5 11S4.5 20.8 4.5 14Z" />
      <path d="M11 28h10" />
      <path d="M12 10.5c0-2 2-2.5 2-4.5M18 10.5c0-2 2-2.5 2-4.5" />
    </g>
  ),
  dish: (
    <g>
      <path d="M9 5v7a3.5 3.5 0 0 0 7 0V5" />
      <path d="M12.5 5v7M12.5 15.5V27" />
      <path d="M23.5 27V5c-3 2-4.6 6-4.6 10h4.6" />
    </g>
  ),
}

export function CategoryIcon({ name, size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] || paths.burger}
    </svg>
  )
}

// Share (an arrow leaving a tray), drawn like the icons of the theme selector: 16px, round 2px stroke. Decorative: the button that holds
// it carries the text "Compartir".
export function ShareIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  )
}

// Chevron of the category selector of the shareable menu (phones): 16px, round 2px stroke, like the share and theme icons. Decorative.
export function ChevronDownIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
