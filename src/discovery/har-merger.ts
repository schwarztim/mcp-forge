import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";

export interface MergedEndpoint {
  method: string;
  path: string;
  frequency: number;
  serviceGroup: string;
  sampleUrls: string[];
  responseTypes: string[];
  statusCodes: number[];
}

export interface MergeResult {
  totalInputEndpoints: number;
  uniqueEndpoints: number;
  serviceGroups: Record<string, number>;
  endpoints: MergedEndpoint[];
  outputPath: string;
}

interface RawCapture {
  method?: string;
  url?: string;
  status?: number;
  responseType?: string;
  contentType?: string;
}

const SERVICE_PATTERNS: [RegExp, string][] = [
  [/\/chatsvc\//i, "teams-chat"],
  [/\/mt\//i, "teams-middletier"],
  [/\/csa\//i, "teams-csa"],
  [/\/presence\//i, "teams-presence"],
  [/\/_api\//i, "sharepoint"],
  [/\/api\/v2\.0\/me\/onenote/i, "onenote"],
  [/\/(beta|v1\.0)\/me\//i, "graph"],
  [/\/owa\//i, "outlook"],
  [/graph\.microsoft\.com/i, "graph"],
];

const PARAM_RULES: [RegExp, string][] = [
  // UUIDs
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}"],
  // Hex strings 24+ chars
  [/[0-9a-f]{24,}/gi, "{id}"],
  // Base64-like tokens 40+ chars with = padding
  [/[A-Za-z0-9+/\-_]{40,}={1,2}/g, "{token}"],
  // Email-like segments
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "{email}"],
  // Numeric IDs 5+ digits
  [/(?<=\/)\d{5,}(?=\/|$)/g, "{id}"],
];

export function parameterizePath(url: string): string {
  let pathname: string;
  try {
    const parsed = new URL(url, "https://placeholder.local");
    pathname = parsed.pathname;
  } catch {
    pathname = url.startsWith("/") ? url : `/${url}`;
  }

  for (const [pattern, replacement] of PARAM_RULES) {
    pathname = pathname.replace(pattern, replacement);
  }

  // Collapse consecutive {id} segments
  pathname = pathname.replace(/(\/{id}){2,}/g, "/{id}");
  // Remove trailing slash unless root
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return pathname;
}

export function detectServiceGroup(url: string): string {
  for (const [pattern, group] of SERVICE_PATTERNS) {
    if (pattern.test(url)) return group;
  }

  let pathname: string;
  try {
    pathname = new URL(url, "https://placeholder.local").pathname;
  } catch {
    pathname = url;
  }

  const segments = pathname.split("/").filter(Boolean);
  const firstSegment = segments[0] ?? "unknown";

  // Skip version-like segments (v1, v2.0, beta)
  if (/^(v\d|beta$)/i.test(firstSegment) && segments.length > 1) {
    return segments[1].toLowerCase();
  }

  return firstSegment.toLowerCase();
}

function parseTxtFile(content: string): { method: string; url: string }[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
      if (match) return { method: match[1].toUpperCase(), url: match[2].trim() };
      // Treat bare paths as GET
      return { method: "GET", url: line };
    });
}

function parseJsonFile(content: string): RawCapture[] {
  const data = JSON.parse(content);
  const entries: unknown[] = Array.isArray(data) ? data : data.entries ?? data.endpoints ?? [];
  return entries.filter((e): e is RawCapture => typeof e === "object" && e !== null);
}

export function mergeEndpointFiles(...filePaths: string[]): MergeResult {
  const buckets = new Map<
    string,
    { method: string; path: string; urls: Set<string>; types: Set<string>; codes: Set<number>; count: number }
  >();

  let totalInput = 0;

  for (const filePath of filePaths) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read file "${filePath}": ${msg}`);
    }

    const ext = extname(filePath).toLowerCase();
    let entries: { method: string; url: string; status?: number; contentType?: string }[];

    if (ext === ".txt") {
      entries = parseTxtFile(content);
    } else if (ext === ".json") {
      const raw = parseJsonFile(content);
      entries = raw.map((r) => ({
        method: (r.method ?? "GET").toUpperCase(),
        url: r.url ?? "",
        status: typeof r.status === "number" ? r.status : undefined,
        contentType: r.responseType ?? r.contentType,
      }));
    } else {
      throw new Error(`Unsupported file format "${ext}" for "${basename(filePath)}". Use .txt or .json`);
    }

    totalInput += entries.length;

    for (const entry of entries) {
      if (!entry.url) continue;

      const paramPath = parameterizePath(entry.url);
      const key = `${entry.method} ${paramPath}`;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { method: entry.method, path: paramPath, urls: new Set(), types: new Set(), codes: new Set(), count: 0 };
        buckets.set(key, bucket);
      }

      bucket.count++;
      if (bucket.urls.size < 3) bucket.urls.add(entry.url);
      if (entry.contentType) bucket.types.add(entry.contentType);
      if (entry.status !== undefined) bucket.codes.add(entry.status);
    }
  }

  const endpoints: MergedEndpoint[] = Array.from(buckets.values())
    .map((b) => ({
      method: b.method,
      path: b.path,
      frequency: b.count,
      serviceGroup: detectServiceGroup(b.urls.values().next().value ?? b.path),
      sampleUrls: Array.from(b.urls),
      responseTypes: Array.from(b.types).sort(),
      statusCodes: Array.from(b.codes).sort((a, c) => a - c),
    }))
    .sort((a, b) => b.frequency - a.frequency || a.path.localeCompare(b.path));

  const serviceGroups: Record<string, number> = {};
  for (const ep of endpoints) {
    serviceGroups[ep.serviceGroup] = (serviceGroups[ep.serviceGroup] ?? 0) + 1;
  }

  const capturesDir = join(homedir(), ".mcp-forge", "captures");
  if (!existsSync(capturesDir)) {
    mkdirSync(capturesDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(capturesDir, `${timestamp}-merged.json`);

  const result: MergeResult = {
    totalInputEndpoints: totalInput,
    uniqueEndpoints: endpoints.length,
    serviceGroups,
    endpoints,
    outputPath,
  };

  writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");

  return result;
}
