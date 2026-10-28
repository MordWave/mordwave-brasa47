import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { MENU_SHELL_FILE, buildMenuShell } from './src/seo/menuShell.js'
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

// Writes dist/menu-shell.html next to index.html: the page the web server turns into /menu/<slug> with the restaurant's link-preview
// tags in the initial HTML (see src/seo/menuShell.js and the Caddyfile). Build only; dev and preview serve index.html as before.
function menuShellPlugin() {
  return {
    name: 'brasa47-menu-shell',
    apply: 'build',
    writeBundle(options) {
      const indexPath = join(options.dir, 'index.html')
      writeFileSync(join(options.dir, MENU_SHELL_FILE), buildMenuShell(readFileSync(indexPath, 'utf8')))
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), themeInitPlugin(mode), menuShellPlugin()],
  // host: true = same as `vite --host` (binds 0.0.0.0) — lets a phone on
  // the same Wi-Fi reach the dev server via the Mac's LAN IP, while
  // localhost keeps working for dev on the Mac itself.
  server: {
    host: true,
  },
}))
