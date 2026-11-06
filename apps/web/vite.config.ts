/**
 * Dev server and build for the agent's web app (plan row 27).
 *
 * - Port 5173 (strictPort). The holder lane (apps/holder-probe) runs on 3000
 *   and the agent API on 3001, so all three can run together (D-058).
 * - /api is proxied to the agent API (SERVER_PORT from the repo-root .env,
 *   default 3001). The browser then sees one origin: no CORS, and the HttpOnly
 *   session cookie just works. The proxy streams, so SSE passes through.
 * - Only VITE_-prefixed variables could reach the browser; this app reads none.
 */
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const apiPort = env['SERVER_PORT'] ?? '3001';
  return {
    plugins: [react()],
    envDir: '../..',
    server: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
    preview: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
