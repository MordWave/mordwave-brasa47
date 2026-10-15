// Build-time gate for the developer tools, separate from the dark-mode flag (theme/flag.js).
// Off unless the build/dev server is started with VITE_DEV_TOOLS_ENABLED=1:
//     VITE_DEV_TOOLS_ENABLED=1 npm run dev
// It is a literal comparison on purpose: Vite replaces it at build time, so with the gate off the lazy-loaded
// toolbar (and its stylesheet) is dropped from the production bundle altogether.
export const DEV_TOOLS_BUILD_ENABLED = import.meta.env.VITE_DEV_TOOLS_ENABLED === '1'
