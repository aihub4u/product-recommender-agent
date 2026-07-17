const config = require('../config');

const PRICE_UNDER_RE = /(under|below|less than|cheaper than|within)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i;
const PRICE_OVER_RE = /(over|above|more than|starting from)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i;
const PRICE_BETWEEN_RE = /between\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:and|-|to)\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i;

function parsePriceFilter(query) {
  const between = query.match(PRICE_BETWEEN_RE);
  if (between) {
    const a = parseFloat(between[1].replace(/,/g, ''));
    const b = parseFloat(between[2].replace(/,/g, ''));
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const under = query.match(PRICE_UNDER_RE);
  if (under) return { min: null, max: parseFloat(under[2].replace(/,/g, '')) };
  const over = query.match(PRICE_OVER_RE);
  if (over) return { min: parseFloat(over[2].replace(/,/g, '')), max: null };
  return null;
}

function matchVocabularyTerms(query, vocabSet) {
  const q = query.toLowerCase();
  const matches = [];
  for (const term of vocabSet) {
    if (term.length < 3) continue; // skip noisy short tokens
    if (q.includes(term)) matches.push(term);
  }
  return matches;
}

function extractFilters(query, vocabulary, previousFilters = {}) {
  const filters = { ...previousFilters };
  const price = parsePriceFilter(query);
  if (price) filters.price = price;

  const tagMatches = matchVocabularyTerms(query, vocabulary.tags);
  if (tagMatches.length) {
    filters.tags = Array.from(new Set([...(filters.tags || []), ...tagMatches]));
  }

  const categoryMatches = matchVocabularyTerms(query, vocabulary.categories);
  if (categoryMatches.length) {
    filters.category = categoryMatches[0];
  }

  // Generic free-text keywords (fallback matching against name/description),
  // excluding common stopwords.
  const stopwords = new Set(['the', 'a', 'an', 'for', 'with', 'and', 'to', 'me', 'my', 'i', 'want', 'need', 'looking', 'show', 'find', 'some', 'please', 'recommend', 'suggest']);
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopwords.has(w));
  if (keywords.length) {
    filters.keywords = Array.from(new Set([...(filters.keywords || []), ...keywords]));
  }

  return filters;
}

function productMatchesFilters(product, filters) {
  if (filters.category && !product.tagList.includes(filters.category)) {
    return false;
  }
  if (filters.price && product.priceValue !== null) {
    if (filters.price.min !== null && product.priceValue < filters.price.min) return false;
    if (filters.price.max !== null && product.priceValue > filters.price.max) return false;
  }
  return true;
}

function scoreProduct(product, filters) {
  let score = 0;
  const haystack = `${product.name || ''} ${product.description || ''} ${product.tagList.join(' ')}`.toLowerCase();

  if (filters.tags) {
    for (const tag of filters.tags) {
      if (product.tagList.includes(tag)) score += 3;
    }
  }
  if (filters.category && product.tagList.includes(filters.category)) score += 3;
  if (filters.keywords) {
    for (const kw of filters.keywords) {
      if (haystack.includes(kw)) score += 1;
    }
  }
  if (filters.price && product.priceValue !== null) {
    score += 1; // satisfied the price constraint at all
  }
  return score;
}

function topCategories(vocabulary, limit = 5) {
  return Array.from(vocabulary.categories).slice(0, limit);
}

/**
 * Decides whether to ask a clarifying question or return recommendations.
 * Returns either:
 *   { action: 'clarify', question, filters }
 *   { action: 'recommend', products, filters }
 */
function decide({ query, products, vocabulary, previousFilters }) {
  const filters = extractFilters(query, vocabulary, previousFilters);

  const hasAnySignal = Boolean(filters.category || (filters.tags && filters.tags.length) || filters.price);

  // No usable signal at all (e.g. "recommend something", "help me shop") —
  // ask what category/type they're after rather than guessing.
  if (!hasAnySignal) {
    const cats = topCategories(vocabulary);
    const question = cats.length
      ? `Happy to help — what kind of product are you looking for? For example: ${cats.join(', ')}.`
      : 'Happy to help — could you tell me what kind of product you\'re looking for?';
    return { action: 'clarify', question, filters };
  }

  const matched = products
    .filter((p) => productMatchesFilters(p, filters))
    .map((p) => ({ product: p, score: scoreProduct(p, filters) }))
    .sort((a, b) => b.score - a.score);

  if (matched.length === 0) {
    const cats = topCategories(vocabulary);
    const question = `I couldn't find anything matching that. Could you broaden your request${cats.length ? ` — maybe try one of: ${cats.join(', ')}` : ''}, or adjust the price range?`;
    return { action: 'clarify', question, filters };
  }

  // Too many equally-relevant matches and no price filter yet — narrow down.
  const NARROW_THRESHOLD = 6;
  if (matched.length > NARROW_THRESHOLD && !filters.price) {
    const prices = matched.map((m) => m.product.priceValue).filter((v) => v !== null);
    if (prices.length) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      return {
        action: 'clarify',
        question: `I found quite a few options (roughly ₹${min}–₹${max}). Do you have a budget in mind, or any other preference to narrow it down?`,
        filters,
      };
    }
  }

  const top = matched.slice(0, config.maxRecommendations).map((m) => m.product);
  return { action: 'recommend', products: top, filters };
}

module.exports = { decide, extractFilters, productMatchesFilters, scoreProduct };
