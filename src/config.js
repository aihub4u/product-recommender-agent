require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  google: {
    keyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json',
    sheetId: process.env.GOOGLE_SHEET_ID || '',
    range: process.env.GOOGLE_SHEET_RANGE || 'Sheet1',
  },
  catalogRefreshMs: parseInt(process.env.CATALOG_REFRESH_MS || '300000', 10),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '900000', 10),
  maxRecommendations: 3,
};
