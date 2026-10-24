import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/how-it-works': 'http://localhost:8787',
      '/profile': 'http://localhost:8787',
      // Forward retired URLs too, rather than serving Vite's studio fallback.
      '/pricing': 'http://localhost:8787',
      '/robots.txt': 'http://localhost:8787',
      '/sitemap.xml': 'http://localhost:8787'
    }
  }
});
