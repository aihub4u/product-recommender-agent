require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || '',
  // Fallback Google service account used by any project that doesn't supply
  // its own service account JSON in its sheet config.
  defaultGoogleServiceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || '',
  defaultCatalogRefreshMs: parseInt(process.env.CATALOG_REFRESH_MS || '300000', 10),
  defaultSessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '900000', 10),
  defaultMaxRecommendations: 3,
};
