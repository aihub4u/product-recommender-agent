const { google } = require('googleapis');
const config = require('./config');

let sheetsClient = null;

async function getClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/**
 * Reads the sheet and converts rows into product objects using the header
 * row as field names. Field names are lowercased/trimmed so the sheet
 * schema is flexible (e.g. "Product Name" -> "product name").
 * A row is skipped if every cell is blank.
 */
async function fetchProducts() {
  if (!config.google.sheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set');
  }
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: config.google.range,
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

    // Normalize a stable id: use an explicit "id" column if present,
    // otherwise fall back to the row number.
    product.id = product.id || `row-${i + 1}`;

    // Normalize price to a number if parseable, kept alongside raw string.
    if (product.price !== undefined && product.price !== '') {
      const numeric = parseFloat(String(product.price).replace(/[^0-9.]/g, ''));
      product.priceValue = Number.isFinite(numeric) ? numeric : null;
    } else {
      product.priceValue = null;
    }

    // Normalize tags/category into an array for matching, tolerant of
    // comma or pipe separated values.
    const tagSource = [product.tags, product.category, product.type]
      .filter(Boolean)
      .join(',');
    product.tagList = tagSource
      .split(/[,|]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    products.push(product);
  }

  return products;
}

module.exports = { fetchProducts };
