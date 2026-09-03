const MIN_USABLE_CHARS = 4; // below this, a truncated fragment reads as broken, not short

/**
 * Fits `value` within maxChars WITHOUT cutting mid-word. Returns the
 * trimmed string if it already fits. If too long, cuts at the last word
 * boundary that fits. Returns null if no word boundary fits within
 * maxChars, or what's left is too short to read as a real phrase — the
 * caller should treat null as "nothing usable here," not show a fragment.
 */
function fitToWordBoundary(value, maxChars) {
  const str = String(value || '').trim();
  if (!str) return null;
  if (str.length <= maxChars) return str;

  const truncated = str.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace < MIN_USABLE_CHARS) return null;

  const atBoundary = truncated.slice(0, lastSpace).trim();
  return atBoundary.length >= MIN_USABLE_CHARS ? atBoundary : null;
}

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Pool-constrained mode: the model was asked to select from a pre-approved
 * list, so every entry in `pool` is already guaranteed to fit maxChars and
 * read as a sensible standalone phrase (the operator wrote them that way).
 * This just validates the model's picks are genuinely members of the pool
 * (exact match, case/whitespace-insensitive) and backfills from unused pool
 * entries if the model picked fewer than 2 valid ones or hallucinated text
 * that isn't in the pool — so the result is always 2 real pool entries
 * whenever the pool has at least 2 to offer, never model-improvised text.
 */
function pickFromPool(modelPicks, pool) {
  const cleanPool = (Array.isArray(pool) ? pool : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (cleanPool.length === 0) return [];

  const poolByNormalized = new Map(cleanPool.map((p) => [normalize(p), p]));
  const picked = [];
  const usedNormalized = new Set();

  for (const guess of (Array.isArray(modelPicks) ? modelPicks : [])) {
    const match = poolByNormalized.get(normalize(guess));
    if (match && !usedNormalized.has(normalize(match))) {
      picked.push(match);
      usedNormalized.add(normalize(match));
    }
    if (picked.length >= 2) break;
  }

  // Backfill from the pool itself if the model's picks were invalid/insufficient.
  for (const candidate of cleanPool) {
    if (picked.length >= 2) break;
    if (!usedNormalized.has(normalize(candidate))) {
      picked.push(candidate);
      usedNormalized.add(normalize(candidate));
    }
  }

  return picked.slice(0, 2);
}

/**
 * Turns whatever the model produced into a guaranteed exactly-3-item
 * quick-reply array. If `pool` has entries, uses pool-constrained selection
 * (the robust path — every non-final entry is a pre-approved phrase). If
 * no pool is configured, falls back to free-text word-boundary fitting.
 * The 3rd item is always the operator-configured final label, appended by
 * this function, never by the model.
 */
function buildQuickReplies(dynamicOptions, finalLabel, maxChars, pool) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 20;
  const hasPool = Array.isArray(pool) && pool.filter((p) => String(p || '').trim()).length > 0;

  let cleaned;
  if (hasPool) {
    cleaned = pickFromPool(dynamicOptions, pool);
  } else {
    cleaned = (Array.isArray(dynamicOptions) ? dynamicOptions : [])
      .map((o) => fitToWordBoundary(o, cap))
      .filter(Boolean)
      .slice(0, 2);
  }

  while (cleaned.length < 2) {
    cleaned.push(fitToWordBoundary('Tell me more', cap) || 'More info');
  }

  cleaned.push(fitToWordBoundary(finalLabel, cap) || fitToWordBoundary('Enroll Now', cap) || 'Enroll');
  return cleaned;
}

module.exports = { buildQuickReplies, fitToWordBoundary, pickFromPool };
