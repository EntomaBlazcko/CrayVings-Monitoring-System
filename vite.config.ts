import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Pages are lazy-loaded, so their chunks (recharts, jspdf) are only fetched
    // on demand. Allow them to exceed the default 500 kB warning threshold —
    // they no longer affect the initial page load.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Named vendor chunks improve browser caching: changing app code or a
        // single library doesn't invalidate the cached chunks for the others.
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('jspdf')) return 'pdf'
            if (id.includes('recharts')) return 'recharts'
            if (id.includes('react')) return 'react'
          }
        },
      },
    },
  },
})
