import type { NextConfig } from 'next';

// Where the backend API runs. Defaults to port 5000 (production, PM2). On macOS port 5000 belongs to the
// AirPlay Receiver (it answers 403 "AirTunes"), so run the API on another port locally and set
// API_PROXY_TARGET in client/.env.local, e.g. API_PROXY_TARGET=http://127.0.0.1:5001
const API = (process.env.API_PROXY_TARGET || 'http://127.0.0.1:5000').replace(/\/$/, '');

// File uploads from the chat pass through these rewrites to the API. Next.js copies a forwarded request's body only
// up to experimental.proxyClientMaxBodySize (default 10 MB; a bigger upload is cut off and then times out) and waits
// experimental.proxyTimeout for the API (default 30 s). Keep these in line with the API: documents up to 100 MB
// (server: DOCUMENT_MAX_BYTES and the /documents route's express.raw limit; client: lib/media.ts). The API answers
// only after the file is stored and sent on to WhatsApp, which can take minutes for a large file.
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const nextConfig: NextConfig = {
  experimental: {
    // A little over the largest upload, so the API (not this proxy) decides what is too large and says so
    proxyClientMaxBodySize: UPLOAD_MAX_BYTES + 1024 * 1024,
    proxyTimeout: UPLOAD_TIMEOUT_MS,
  },
  // socket.io-client's browser transport requests '/socket.io/...' WITH a trailing slash. Next's own default
  // trailing-slash redirect (trailingSlash: false) answered that with a 308 before the /socket.io/:path* rewrite
  // below ever got to run - not fixable from rewrites or middleware, since this redirect happens earlier than both.
  // A WebSocket upgrade can't follow an HTTP redirect, so every ws:// connection failed outright (visible in the
  // browser console as repeated "WebSocket connection ... failed", a new sid each retry); polling still worked
  // because XHR/fetch does follow redirects, so the app kept working in degraded, polling-only real-time mode.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: '/graphql',
        destination: `${API}/graphql`,
      },
      {
        source: '/auth/:path*',
        destination: `${API}/auth/:path*`,
      },
      {
        source: '/webhook',
        destination: `${API}/webhook`,
      },
      {
        source: '/webhook/:path*',
        destination: `${API}/webhook/:path*`,
      },
      {
        // socket.io-client requests this exact path with no trailing slash,
        // but the Socket.IO server only answers at '/socket.io/'.
        source: '/socket.io',
        destination: `${API}/socket.io/`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${API}/socket.io/:path*`,
      },
      {
        // Sending an image or document from the chat, and a message's stored copy. Only these API paths: the
        // /inbox page itself is served by Next.
        source: '/inbox/conversations/:id/images',
        destination: `${API}/inbox/conversations/:id/images`,
      },
      {
        source: '/inbox/conversations/:id/documents',
        destination: `${API}/inbox/conversations/:id/documents`,
      },
      {
        source: '/inbox/conversations/:id/voice',
        destination: `${API}/inbox/conversations/:id/voice`,
      },
      {
        // A template with an image/video/document header (the file is the body)
        source: '/inbox/conversations/:id/template',
        destination: `${API}/inbox/conversations/:id/template`,
      },
      {
        // Settings → Templates: creating/editing a template with a sample header file
        source: '/templates',
        destination: `${API}/templates`,
      },
      {
        source: '/templates/:id',
        destination: `${API}/templates/:id`,
      },
      {
        source: '/inbox/messages/:id/media',
        destination: `${API}/inbox/messages/:id/media`,
      },
      {
        source: '/me/avatar',
        destination: `${API}/me/avatar`,
      },
      {
        source: '/health',
        destination: `${API}/health`,
      },
      {
        // Report exports (e.g. /reports/assignments.csv). ':path+' needs at least one segment, so the
        // /reports page itself is still served by Next.
        source: '/reports/:path+',
        destination: `${API}/reports/:path+`,
      },
    ];
  },
};

export default nextConfig;
