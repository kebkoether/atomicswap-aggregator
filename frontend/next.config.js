/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {},
  async headers() {
    return [
      {
        // SEP-1 requires the stellar.toml to be readable cross-origin so
        // wallets and ecosystem scanners (Freighter/Blockaid, stellar.expert)
        // can fetch it from any context.
        source: '/.well-known/stellar.toml',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
