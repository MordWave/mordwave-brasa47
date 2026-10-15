import { useContext } from 'react'
import { ThemeContext } from './themeContext.js'

// { preference: 'system'|'light'|'dark', resolvedTheme: 'light'|'dark', systemTheme, enabled, setPreference(p) }
export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>')
  return value
}
