/**
 * MCP Forge — Documentation Crawler
 *
 * Spiders API documentation sites to discover endpoints, auth patterns,
 * entity types, and code examples. Learned from Brinqa build where
 * we manually fetched 10+ doc pages.
 *
 * Supports: ReadMe.io, Swagger UI, Redoc, GitBook, Docusaurus, generic HTML
 */

import type {
  CrawledPage, CrawledEndpoint, CrawledCodeExample, DocCrawlResult,
} from '../types/index.js';
import { detectQueryLanguage } from '../patterns/query-languages.js';

const MAX_PAGES = 50;
const CRAWL_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 10000;

// HTTP method patterns in docs
const METHOD_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s<"']+)/gi;
const CURL_PATTERN = /curl\s+(?:-X\s+)?(GET|POST|PUT|PATCH|DELETE)?\s+['"]?(https?:\/\/[^\s'"]+)/gi;
const CODE_BLOCK_PATTERN = /```(\w+)?\n([\s\S]*?)```/g;
const URL_PATTERN = /https?:\/\/[^\s<"')\]]+/g;

/**
 * Crawl API documentation starting from a base URL
 */
export async function crawlDocumentation(
  startUrl: string,
  options: { maxPages?: number; apiName?: string } = {},
): Promise<DocCrawlResult> {
  const maxPages = options.maxPages || MAX_PAGES;
  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const pages: CrawledPage[] = [];
  const allEndpoints: CrawledEndpoint[] = [];
  const allEntities = new Set<string>();
  let detectedAuth = 'unknown';
  let detectedBaseUrl: string | undefined;

  const baseHost = new URL(startUrl).hostname;

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const page = await fetchAndParsePage(url);
      if (!page) continue;
      pages.push(page);

      // Collect findings
      for (const ep of page.endpoints) {
        if (!allEndpoints.some(e => e.method === ep.method && e.path === ep.path)) {
          allEndpoints.push(ep);
        }
      }
      for (const entity of page.entityNames) allEntities.add(entity);
      if (page.authPatterns.length > 0 && detectedAuth === 'unknown') {
        detectedAuth = page.authPatterns[0];
      }

      // Extract links to crawl (same host, likely docs pages)
      const links = extractDocLinks(page, baseHost, startUrl);
      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }

      // Detect base URL from endpoint paths
      if (!detectedBaseUrl) {
        for (const ep of page.endpoints) {
          if (ep.path.startsWith('http')) {
            try {
              const u = new URL(ep.path);
              detectedBaseUrl = u.origin;
              break;
            } catch { /* not a URL */ }
          }
        }
      }
    } catch (e) {
      // Skip failed pages
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, CRAWL_DELAY_MS));
  }

  // Try detecting query language
  const ql = options.apiName ? detectQueryLanguage(options.apiName) : undefined;

  return {
    pagesVisited: visited.size,
    endpoints: allEndpoints,
    entities: Array.from(allEntities),
    authType: detectedAuth,
    queryLanguage: ql?.name,
    baseUrl: detectedBaseUrl,
  };
}

async function fetchAndParsePage(url: string): Promise<CrawledPage | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MCP-Forge/3.1 Documentation Crawler' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/json')) return null;

    const html = await resp.text();
    return parsePage(url, html);
  } catch {
    return null;
  }
}

