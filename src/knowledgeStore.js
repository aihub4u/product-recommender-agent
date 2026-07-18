const db = require('./db');
const { extractFromFile, crawlWebsite } = require('./knowledgeExtractor');
const { chunkText, embedTexts, retrieveTopK } = require('./embeddings');

// slug -> [{ id, content, embedding, sourceId, sourceName }]
const chunkCache = new Map();

async function loadChunksForProject(projectId, slug) {
  const { rows } = await db.query(
    'SELECT id, source_id, source_name, content, embedding FROM knowledge_chunks WHERE project_id = $1',
    [projectId]
  );
  const chunks = rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    content: r.content,
    embedding: typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding,
  }));
  chunkCache.set(slug, chunks);
  return chunks;
}

function getCachedChunks(slug) {
  return chunkCache.get(slug) || [];
}

function clearChunkCache(slug) {
  chunkCache.delete(slug);
}

async function listSources(projectId) {
  const { rows } = await db.query(
    'SELECT * FROM knowledge_sources WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    status: r.status,
    errorMessage: r.error_message,
    chunkCount: r.chunk_count,
    pagesIndexed: r.pages_indexed,
    lastIndexedAt: r.last_indexed_at,
  }));
}

async function createSourceRow(projectId, { type, name }) {
  const { rows } = await db.query(
    `INSERT INTO knowledge_sources (project_id, type, name, status) VALUES ($1,$2,$3,'indexing') RETURNING *`,
    [projectId, type, name]
  );
  return rows[0];
}

async function saveChunks(projectId, sourceId, sourceName, chunks, embeddings) {
  await db.query('DELETE FROM knowledge_chunks WHERE source_id = $1', [sourceId]);
  for (let i = 0; i < chunks.length; i++) {
    await db.query(
      `INSERT INTO knowledge_chunks (project_id, source_id, source_name, content, embedding, chunk_index)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [projectId, sourceId, sourceName, chunks[i], JSON.stringify(embeddings[i]), i]
    );
  }
}

async function markSourceStatus(sourceId, { status, errorMessage, chunkCount, pagesIndexed }) {
  await db.query(
    `UPDATE knowledge_sources
     SET status = $1, error_message = $2, chunk_count = $3, pages_indexed = $4, last_indexed_at = now()
     WHERE id = $5`,
    [status, errorMessage || null, chunkCount || 0, pagesIndexed || 0, sourceId]
  );
}

async function ingestFile({ projectId, slug, embeddingKey, embeddingModel, filename, buffer, mimeType }) {
  const source = await createSourceRow(projectId, { type: 'file', name: filename });
  try {
    const text = await extractFromFile({ buffer, mimeType, filename });
    if (!text || text.trim().length < 20) throw new Error('No extractable text found in this file.');

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error('Document produced no usable chunks after extraction.');

    const embeddings = await embedTexts({ apiKey: embeddingKey, model: embeddingModel, texts: chunks });
    await saveChunks(projectId, source.id, filename, chunks, embeddings);
    await markSourceStatus(source.id, { status: 'ready', chunkCount: chunks.length });
    await loadChunksForProject(projectId, slug);
    return { ...source, status: 'ready', chunkCount: chunks.length };
  } catch (err) {
    await markSourceStatus(source.id, { status: 'error', errorMessage: err.message });
    return { ...source, status: 'error', errorMessage: err.message };
  }
}

async function ingestWebsite({ projectId, slug, embeddingKey, embeddingModel, url }) {
  const source = await createSourceRow(projectId, { type: 'website', name: url });
  try {
    const pages = await crawlWebsite(url);
    if (pages.length === 0) throw new Error('No pages could be crawled from this URL.');

    let allChunks = [];
    let chunkSourceNames = [];
    for (const page of pages) {
      const pageChunks = chunkText(page.text);
      allChunks = allChunks.concat(pageChunks);
      chunkSourceNames = chunkSourceNames.concat(pageChunks.map(() => page.url));
    }
    if (allChunks.length === 0) throw new Error('Crawled pages produced no usable text content.');

    const embeddings = await embedTexts({ apiKey: embeddingKey, model: embeddingModel, texts: allChunks });

    await db.query('DELETE FROM knowledge_chunks WHERE source_id = $1', [source.id]);
    for (let i = 0; i < allChunks.length; i++) {
      await db.query(
        `INSERT INTO knowledge_chunks (project_id, source_id, source_name, content, embedding, chunk_index)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [projectId, source.id, chunkSourceNames[i], allChunks[i], JSON.stringify(embeddings[i]), i]
      );
    }
    await markSourceStatus(source.id, { status: 'ready', chunkCount: allChunks.length, pagesIndexed: pages.length });
    await loadChunksForProject(projectId, slug);
    return { ...source, status: 'ready', chunkCount: allChunks.length, pagesIndexed: pages.length };
  } catch (err) {
    await markSourceStatus(source.id, { status: 'error', errorMessage: err.message });
    return { ...source, status: 'error', errorMessage: err.message };
  }
}

async function deleteSource(projectId, slug, sourceId) {
  await db.query('DELETE FROM knowledge_sources WHERE id = $1 AND project_id = $2', [sourceId, projectId]);
  await loadChunksForProject(projectId, slug);
}

async function retrieveContext({ slug, query, embeddingKey, embeddingModel, topK = 5 }) {
  const chunks = getCachedChunks(slug);
  if (chunks.length === 0) return [];
  if (!embeddingKey) return [];

  const [queryEmbedding] = await embedTexts({ apiKey: embeddingKey, model: embeddingModel, texts: [query] });
  return retrieveTopK(queryEmbedding, chunks, topK);
}

module.exports = {
  loadChunksForProject,
  getCachedChunks,
  listSources,
  ingestFile,
  ingestWebsite,
  deleteSource,
  retrieveContext,
  clearChunkCache,
};
