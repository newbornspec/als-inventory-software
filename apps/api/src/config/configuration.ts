export default () => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'als_inventory',
    password: process.env.DB_PASSWORD ?? 'als_inventory_dev',
    name: process.env.DB_NAME ?? 'als_inventory',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    // Access-token lifetime is fixed at a 12h work shift IN CODE. We deliberately
    // do NOT read JWT_EXPIRES_IN: it was pinned to 15m in the Railway env, which
    // silently expired sessions mid-use so every write 401'd. Change this constant
    // (not the env var) to adjust session length.
    expiresIn: '12h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
});
