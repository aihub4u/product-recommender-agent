const cheerio = require('cheerio');
const { assertPublicUrl } = require('./skillExecutor');

const MAX_PAGES = 13; // root page + up to 12 shallow-linked pages
const MAX_CHARS_PER_PAGE = 20000;
const FETCH_TIMEOUT_MS = 10000;

// ---- File extraction ----

async function extractFromFile({ buffer, mimeType, filename }) {
  const lower = (filename || '').toLowerCase();

  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || lower.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md') || mimeType?.startsWith('text/')) {
    return buffer.toString('utf8');
  }

  throw new Error(`Unsupported file type: ${filename} (${mimeType}). Supported: PDF, DOCX, TXT, MD.`);
}

// ---- Website crawling ----

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'AgentPlatformBot/1.0 (+knowledge-base-indexer)' } });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function isCrawlAllowed(origin) {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`);
    if (!res.ok) return true; // no robots.txt -> allowed
    const text = await res.text();
    // Basic check only: a blanket "Disallow: /" under a wildcard user-agent
    // blocks the whole crawl. This is not a full robots.txt parser.
    const lines = text.split('\n').map((l) => l.trim());
    let inWildcardBlock = false;
    for (const line of lines) {
      if (/^user-agent:\s*\*/i.test(line)) inWildcardBlock = true;
      else if (/^user-agent:/i.test(line)) inWildcardBlock = false;
      else if (inWildcardBlock && /^disallow:\s*\/\s*$/i.test(line)) return false;
    }
    return true;
  } catch (e) {
    return true; // if robots.txt itself is unreachable, don't block the crawl on that basis
  }
}

function extractTextAndLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_PER_PAGE);

  const origin = new URL(pageUrl).origin;
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.origin === origin && ['http:', 'https:'].includes(resolved.protocol)) {
        resolved.hash = '';
        links.add(resolved.toString());
      }
    } catch (e) { /* ignore malformed hrefs */ }
  });
  return { text, links: Array.from(links) };
}

/**
 * Crawls a website starting from `rootUrl`: the root page plus up to
 * MAX_PAGES-1 pages it directly links to on the same domain (shallow, one
 * level deep — no further recursion). Returns [{ url, text }, ...].
 */
async function crawlWebsite(rootUrl) {
  await assertPublicUrl(rootUrl);
  const origin = new URL(rootUrl).origin;

  if (!(await isCrawlAllowed(origin))) {
    throw new Error(`robots.txt at ${origin} disallows crawling.`);
  }

  const res = await fetchWithTimeout(rootUrl);
  if (!res.ok) throw new Error(`Failed to fetch ${rootUrl}: HTTP ${res.status}`);
  const html = await res.text();
  const { text: rootText, links } = extractTextAndLinks(html, rootUrl);

  const pages = [{ url: rootUrl, text: rootText }];
  const visited = new Set([rootUrl]);

  for (const link of links) {
    if (pages.length >= MAX_PAGES) break;
    if (visited.has(link)) continue;
    visited.add(link);
    try {
      await assertPublicUrl(link); // each link independently SSRF-checked
      const pageRes = await fetchWithTimeout(link);
      if (!pageRes.ok) continue;
      const contentType = pageRes.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;
      const pageHtml = await pageRes.text();
      const { text: pageText } = extractTextAndLinks(pageHtml, link);
      if (pageText.trim().length > 50) pages.push({ url: link, text: pageText });
    } catch (e) {
      // skip pages that fail SSRF check, timeout, or error — don't abort the whole crawl
      continue;
    }
  }

  return pages;
}

module.exports = { extractFromFile, crawlWebsite, MAX_PAGES };
