import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { devServerMiddleware } from './server/middleware.mjs';

// The dev server runs the same request-time pieces the production server does
// (runtime env script, /media proxy, session gate), so `bun run dev` behaves like
// the container: see server/middleware.mjs for the single implementation.
function itsaplanServer() {
  return {
    name: 'itsaplan-server',
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(devServerMiddleware());
    },
  };
}

export default defineConfig(({ mode }) => {
  // `apps/web/.env` holds the origins for local development. Vite only exposes an
  // env file to the bundle; the middleware reads the process, as the container
  // does, so the values are copied there — without overriding anything the shell
  // (or compose) already set.
  for (const [key, value] of Object.entries(loadEnv(mode, import.meta.dirname, ''))) {
    process.env[key] ??= value;
  }

  return {
    define: {
      'process.env': {},
    },
    // `@/*` resolves through the tsconfig paths, natively in Vite 8.
    resolve: { tsconfigPaths: true },
    plugins: [tailwindcss(), reactRouter(), itsaplanServer()],
    server: {
      // 0.0.0.0 so the container (and a remote preview) can reach it; the port
      // matches what the rest of the stack expects from the web service.
      host: true,
      port: Number(process.env.PORT ?? process.env.WEB_PORT ?? 5001),
      allowedHosts: true,
    },
    // isomorphic-dompurify pulls jsdom, which is Node-only; the browser build uses
    // the bundled DOMPurify path instead of trying to resolve jsdom's internals.
    optimizeDeps: {
      exclude: ['isomorphic-dompurify'],
    },
  };
});
