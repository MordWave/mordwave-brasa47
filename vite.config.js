import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { isDarkModeEnabled } from './src/theme/flag.js'
import { buildNoFlashScript } from './src/theme/noFlashScript.js'

// Injects the synchronous theme script into <head> (before the stylesheet and before React) so the first paint
// already has the right data-theme: no light flash for dark-mode visitors. Same rollout flag as the app.
function themeInitPlugin(mode) {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  const script = `<script>${buildNoFlashScript({ enabled: isDarkModeEnabled(env) })}</script>`
  return {
    name: 'brasa47-theme-init',
    transformIndexHtml: (html) => html.replace('<!-- theme-init -->', script),
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), themeInitPlugin(mode)],
  // host: true = same as `vite --host` (binds 0.0.0.0) — lets a phone on
  // the same Wi-Fi reach the dev server via the Mac's LAN IP, while
  // localhost keeps working for dev on the Mac itself.
  server: {
    host: true,
  },
}))
