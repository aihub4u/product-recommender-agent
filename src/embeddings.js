const CHUNK_WORDS = 220; // ~800-1000 tokens is common; keeping this smaller since
                          // knowledge chunks get injected directly into the prompt
                          // alongside everything else already in there.
const CHUNK_OVERLAP_WORDS = 40;
const EMBED_BATCH_SIZE = 80;

/** Splits text into overlapping word-count chunks, preferring paragraph boundaries. */
function chunkText(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let currentWordCount = 0;

  function flush() {
    if (current.length === 0) return;
    chunks.push(current.join(' '));
    // keep the tail of the current chunk as overlap for the next one
    const words = current.join(' ').split(/\s+/);
    const overlapWords = words.slice(-CHUNK_OVERLAP_WORDS);
    current = [overlapWords.join(' ')];
    currentWordCount = overlapWords.length;
  }

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;
    if (currentWordCount + paraWords > CHUNK_WORDS && current.length > 0) {
      flush();
    }
    current.push(para);
    currentWordCount += paraWords;
    if (currentWordCount > CHUNK_WORDS * 1.5) flush(); // very long single paragraph — cut anyway
  }
  if (current.length > 0 && current.join(' ').trim()) chunks.push(current.join(' '));

  return chunks.filter((c) => c.trim().length > 20);
}

const CONCEPT_MAX_WORDS = CHUNK_WORDS * 2; // a whole heading-bounded section gets more room before we sub-chunk it
const MIN_CONCEPT_BODY_WORDS = 15; // a heading with less body than this is a bare chapter title, not worth its own chunk

// Splits a concept whose body contains one large markdown table into
// row-grouped sub-chunks, repeating the header/separator row in every
// group — the correct way to page a long table without losing the
// row/column association a plain word-count split would destroy. Any
// prose immediately before/after the table stays attached to the first/
// last group respectively. Falls back to normal paragraph chunking if no
// single table is what's making the body oversized.
function chunkConceptBody(heading, body, maxWords) {
  const tableMatch = body.match(/\|[^\n]*\|\n\|[\s\-:|]+\|\n(?:\|.*\|\n?)+/);
  if (tableMatch) {
    const tableText = tableMatch[0].trim();
    const before = body.slice(0, tableMatch.index).trim();
    const after = body.slice(tableMatch.index + tableMatch[0].length).trim();
    const tableLines = tableText.split('\n');
    const [header, separator, ...dataRows] = tableLines;

    if (dataRows.length > 0) {
      const avgRowWords = Math.max(1, dataRows.join(' ').split(/\s+/).length / dataRows.length);
      const beforeWords = before ? before.split(/\s+/).length : 0;
      const rowsPerGroup = Math.max(3, Math.floor((maxWords - beforeWords) / avgRowWords));
      const groups = [];
      for (let i = 0; i < dataRows.length; i += rowsPerGroup) {
        groups.push([header, separator, ...dataRows.slice(i, i + rowsPerGroup)].join('\n'));
      }
      return groups.map((g, idx) => {
        const parts = [heading];
        if (idx === 0 && before) parts.push(before);
        parts.push(g);
        if (idx === groups.length - 1 && after) parts.push(after);
        return parts.join('\n\n');
      });
    }
  }
  return chunkText(body).map((sub) => `${heading}\n\n${sub}`);
}

/**
 * Splits text on "## " concept-boundary headings (as emitted by
 * knowledgeExtractor's DOCX heading detection) instead of blind word-count
 * packing — each numbered section becomes one retrievable, self-contained
 * unit rather than an arbitrary slice that might split a table or a rule
 * away from the fact it governs. A bare chapter heading with little or no
 * body (e.g. "2. MEMBERSHIP..." immediately followed by "2.1 The two
 * plans") gets folded forward into its first real subsection as a
 * breadcrumb, rather than wasting a near-empty chunk of its own. A section
 * that's still unusually long after that gets sub-chunked — a large table
 * is split by row groups with the header repeated, everything else by the
 * normal word-count packer, both keeping the heading as a breadcrumb.
 * Falls back to plain chunkText() entirely when the source has no detected
 * headings (plain text, markdown without this convention, website pages).
 */
function chunkByHeadings(text) {
  if (!/^## /m.test(text)) return chunkText(text);

  const pieces = text.split(/\n(?=## )/);
  const chunks = [];
  let pendingBreadcrumb = null;

  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;

    const headingMatch = trimmed.match(/^## (.+)/);
    if (!headingMatch) {
      chunkText(trimmed).forEach((c) => chunks.push(c));
      continue;
    }

    const heading = headingMatch[1].trim();
    const body = trimmed.slice(headingMatch[0].length).trim();
    const bodyWordCount = body ? body.split(/\s+/).length : 0;

    if (bodyWordCount < MIN_CONCEPT_BODY_WORDS) {
      // Bare chapter title (or near-empty section) — carry it forward as a
      // breadcrumb onto the next concept instead of its own tiny chunk.
      pendingBreadcrumb = pendingBreadcrumb ? `${pendingBreadcrumb} > ${heading}` : heading;
      continue;
    }

    const effectiveHeading = pendingBreadcrumb ? `${pendingBreadcrumb} > ${heading}` : heading;
    pendingBreadcrumb = null;
    const fullConcept = `${effectiveHeading}\n\n${body}`;
    const wordCount = fullConcept.split(/\s+/).length;

    if (wordCount <= CONCEPT_MAX_WORDS) {
      chunks.push(fullConcept);
    } else {
      chunkConceptBody(effectiveHeading, body, CONCEPT_MAX_WORDS).forEach((c) => chunks.push(c));
    }
  }

  return chunks.filter((c) => c.trim().length > 20);
}

async function embedBatch({ apiKey, model, texts }) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'text-embedding-3-small', input: texts }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI embeddings error ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.data.map((d) => d.embedding);
}

/** Embeds an array of text chunks, batching requests. Returns parallel array of vectors. */
async function embedTexts({ apiKey, model, texts }) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const batchVectors = await embedBatch({ apiKey, model, texts: batch });
    vectors.push(...batchVectors);
  }
  return vectors;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Given a query embedding and a project's in-memory chunk list
 * ([{ content, embedding, sourceName }]), returns the top-K most similar
 * chunks with their similarity scores.
 */
function retrieveTopK(queryEmbedding, chunks, k = 5) {
  return chunks
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

module.exports = { chunkText, chunkByHeadings, embedTexts, embedBatch, cosineSimilarity, retrieveTopK };
