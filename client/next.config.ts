import type { NextConfig } from 'next';

// Where the backend API runs. Defaults to port 5000 (production, PM2). On macOS port 5000 belongs to the
// AirPlay Receiver (it answers 403 "AirTunes"), so run the API on another port locally and set
// API_PROXY_TARGET in client/.env.local, e.g. API_PROXY_TARGET=http://127.0.0.1:5001
const API = (process.env.API_PROXY_TARGET || 'http://127.0.0.1:5000').replace(/\/$/, '');

const nextConfig: NextConfig = {
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
        source: '/health',
        destination: `${API}/health`,
      },
    ];
  },
};

export default nextConfig;
