import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    build: {
      rollupOptions: {
        // Her window, the command bar, and the first-run window.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          bar: resolve(__dirname, 'src/renderer/bar.html'),
          setup: resolve(__dirname, 'src/renderer/setup.html'),
          plan: resolve(__dirname, 'src/renderer/plan.html'),
          activity: resolve(__dirname, 'src/renderer/activity.html')
        }
      }
    }
  }
})
