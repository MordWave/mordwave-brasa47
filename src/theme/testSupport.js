// Test helper: renders the REAL React components to static HTML inside node:test, without adding a DOM library.
// esbuild (already installed with Vite) compiles the JSX of our own files; npm packages stay external and are
// resolved by Node, so the compiled file is written under node_modules/.cache (gitignored) next to them.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Compiles `contents` (JSX allowed, relative imports resolve from src/) and imports the result.
export async function loadModule(contents, { plugins = [] } = {}) {
  const srcDir = fileURLToPath(new URL('..', import.meta.url))
  const result = await build({
    stdin: { resolveDir: srcDir, loader: 'jsx', contents },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins,
    define: { 'import.meta.env': '{"VITE_API_URL":"http://api.test.invalid"}' },
  })
  const dir = fileURLToPath(new URL('../../node_modules/.cache/brasa47-test/', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

export function loadRenderer() {
  return loadModule(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import ThemeToggle from './components/ThemeToggle.jsx'
    import { ThemeContext } from './theme/themeContext.js'
    export const renderToggle = (value, props = {}) =>
      renderToStaticMarkup(
        <ThemeContext.Provider value={{ setPreference() {}, systemTheme: 'light', ...value }}>
          <ThemeToggle {...props} />
        </ThemeContext.Provider>,
      )
  `)
}
