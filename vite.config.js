import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { assertCloudflarePagesTurnstileBuild } from './scripts/turnstile-build-guard.mjs'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  if (command === 'build') assertCloudflarePagesTurnstileBuild(process.env)
  return {
    plugins: [react()],
  }
})
