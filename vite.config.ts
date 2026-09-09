import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Lazy-loaded chunks (recharts, jspdf) no longer affect initial load, so allow >500 kB.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Named vendor chunks keep browser caching stable across app/library changes.
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
