import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // host: true = same as `vite --host` (binds 0.0.0.0) — lets a phone on
  // the same Wi-Fi reach the dev server via the Mac's LAN IP, while
  // localhost keeps working for dev on the Mac itself.
  server: {
    host: true,
  },
})
