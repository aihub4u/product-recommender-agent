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

module.exports = { chunkText, embedTexts, embedBatch, cosineSimilarity, retrieveTopK };
