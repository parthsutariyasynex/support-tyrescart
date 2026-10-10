import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/graphql',
        destination: 'http://127.0.0.1:5000/graphql',
      },
      {
        source: '/auth/:path*',
        destination: 'http://127.0.0.1:5000/auth/:path*',
      },
      {
        source: '/webhook',
        destination: 'http://127.0.0.1:5000/webhook',
      },
      {
        source: '/webhook/:path*',
        destination: 'http://127.0.0.1:5000/webhook/:path*',
      },
      {
        // socket.io-client requests this exact path with no trailing slash,
        // but the Socket.IO server only answers at '/socket.io/'.
        source: '/socket.io',
        destination: 'http://127.0.0.1:5000/socket.io/',
      },
      {
        source: '/socket.io/:path*',
        destination: 'http://127.0.0.1:5000/socket.io/:path*',
      },
      {
        source: '/health',
        destination: 'http://127.0.0.1:5000/health',
      },
    ];
  },
};

export default nextConfig;
