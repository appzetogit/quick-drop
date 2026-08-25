import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const foodSrc = path.resolve(__dirname, './src/modules/Food')
const servicesApi = path.resolve(__dirname, './src/services/api')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // More specific first so @food/api/* resolves to services (no backend)
      '@food/api/axios': path.resolve(servicesApi, 'axios.js'),
      '@food/api/config': path.resolve(servicesApi, 'config.js'),
      '@food/api': servicesApi,
      '@food': foodSrc,
      '@delivery': path.resolve(__dirname, './src/modules/DeliveryV2'),
      '@sp': path.resolve(__dirname, './src/modules/ServiceProvider'),
      '@/assets': path.resolve(__dirname, './src/modules/Taxi/assets'),
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  optimizeDeps: {
    include: [
      '@emotion/react',
      '@emotion/styled',
      '@mui/material',
      '@mui/x-date-pickers',
    ],
  },
  build: {
    /**
     * Keep the previous build's chunks instead of wiping dist.
     *
     * Filenames are content-hashed, so a rebuild emits new names and deletes the
     * old ones. Any browser still holding the previous index.html -- a tab left
     * open across a deploy, or a page served before it -- then 404s the moment it
     * lazy-loads a route, which is what "Failed to fetch dynamically imported
     * module" is. Leaving the old chunks in place lets those sessions finish.
     *
     * index.html is still overwritten each build, so new visitors always get the
     * current bundle. dist grows by roughly one build's worth of chunks each
     * time; prune what is older than a couple of weeks when it matters:
     *   find dist/assets -type f -mtime +14 -delete
     */
    emptyOutDir: false,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Backend API (default 5000)
      '/api/v1': {
        target: process.env.VITE_BACKEND_PROXY_TARGET || 'https://k9rides.onrender.com',
        changeOrigin: true,
      },
    },
  },
});
