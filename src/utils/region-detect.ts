/**
 * MCP Forge — Region/Tenant Detection
 *
 * Learned from MS365 build: APIs often route to regional endpoints
 * (emea, amer, apac). This module auto-detects the correct region
 * from redirect responses and API patterns.
 *
 * Example: Teams API routes to emea-03 for EU tenants, amer-02 for US.
 */

import type { RegionConfig } from '../types/index.js';

// Known regional API patterns
const REGION_PATTERNS: Record<string, RegExp[]> = {
  emea: [
    /\/emea[-/]/i,
    /emea\.\w+\.com/i,
    /\.eu\./i,
    /europe/i,
  ],
  amer: [
    /\/amer[-/]/i,
    /amer\.\w+\.com/i,
    /\.us\./i,
    /americas/i,
  ],
  apac: [
    /\/apac[-/]/i,
    /apac\.\w+\.com/i,
    /\.ap\./i,
    /asia/i,
  ],
};

/**
 * Detect region from a set of captured API URLs.
 * Scans for regional path segments and hostname patterns.
 */
export function detectRegionFromUrls(urls: string[]): RegionConfig {
  const regionCounts: Record<string, number> = { emea: 0, amer: 0, apac: 0 };

  for (const url of urls) {
    for (const [region, patterns] of Object.entries(REGION_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(url)) {
          regionCounts[region]++;
          break;
        }
      }
    }
  }

  const sorted = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]);
  const [topRegion, topCount] = sorted[0];

  if (topCount === 0) {
    return { region: 'unknown', apiPrefix: '', detected: false };
  }

  // Extract the exact regional prefix from matching URLs
  const apiPrefix = extractRegionPrefix(urls, topRegion);

  return {
    region: topRegion,
    apiPrefix,
    detected: true,
  };
}

/**
 * Extract the exact regional path prefix (e.g., "emea-03") from URLs.
 */
function extractRegionPrefix(urls: string[], region: string): string {
  const prefixPattern = new RegExp(`(${region}[-_]?\\d{0,2})`, 'i');

  for (const url of urls) {
    const match = url.match(prefixPattern);
    if (match) return match[1].toLowerCase();
  }

  return region;
}

/**
 * Detect region by making a probe request and following redirects.
 * Many Microsoft APIs redirect to the correct regional endpoint.
 */
export async function detectRegionFromProbe(url: string): Promise<RegionConfig> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const location = resp.headers.get('location') || '';
    if (location) {
      const regionResult = detectRegionFromUrls([location]);
      if (regionResult.detected) return regionResult;
    }

    // Check response URL itself (if follow redirects)
    const resp2 = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });

    return detectRegionFromUrls([resp2.url]);
  } catch {
    return { region: 'unknown', apiPrefix: '', detected: false };
  }
}

/**
 * Replace region placeholders in URL templates.
 * e.g., "https://teams.microsoft.com/chatsvc/{region}/v1/" → uses detected region
 */
export function applyRegion(urlTemplate: string, region: RegionConfig): string {
  if (!region.detected) return urlTemplate;
  return urlTemplate
    .replace(/\{region\}/g, region.apiPrefix)
    .replace(/\{REGION\}/g, region.region.toUpperCase());
}
