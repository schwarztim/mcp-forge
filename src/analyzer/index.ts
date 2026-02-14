/**
 * MCP Forge — API Analyzer
 *
 * Auto-detects API type, auth strategy, and endpoints from:
 * - OpenAPI/Swagger specs (JSON or YAML)
 * - HAR files (captured browser traffic)
 * - Raw URLs (probes common patterns)
 * - API names (uses known pattern library)
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import yaml from 'js-yaml';
import type {
  ApiSpec, ApiEndpoint, ApiParameter, ApiRequestBody,
  AuthStrategy, AuthConfig, EnvVar, ForgeConfig, InputFormat,
  GraphQLSpec,
} from '../types/index.js';
import { KNOWN_APIS } from './known-apis.js';
import { detectGraphQLEndpoint, introspectGraphQL, detectEntities } from '../generator/graphql.js';
import { detectQueryLanguage } from '../patterns/query-languages.js';

// ─── Input Detection ─────────────────────────────────────────

export function detectInputFormat(target: string): InputFormat {
  if (existsSync(target)) {
    const lower = target.toLowerCase();
    if (lower.endsWith('.har')) return 'har';
    if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'openapi';
    if (lower.endsWith('.postman_collection.json')) return 'postman';
  }
  if (target.startsWith('http://') || target.startsWith('https://')) return 'url';
  return 'name_only';
}

// ─── Main Analyzer ───────────────────────────────────────────

export async function analyzeApi(config: ForgeConfig): Promise<ApiSpec> {
  const format = config.inputFormat || detectInputFormat(config.target);

  switch (format) {
    case 'openapi':
    case 'swagger':
      return analyzeOpenApiSpec(config.specPath || config.target);
    case 'har':
      return analyzeHarFile(config.specPath || config.target);
    case 'url':
      return analyzeFromUrl(config.target, config);
    case 'name_only':
      return analyzeFromName(config.target, config);
    default:
      throw new Error(`Unsupported input format: ${format}`);
  }
}

// ─── OpenAPI/Swagger Analyzer ────────────────────────────────

async function analyzeOpenApiSpec(specPath: string): Promise<ApiSpec> {
  const raw = await readFile(specPath, 'utf-8');
  const spec: any = specPath.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);

  // Detect OpenAPI version
  const isV3 = spec.openapi?.startsWith('3.');
  const isV2 = spec.swagger?.startsWith('2.');

  const baseUrl = isV3
    ? spec.servers?.[0]?.url || ''
    : isV2
      ? `${spec.schemes?.[0] || 'https'}://${spec.host}${spec.basePath || ''}`
      : '';

  // Extract auth strategy from security schemes
  const { authStrategy, authConfig } = extractAuthFromSpec(spec, isV3);

  // Extract endpoints
  const endpoints = extractEndpoints(spec, isV3);

  // Build env vars
  const envVars = buildEnvVars(baseUrl, authStrategy, authConfig, spec.info?.title || 'api');

  // Collect all tags
  const tags = [...new Set(endpoints.flatMap(e => e.tags))];

  return {
    title: spec.info?.title || 'Unknown API',
    description: spec.info?.description || '',
    version: spec.info?.version || '1.0.0',
    baseUrl,
    authStrategy,
    authConfig,
    apiStyle: 'rest',
    endpoints,
    tags,
    envVars,
  };
}

function extractAuthFromSpec(spec: any, isV3: boolean): { authStrategy: AuthStrategy; authConfig: AuthConfig } {
  const schemes = isV3
    ? spec.components?.securitySchemes || {}
    : spec.securityDefinitions || {};

  for (const [, scheme] of Object.entries<any>(schemes)) {
    if (scheme.type === 'oauth2') {
      const flows = scheme.flows || {};
      const flow = flows.authorizationCode || flows.clientCredentials || flows.implicit || {};
      return {
        authStrategy: 'oauth2',
        authConfig: {
          strategy: 'oauth2',
          tokenUrl: flow.tokenUrl || scheme.tokenUrl,
          authUrl: flow.authorizationUrl || scheme.authorizationUrl,
          scopes: Object.keys(flow.scopes || {}),
        },
      };
    }
    if (scheme.type === 'apiKey') {
      return {
        authStrategy: 'api_key',
        authConfig: {
          strategy: 'api_key',
          headerName: scheme.in === 'header' ? scheme.name : undefined,
          queryParam: scheme.in === 'query' ? scheme.name : undefined,
          envVarName: `${scheme.name?.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`,
        },
      };
    }
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      return {
        authStrategy: 'bearer',
        authConfig: { strategy: 'bearer', envVarName: 'API_TOKEN' },
      };
    }
    if (scheme.type === 'http' && scheme.scheme === 'basic') {
      return {
        authStrategy: 'basic',
        authConfig: { strategy: 'basic' },
      };
    }
    // OpenID Connect → treat as SSO
    if (scheme.type === 'openIdConnect') {
      return {
        authStrategy: 'sso_browser',
        authConfig: {
          strategy: 'sso_browser',
          authUrl: scheme.openIdConnectUrl,
        },
      };
    }
  }

  return { authStrategy: 'none', authConfig: { strategy: 'none' } };
}

function extractEndpoints(spec: any, isV3: boolean): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const paths = spec.paths || {};

  for (const [path, methods] of Object.entries<any>(paths)) {
    for (const [method, op] of Object.entries<any>(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        const params = extractParameters(op.parameters || [], isV3);
        const reqBody = extractRequestBody(op, isV3);

        endpoints.push({
          method: method.toUpperCase() as ApiEndpoint['method'],
          path,
          operationId: op.operationId || generateOperationId(method, path),
          summary: op.summary || op.description || `${method.toUpperCase()} ${path}`,
          description: op.description,
          parameters: params,
          requestBody: reqBody,
          responses: extractResponses(op.responses || {}),
          tags: op.tags || ['default'],
          requiresAuth: (op.security?.length ?? spec.security?.length ?? 0) > 0,
        });
      }
    }
  }
  return endpoints;
}

function extractParameters(params: any[], _isV3: boolean): ApiParameter[] {
  return params
    .filter((p: any) => p.in !== 'header' || !['Authorization', 'Content-Type'].includes(p.name))
    .map((p: any) => ({
      name: p.name,
      in: p.in,
      required: p.required || false,
      type: p.schema?.type || p.type || 'string',
      description: p.description || p.name,
      default: p.schema?.default ?? p.default,
      enum: p.schema?.enum ?? p.enum,
    }));
}

function extractRequestBody(op: any, isV3: boolean): ApiRequestBody | undefined {
  if (isV3 && op.requestBody) {
    const content = op.requestBody.content || {};
    const json = content['application/json'];
    if (json) {
      return {
        contentType: 'application/json',
        schema: json.schema || {},
        required: op.requestBody.required || false,
        description: op.requestBody.description,
      };
    }
  }
  // V2: look for body parameter
  const bodyParam = op.parameters?.find((p: any) => p.in === 'body');
  if (bodyParam) {
    return {
      contentType: 'application/json',
      schema: bodyParam.schema || {},
      required: bodyParam.required || false,
      description: bodyParam.description,
    };
  }
  return undefined;
}

function extractResponses(responses: any): Record<string, { statusCode: string; description: string; schema?: any }> {
  const result: Record<string, any> = {};
  for (const [code, resp] of Object.entries<any>(responses)) {
    result[code] = {
      statusCode: code,
      description: resp.description || '',
      schema: resp.content?.['application/json']?.schema || resp.schema,
    };
  }
  return result;
}

function generateOperationId(method: string, path: string): string {
  const parts = path.split('/').filter(Boolean).map(p =>
    p.startsWith('{') ? `by_${p.slice(1, -1)}` : p
  );
  return `${method}_${parts.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

// ─── HAR File Analyzer ───────────────────────────────────────

async function analyzeHarFile(harPath: string): Promise<ApiSpec> {
  const raw = await readFile(harPath, 'utf-8');
  const har = JSON.parse(raw);
  const entries = har.log?.entries || [];

  // Group API calls by base URL
  const apiCalls = entries
    .filter((e: any) => {
      const ct = e.response?.content?.mimeType || '';
      return ct.includes('json') || ct.includes('xml');
    })
    .map((e: any) => ({
      method: e.request.method,
      url: new URL(e.request.url),
      headers: e.request.headers,
      queryString: e.request.queryString,
      postData: e.request.postData,
      status: e.response.status,
      responseType: e.response.content?.mimeType,
    }));

  if (apiCalls.length === 0) {
    throw new Error('No API calls found in HAR file');
  }

  // Determine base URL from most common origin
  const origins = apiCalls.map((c: any) => c.url.origin);
  const originCounts = origins.reduce((acc: any, o: string) => { acc[o] = (acc[o] || 0) + 1; return acc; }, {});
  const baseUrl = Object.entries(originCounts).sort((a: any, b: any) => b[1] - a[1])[0][0] as string;

  // Detect auth from headers
  const { authStrategy, authConfig } = detectAuthFromHarHeaders(apiCalls);

  // Convert HAR entries to endpoints
  const endpointMap = new Map<string, ApiEndpoint>();
  for (const call of apiCalls) {
    if (call.url.origin !== baseUrl) continue;
    const path = parameterizePath(call.url.pathname);
    const key = `${call.method}:${path}`;
    if (!endpointMap.has(key)) {
      endpointMap.set(key, {
        method: call.method,
        path,
        operationId: generateOperationId(call.method.toLowerCase(), path),
        summary: `${call.method} ${path}`,
        parameters: extractHarParams(call),
        requestBody: call.postData ? {
          contentType: call.postData.mimeType || 'application/json',
          schema: {},
          required: true,
        } : undefined,
        responses: { [call.status.toString()]: { statusCode: call.status.toString(), description: 'Captured response' } },
        tags: [path.split('/').filter(Boolean)[0] || 'default'],
        requiresAuth: true,
      });
    }
  }

  const endpoints = Array.from(endpointMap.values());
  const envVars = buildEnvVars(baseUrl, authStrategy, authConfig, 'captured-api');

  return {
    title: `API (captured from ${new URL(baseUrl).hostname})`,
    description: `Auto-discovered API from HAR capture. ${endpoints.length} endpoints found.`,
    version: '1.0.0',
    baseUrl,
    authStrategy,
    authConfig,
    apiStyle: 'rest',
    endpoints,
    tags: [...new Set(endpoints.flatMap(e => e.tags))],
    envVars,
  };
}

function parameterizePath(pathname: string): string {
  // Replace UUIDs and numeric IDs with path parameters
  return pathname
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
    .replace(/\/\d{5,}/g, '/{id}')
    .replace(/\/[0-9a-f]{24}/gi, '/{id}');
}

function detectAuthFromHarHeaders(calls: any[]): { authStrategy: AuthStrategy; authConfig: AuthConfig } {
  for (const call of calls) {
    const authHeader = call.headers.find((h: any) => h.name.toLowerCase() === 'authorization');
    if (authHeader) {
      const val: string = authHeader.value;
      if (val.startsWith('Bearer ')) {
        return {
          authStrategy: 'bearer',
          authConfig: { strategy: 'bearer', envVarName: 'API_TOKEN' },
        };
      }
      if (val.startsWith('Basic ')) {
        return {
          authStrategy: 'basic',
          authConfig: { strategy: 'basic' },
        };
      }
    }
    // Check for API key headers
    const apiKeyHeaders = ['x-api-key', 'api-key', 'apikey'];
    for (const h of call.headers) {
      if (apiKeyHeaders.includes(h.name.toLowerCase())) {
        return {
          authStrategy: 'api_key',
          authConfig: { strategy: 'api_key', headerName: h.name, envVarName: 'API_KEY' },
        };
      }
    }
    // Check for cookies (SSO)
    const cookieHeader = call.headers.find((h: any) => h.name.toLowerCase() === 'cookie');
    if (cookieHeader?.value?.includes('JSESSIONID') || cookieHeader?.value?.includes('glide_')) {
      return {
        authStrategy: 'sso_browser',
        authConfig: { strategy: 'sso_browser', loginUrl: call.url.origin, cookieDomain: call.url.hostname },
      };
    }
  }
  return { authStrategy: 'har_capture', authConfig: { strategy: 'har_capture' } };
}

function extractHarParams(call: any): ApiParameter[] {
  const params: ApiParameter[] = [];
  if (call.url.searchParams) {
    for (const [name, value] of call.url.searchParams.entries()) {
      params.push({
        name,
        in: 'query',
        required: false,
        type: typeof value === 'number' ? 'number' : 'string',
        description: name,
      });
    }
  }
  // Path params from parameterized path
  const pathParams = call.url.pathname.match(/\{(\w+)\}/g) || [];
  for (const pp of pathParams) {
    const name = pp.slice(1, -1);
    params.push({ name, in: 'path', required: true, type: 'string', description: name });
  }
  return params;
}

// ─── URL Probe Analyzer ──────────────────────────────────────

async function analyzeFromUrl(url: string, config: ForgeConfig): Promise<ApiSpec> {
  const hostname = new URL(url).hostname;
  const slug = hostname.split('.')[0];
  const baseUrl = url.replace(/\/$/, '');

  // Probe for GraphQL endpoint first (learned from Brinqa build)
  try {
    const gqlEndpoint = await detectGraphQLEndpoint(baseUrl);
    if (gqlEndpoint) {
      console.error(`[analyzer] GraphQL endpoint detected: ${gqlEndpoint}`);

      // Try introspection (may fail if auth is needed)
      try {
        const authHeaders: Record<string, string> = {};
        const token = process.env[`${slug.toUpperCase()}_API_TOKEN`];
        if (token) authHeaders['Authorization'] = `Bearer ${token}`;

        const schema = await introspectGraphQL(gqlEndpoint, authHeaders);
        const entities = detectEntities(schema);
        const ql = detectQueryLanguage(config.target);

        return {
          title: `${slug} API`,
          description: `GraphQL API at ${gqlEndpoint}. ${entities.length} entities discovered via introspection.`,
          version: '1.0.0',
          baseUrl,
          authStrategy: config.authStrategy || 'bearer',
          authConfig: { strategy: config.authStrategy || 'bearer', envVarName: `${slug.toUpperCase()}_API_TOKEN` },
          apiStyle: 'graphql',
          endpoints: [],
          tags: entities.map(e => e.pluralName),
          envVars: buildEnvVars(baseUrl, config.authStrategy || 'bearer', { strategy: 'bearer' }, slug),
          graphqlSchema: schema,
          entities: entities.map(e => ({
            name: e.name,
            pluralName: e.pluralName,
            source: 'graphql' as const,
            fields: e.fields.map(f => ({
              name: f.name, type: f.type, isRequired: f.isNonNull,
              description: f.description, isId: f.name === 'id',
              isSearchable: ['name', 'displayName', 'title', 'hostname', 'email'].includes(f.name),
            })),
            defaultFields: e.defaultFields,
            operations: [
              { type: 'list' as const, queryField: e.queryFieldName, description: `List ${e.pluralName}` },
              { type: 'search' as const, queryField: e.queryFieldName, description: `Search ${e.pluralName}` },
            ],
            queryLanguage: ql?.name,
          })),
          queryLanguage: ql,
        };
      } catch (introErr: any) {
        console.error(`[analyzer] GraphQL introspection failed (auth needed?): ${introErr.message}`);
        // Still flag as GraphQL even without introspection
        return {
          title: `${slug} API`,
          description: `GraphQL API detected at ${gqlEndpoint}. Introspection failed — provide auth token.`,
          version: '1.0.0',
          baseUrl,
          authStrategy: config.authStrategy || 'bearer',
          authConfig: { strategy: config.authStrategy || 'bearer', envVarName: `${slug.toUpperCase()}_API_TOKEN` },
          apiStyle: 'graphql',
          endpoints: [],
          tags: [],
          envVars: buildEnvVars(baseUrl, config.authStrategy || 'bearer', { strategy: 'bearer' }, slug),
        };
      }
    }
  } catch { /* GraphQL probe failed — continue with REST */ }

  // Fall back to REST spec probe
  return {
    title: `${slug} API`,
    description: `API at ${url}. Provide an OpenAPI spec or HAR capture for detailed endpoint discovery.`,
    version: '1.0.0',
    baseUrl,
    authStrategy: config.authStrategy || 'bearer',
    authConfig: { strategy: config.authStrategy || 'bearer', envVarName: `${slug.toUpperCase()}_TOKEN` },
    apiStyle: 'rest',
    endpoints: [],
    tags: [],
    envVars: buildEnvVars(url, config.authStrategy || 'bearer', { strategy: 'bearer' }, slug),
  };
}

