import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The dashboard and the API share an origin in development for the same
    // reason they do in production: the session lives in a SameSite=Lax cookie,
    // which only behaves like a defence when it is same-origin. Proxying /api
    // makes the browser treat the request as same-origin, so the dev experience
    // matches what `npm run build` + `npm run server` will actually do.
    //
    // The prefix is forwarded verbatim rather than rewritten: server.cjs strips
    // it, so there is one routing table instead of two.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
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
