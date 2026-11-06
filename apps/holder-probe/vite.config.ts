/**
 * Dev server for the holder lane (plan rows 6 and 30, D-026, D-058).
 *
 * - Port 3000 exactly (strictPort): 0G's Privy app ID works only on
 *   localhost:3000, 3001 or 5173 (ETHGlobal 0G prize page). 3001 is the agent
 *   API and 5173 the web app, so the holder lane takes 3000 and all three can
 *   run together.
 * - envDir is the repo root, so VITE_PRIVY_APP_ID comes from the same .env.
 *   Only VITE_-prefixed variables reach the browser; secrets never do.
 * - /zg/<network>/* is proxied to the 0G Router so the browser avoids CORS.
 *   The proxy is READ-ONLY: anything but GET is refused locally (404), so this
 *   probe can never run inference, create keys or move funds.
 */
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const ROUTERS = {
  mainnet: 'https://router-api.0g.ai',
  testnet: 'https://router-api-testnet.integratenetwork.work',
} as const;

function readOnlyProxy(network: keyof typeof ROUTERS): ProxyOptions {
  return {
    target: ROUTERS[network],
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(new RegExp(`^/zg/${network}`), '/v1'),
    // Returning false makes Vite answer 404 locally instead of proxying.
    bypass: (req) => (req.method === 'GET' ? undefined : false),
  };
}

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    host: 'localhost',
    port: 3000,
    strictPort: true,
    proxy: {
      '/zg/mainnet': readOnlyProxy('mainnet'),
      '/zg/testnet': readOnlyProxy('testnet'),
    },
  },
});
