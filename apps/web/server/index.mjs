// The production server for the SPA build: static assets from build/client, the
// request-time middleware shared with dev (runtime env, /media proxy, session gate),
// and index.html for every remaining path so the client router owns routing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import { envScriptHandler, gateHandler, mediaHandler } from './middleware.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'build', 'client');

const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 5001);
const host = process.env.HOSTNAME ?? '0.0.0.0';

const app = express();

app.disable('x-powered-by');
app.use(compression());

app.get('/__env.js', envScriptHandler);
app.use('/media', (req, res, next) => {
  // mediaHandler reads the full path off the request, which express has already
  // stripped the mount point from.
  req.url = `/media${req.url}`;
  mediaHandler(req, res).catch(next);
});

// Fingerprinted bundles are immutable; everything else in public/ is not.
app.use(
  '/assets',
  express.static(path.join(clientDir, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }),
);
app.use(express.static(clientDir, { maxAge: '1h', index: false }));

app.use(gateHandler);

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

app.listen(port, host, () => {
  console.log(`web listening on http://${host}:${port}`);
});