// ─── Name-Only Analyzer (Pattern Library) ────────────────────

async function analyzeFromName(name: string, config: ForgeConfig): Promise<ApiSpec> {
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = KNOWN_APIS[lower];

  if (known) {
    const envVars = buildEnvVars(known.baseUrl, known.authStrategy, known.authConfig, name);
    return { ...known, envVars };
  }

  // Fallback: generate a skeleton that the user can populate
  return {
    title: `${name} API`,
    description: `Skeleton MCP for ${name}. Provide an OpenAPI spec or HAR file for full endpoint discovery.`,
    version: '1.0.0',
    baseUrl: config.baseUrl || `https://api.${name.toLowerCase()}.com`,
    authStrategy: config.authStrategy || 'api_key',
    authConfig: { strategy: config.authStrategy || 'api_key', headerName: 'Authorization', envVarName: `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY` },
    apiStyle: 'rest',
    endpoints: [],
    tags: [],
    envVars: buildEnvVars(`https://api.${name.toLowerCase()}.com`, 'api_key', { strategy: 'api_key' }, name),
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function buildEnvVars(baseUrl: string, authStrategy: AuthStrategy, authConfig: AuthConfig, apiName: string): EnvVar[] {
  const prefix = apiName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const vars: EnvVar[] = [
    {
      name: `${prefix}_BASE_URL`,
      description: `Base URL for the ${apiName} API`,
      required: true,
      secret: false,
      default: baseUrl,
      example: baseUrl,
    },
  ];

  switch (authStrategy) {
    case 'api_key':
      vars.push({
        name: authConfig.envVarName || `${prefix}_API_KEY`,
        description: `API key for ${apiName}`,
        required: true,
        secret: true,
        example: 'sk-xxxxxxxxxxxx',
      });
      break;
    case 'bearer':
      vars.push({
        name: authConfig.envVarName || `${prefix}_TOKEN`,
        description: `Bearer token for ${apiName}`,
        required: true,
        secret: true,
        example: 'eyJhbGciOiJSUzI1NiIs...',
      });
      break;
    case 'oauth2':
      vars.push(
        { name: `${prefix}_CLIENT_ID`, description: 'OAuth2 client ID', required: true, secret: false, example: 'client-id-here' },
        { name: `${prefix}_CLIENT_SECRET`, description: 'OAuth2 client secret', required: true, secret: true, example: 'client-secret-here' },
      );
      if (authConfig.tenantId) {
        vars.push({ name: `${prefix}_TENANT_ID`, description: 'Azure AD tenant ID', required: true, secret: false, example: 'your-tenant-id' });
      }
      break;
    case 'sso_browser':
      vars.push(
        { name: `${prefix}_SSO_LOGIN_URL`, description: 'SSO login URL', required: false, secret: false, default: authConfig.loginUrl, example: authConfig.loginUrl || 'https://login.microsoftonline.com' },
      );
      break;
    case 'basic':
      vars.push(
        { name: `${prefix}_USERNAME`, description: `Username for ${apiName}`, required: true, secret: false, example: 'admin' },
        { name: `${prefix}_PASSWORD`, description: `Password for ${apiName}`, required: true, secret: true, example: 'password' },
      );
      break;
  }

  return vars;
}
