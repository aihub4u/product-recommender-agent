const { google } = require('googleapis');

// Cache one authenticated sheets client per credential source (keyFile path
// or a stringified service account JSON), so projects sharing the default
// service account don't re-authenticate on every refresh.
const clientCache = new Map();

async function getClient({ keyFile, credentialsJson }) {
  const cacheKey = keyFile || `json:${credentialsJson?.client_email || 'unknown'}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);

  const authOptions = { scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
  if (credentialsJson) {
    authOptions.credentials = credentialsJson;
  } else if (keyFile) {
    authOptions.keyFile = keyFile;
  } else {
    throw new Error('No Google credentials available (neither project-specific nor default).');
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  const authClient = await auth.getClient();
  const client = google.sheets({ version: 'v4', auth: authClient });
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Reads a sheet and converts rows into product objects using the header
 * row as field names. Field names are lowercased/trimmed so the sheet
 * schema is flexible.
 *
 * @param {object} opts
 * @param {string} opts.sheetId
 * @param {string} opts.range
 * @param {string} [opts.keyFile] - path to a service account JSON file (fallback/default)
 * @param {object} [opts.credentialsJson] - parsed service account JSON (project-specific override)
 */
async function fetchProducts({ sheetId, range, keyFile, credentialsJson }) {
  if (!sheetId) {
    throw new Error('No Google Sheet ID configured for this project.');
  }
  const sheets = await getClient({ keyFile, credentialsJson });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: range || 'Sheet1',
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const products = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => !String(cell || '').trim())) continue;

    const product = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      product[header] = row[idx] !== undefined ? String(row[idx]).trim() : '';
    });

    product.id = product.id || `row-${i + 1}`;

    if (product.price !== undefined && product.price !== '') {
      const numeric = parseFloat(String(product.price).replace(/[^0-9.]/g, ''));
      product.priceValue = Number.isFinite(numeric) ? numeric : null;
    } else {
      product.priceValue = null;
    }

    const tagSource = [product.tags, product.category, product.type].filter(Boolean).join(',');
    product.tagList = tagSource
      .split(/[,|]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    products.push(product);
  }

  return products;
}

module.exports = { fetchProducts };
