import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { apiDirFor, createApiShim } from './server/vercelShim';

// Serves api/*.ts during `npm run dev`, through the same shim the self-hosted
// `api` container uses (server/vercelShim.ts). Without it the dev server
// answered every /api/* call with index.html, so config, TURN, Onshape sign-in
// and capture silently fell back or failed locally.
function apiRoutes(): Plugin {
  return {
    name: 'viewpoint-api-routes',
    apply: 'serve',
    configureServer(server) {
      // Server-side secrets (no VITE_ prefix) from .env / .env.local, the way
      // Vercel injects them into functions. process.env only: nothing here is
      // exposed to the client bundle, which still sees VITE_* alone.
      const env = loadEnv(server.config.mode, server.config.root, '');
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      const handle = createApiShim({
        apiDir: apiDirFor(server.config.root),
        importModule: (file) => server.ssrLoadModule(file),
        log: (...args) => server.config.logger.error(args.map(String).join(' ')),
      });
      server.middlewares.use((req, res, next) => {
        handle(req, res).then((handled) => {
          if (!handled) next();
        }, next);
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), apiRoutes()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  },
  optimizeDeps: {
    // occt-import-js is CommonJS and is only ever imported from utils/cadWorker.ts,
    // which the dependency scanner never reaches (a worker is created with
    // `new URL(...)`, not imported). Pre-bundling it by hand is what lets that
    // worker do `import occtimportjs from 'occt-import-js'` under `npm run dev`.
    include: ['occt-import-js'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-three': ['three', '@react-three/fiber', '@react-three/drei'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'vendor-msal': ['@azure/msal-browser'],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
});
