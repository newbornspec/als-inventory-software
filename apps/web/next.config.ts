import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @powersync/web loads a WASM SQLite build (wa-sqlite) in a worker.
  // asyncWebAssembly is the commonly-needed piece for that to bundle correctly;
  // verify against @powersync/web's current Next.js integration guide when
  // actually installing — this has shifted across SDK versions before.
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;