function parsePage(url: string, html: string): CrawledPage {
  // Extract title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Extract endpoints from method + path patterns
  const endpoints: CrawledEndpoint[] = [];
  let match;

  // Standard API doc patterns (GET /api/v1/users)
  const methodRegex = new RegExp(METHOD_PATTERN.source, 'gi');
  while ((match = methodRegex.exec(html)) !== null) {
    const method = match[1].toUpperCase();
    let path = match[2].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '');
    // Skip non-API paths
    if (path.includes('.css') || path.includes('.js') || path.includes('.png')) continue;
    if (path.length < 3 || path.length > 200) continue;

    endpoints.push({
      method,
      path: cleanPath(path),
      description: extractNearbyText(html, match.index!, 200),
      parameters: extractParametersFromPath(path),
      source: url,
    });
  }

  // curl examples
  const curlRegex = new RegExp(CURL_PATTERN.source, 'gi');
  while ((match = curlRegex.exec(html)) !== null) {
    const method = (match[1] || 'GET').toUpperCase();
    const fullUrl = match[2];
    try {
      const u = new URL(fullUrl);
      endpoints.push({
        method,
        path: u.pathname,
        description: 'Extracted from curl example',
        parameters: extractParametersFromPath(u.pathname),
        source: url,
      });
    } catch { /* not a valid URL */ }
  }

  // Extract code examples
  const codeExamples: CrawledCodeExample[] = [];
  const codeRegex = new RegExp(CODE_BLOCK_PATTERN.source, 'g');
  while ((match = codeRegex.exec(html)) !== null) {
    const lang = match[1] || 'text';
    const code = match[2].trim();
    if (code.length > 20 && code.length < 5000) {
      codeExamples.push({ language: lang, code, source: url });
    }
  }

  // Detect auth patterns
  const authPatterns: string[] = [];
  if (/bearer|authorization:\s*bearer/i.test(html)) authPatterns.push('bearer');
  if (/api[_-]?key/i.test(html)) authPatterns.push('api_key');
  if (/oauth2?|authorization[_-]?code|client[_-]?credentials/i.test(html)) authPatterns.push('oauth2');
  if (/basic\s+auth/i.test(html)) authPatterns.push('basic');
  if (/sso|saml|openid/i.test(html)) authPatterns.push('sso_browser');
  if (/graphql/i.test(html)) authPatterns.push('graphql');

  // Detect entity names (common patterns in API docs)
  const entityNames: string[] = [];
  const entityPatterns = [
    /<h[1-3][^>]*>(?:The\s+)?(\w+)\s+(?:resource|entity|object|model|type|endpoint)/gi,
    /(?:list|get|create|update|delete)\s+(\w+)/gi,
  ];
  for (const pattern of entityPatterns) {
    const regex = new RegExp(pattern.source, 'gi');
    while ((match = regex.exec(html)) !== null) {
      const entity = match[1];
      if (entity.length > 2 && entity.length < 30 && !['the', 'and', 'for', 'all', 'new', 'your'].includes(entity.toLowerCase())) {
        entityNames.push(entity);
      }
    }
  }

  return { url, title, endpoints, authPatterns, entityNames: [...new Set(entityNames)], codeExamples };
}

function extractDocLinks(page: CrawledPage, baseHost: string, startUrl: string): string[] {
  // For now, return empty — we'll need the raw HTML for link extraction
  // In production, this would parse <a href="..."> from the HTML
  return [];
}

function cleanPath(path: string): string {
  return path
    .replace(/[<{]\w+[>}]/g, '{id}')  // Normalize path params
    .replace(/\/+$/, '')                // Remove trailing slashes
    .replace(/\?.*$/, '');              // Remove query strings
}

function extractParametersFromPath(path: string): string[] {
  const params: string[] = [];
  const paramRegex = /[{<:](\w+)[}>]/g;
  let match;
  while ((match = paramRegex.exec(path)) !== null) {
    params.push(match[1]);
  }
  return params;
}

function extractNearbyText(html: string, index: number, range: number): string {
  const start = Math.max(0, index - range);
  const end = Math.min(html.length, index + range);
  const snippet = html.slice(start, end)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return snippet.slice(0, 200);
}

/**
 * Try to find and fetch an OpenAPI/Swagger spec from common locations
 */
export async function findOpenApiSpec(baseUrl: string): Promise<string | null> {
  const base = baseUrl.replace(/\/$/, '');
  const candidates = [
    '/swagger/v1/swagger.json',
    '/swagger.json',
    '/openapi.json',
    '/api-docs',
    '/v2/api-docs',
    '/v3/api-docs',
    '/swagger.yaml',
    '/openapi.yaml',
    '/docs/openapi.json',
    '/api/openapi.json',
    '/swagger/brinqa-connect.yml',
    '/.well-known/openapi.json',
  ];

  for (const path of candidates) {
    try {
      const resp = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('yaml') || ct.includes('yml')) {
          return `${base}${path}`;
        }
      }
    } catch { /* continue */ }
  }

  return null;
}
