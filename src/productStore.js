const { fetchProducts } = require('./googleSheets');
const config = require('./config');

let cache = { products: [], vocabulary: { tags: new Set(), categories: new Set() }, lastRefreshed: null };
let refreshing = null;

function buildVocabulary(products) {
  const tags = new Set();
  const categories = new Set();
  for (const p of products) {
    (p.tagList || []).forEach((t) => tags.add(t));
    if (p.category) categories.add(String(p.category).trim().toLowerCase());
  }
  return { tags, categories };
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const products = await fetchProducts();
      cache = {
        products,
        vocabulary: buildVocabulary(products),
        lastRefreshed: new Date(),
      };
      console.log(`[productStore] refreshed ${products.length} products at ${cache.lastRefreshed.toISOString()}`);
    } catch (err) {
      console.error('[productStore] refresh failed:', err.message);
      // Keep serving the previous cache on failure rather than wiping it out.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function getProducts() {
  return cache.products;
}

function getVocabulary() {
  return cache.vocabulary;
}

function startAutoRefresh() {
  refresh();
  setInterval(refresh, config.catalogRefreshMs);
}

module.exports = { refresh, getProducts, getVocabulary, startAutoRefresh };
