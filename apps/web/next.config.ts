import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @powersync/web loads a WASM SQLite build (wa-sqlite) via a Web Worker.
  // Per PowerSync's official Next.js docs: asyncWebAssembly + topLevelAwait
  // experiments, plus a loader rule for .wasm files, are all required —
  // asyncWebAssembly alone (what this used to say) is not sufficient.
  webpack: (config, { isServer }) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      topLevelAwait: true,
    };

    if (!isServer) {
      config.module.rules.push({
        test: /\.wasm$/,
        type: 'asset/resource',
      });
    }

    return config;
  },
};

export default nextConfig;
