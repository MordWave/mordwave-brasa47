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
