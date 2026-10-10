import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/graphql',
        destination: 'http://127.0.0.1:5001/graphql',
      },
      {
        source: '/auth/:path*',
        destination: 'http://127.0.0.1:5001/auth/:path*',
      },
      {
        source: '/webhook',
        destination: 'http://127.0.0.1:5001/webhook',
      },
      {
        source: '/webhook/:path*',
        destination: 'http://127.0.0.1:5001/webhook/:path*',
      },
      {
        // socket.io-client requests this exact path with no trailing slash,
        // but the Socket.IO server only answers at '/socket.io/'.
        source: '/socket.io',
        destination: 'http://127.0.0.1:5001/socket.io/',
      },
      {
        source: '/socket.io/:path*',
        destination: 'http://127.0.0.1:5001/socket.io/:path*',
      },
      {
        source: '/health',
        destination: 'http://127.0.0.1:5001/health',
      },
    ];
  },
};

export default nextConfig;
