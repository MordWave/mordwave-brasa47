// Test helper: renders the REAL React components to static HTML inside node:test, without adding a DOM library.
// esbuild (already installed with Vite) compiles the JSX of our own files; npm packages stay external and are
// resolved by Node, so the compiled file is written under node_modules/.cache (gitignored) next to them.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function loadRenderer() {
  const srcDir = fileURLToPath(new URL('..', import.meta.url))
  const result = await build({
    stdin: {
      resolveDir: srcDir,
      loader: 'jsx',
      contents: `
        import { renderToStaticMarkup } from 'react-dom/server'
        import ThemeToggle from './components/ThemeToggle.jsx'
        import { ThemeContext } from './theme/themeContext.js'
        export const renderToggle = (value, props = {}) =>
          renderToStaticMarkup(
            <ThemeContext.Provider value={{ setPreference() {}, systemTheme: 'light', ...value }}>
              <ThemeToggle {...props} />
            </ThemeContext.Provider>,
          )
      `,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'silent',
  })
  const dir = fileURLToPath(new URL('../../node_modules/.cache/brasa47-test/', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `render-${Date.now()}.mjs`)
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}
