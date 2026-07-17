// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// When building for Capacitor (mobile) we need relative asset paths so the
// WebView can load them from file://. Web builds use '/' so React Router works.
const isMobileBuild = process.env.VITE_BUILD_FOR_CAPACITOR === 'true';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: isMobileBuild ? './' : '/',
  // --- API Proxy Configuration ---
  server: {
    port: 3005,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
        ws: true,   // proxy WebSocket upgrades
      },
    },

    // ── Exclude Capacitor native projects from the file watcher ──────────────
    // Without this, Vite hot-reloads android/app/.../public/index.html and
    // ios/App/.../public/index.html every time cap sync copies assets there.
    watch: {
      ignored: [
        '**/android/**',
        '**/ios/**',
        '**/.git/**',
        '**/node_modules/**',
      ],
    },

    // ── Block .env files from being served over HTTP ──────────────────────────
    // Vite's built-in protection should already cover this, but being explicit
    // prevents the "outside of serving allow list" warnings in the console.
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{pem,crt,key}',
      ],
    },
  },
  // --- FIX "global is not defined" + expose Capacitor build flag ---
  define: {
    'global': {},
    '__CAPACITOR_BUILD__': JSON.stringify(isMobileBuild),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React — cached long-term, changes rarely
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // Markdown / math rendering
          'vendor-markdown': ['marked', 'dompurify', 'katex', 'prismjs'],
          // Heavy visualization libs — loaded only when needed
          'vendor-charts': ['chart.js', 'react-chartjs-2'],
          'vendor-network': ['vis-network', 'react-vis-network-graph', 'dagre'],
          'vendor-reactflow': ['reactflow'],
          // Communication
          'vendor-io': ['axios', 'socket.io-client'],
          // Icon library
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
})
