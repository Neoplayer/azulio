import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Backend dev server (Fastify + ws). Override with VITE_API_TARGET if needed.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Only static assets are precached — game state is always live over WS.
      workbox: { globPatterns: ['**/*.{js,css,html,woff2,svg,png}'] },
      manifest: {
        name: 'Azul Online',
        short_name: 'Azul',
        description: 'Онлайн Azul — мультиплеер на изразцах',
        theme_color: '#0F2143',
        background_color: '#0F2143',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});
