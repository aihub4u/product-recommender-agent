const express = require('express');
const productStore = require('../productStore');
const sessionStore = require('../sessionStore');
const engine = require('../engines');

const router = express.Router();

function formatProduct(p) {
  const { tagList, priceValue, ...rest } = p;
  return { ...rest, price: priceValue !== null ? priceValue : p.price };
}

router.post('/recommend', async (req, res) => {
  try {
    const { query, sessionId } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'A non-empty "query" string is required.' });
    }

    const { id, session } = sessionStore.getOrCreate(sessionId);
    session.history.push({ role: 'user', content: query.trim() });

    const products = productStore.getProducts();
    if (products.length === 0) {
      return res.status(503).json({
        error: 'Product catalog is not loaded yet. Check GOOGLE_SHEET_ID / service account configuration.',
      });
    }

    const result = await engine.decide({
      query: query.trim(),
      products,
      vocabulary: productStore.getVocabulary(),
      previousFilters: session.filters,
      history: session.history.slice(0, -1), // history before this turn
    });

    session.filters = result.filters || session.filters;

    if (result.action === 'clarify') {
      session.history.push({ role: 'assistant', content: result.question });
      return res.json({ sessionId: id, action: 'clarify', question: result.question });
    }

    session.history.push({
      role: 'assistant',
      content: `Recommended: ${result.products.map((p) => p.name || p.id).join(', ')}`,
    });

    return res.json({
      sessionId: id,
      action: 'recommend',
      products: result.products.map(formatProduct),
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    });
  } catch (err) {
    console.error('[recommend] error:', err);
    return res.status(500).json({ error: 'Internal error while generating a recommendation.' });
  }
});

router.get('/health', (req, res) => {
  const products = productStore.getProducts();
  res.json({
    status: 'ok',
    engine: engine.engineInUse,
    productsLoaded: products.length,
  });
});

module.exports = router;
