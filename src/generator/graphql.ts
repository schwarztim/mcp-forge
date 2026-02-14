/**
 * MCP Forge — GraphQL Generator
 *
 * Generates MCP tools from a GraphQL schema via introspection.
 * Learned from building the Brinqa MCP:
 * - Entity-centric tools: list, search, get per type
 * - buildEntityQuery() pattern with default fields
 * - Raw graphql_query escape hatch
 * - Composite summary tools
 */

import type {
  GraphQLSchema, GraphQLType, GraphQLField, GraphQLEntitySpec,
  GraphQLSpec, GeneratedFile, ApiSpec, EntityDefinition,
  CompositeToolDef, QueryLanguageDef,
} from '../types/index.js';

// ─── GraphQL Introspection ───────────────────────────────────

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      description
      fields {
        name
        description
        type {
          name
          kind
          ofType { name kind ofType { name kind ofType { name kind } } }
        }
        args {
          name
          description
          type {
            name
            kind
            ofType { name kind ofType { name kind } }
          }
          defaultValue
        }
      }
    }
  }
}`;

/**
 * Fetch and parse a GraphQL schema via introspection
 */
export async function introspectGraphQL(
  url: string,
  headers: Record<string, string> = {}
): Promise<GraphQLSchema> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });

  if (!resp.ok) {
    throw new Error(`GraphQL introspection failed (${resp.status}): ${await resp.text()}`);
  }

  const json = await resp.json() as any;
  if (json.errors?.length) {
    throw new Error(`GraphQL introspection errors: ${json.errors.map((e: any) => e.message).join(', ')}`);
  }

  return parseIntrospectionResult(json.data.__schema, url);
}

/**
 * Detect the GraphQL endpoint URL from a base URL
 */
export async function detectGraphQLEndpoint(baseUrl: string): Promise<string | null> {
  const candidates = ['/graphql', '/api/graphql', '/gql', '/query', '/v1/graphql'];
  const base = baseUrl.replace(/\/$/, '');

  for (const path of candidates) {
    try {
      const resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok || resp.status === 401 || resp.status === 403) {
        return `${base}${path}`;
      }
    } catch { /* continue */ }
  }
  return null;
}

// ─── Schema Parsing ──────────────────────────────────────────

const BUILTIN_TYPES = new Set([
  'String', 'Int', 'Float', 'Boolean', 'ID',
  '__Schema', '__Type', '__Field', '__InputValue', '__EnumValue', '__Directive',
  '__DirectiveLocation',
]);

const SKIP_TYPE_PREFIXES = ['__', 'Query', 'Mutation', 'Subscription'];

function parseIntrospectionResult(schema: any, endpoint: string): GraphQLSchema {
  const queryTypeName = schema.queryType?.name || 'Query';
  const mutationTypeName = schema.mutationType?.name || 'Mutation';

  const types: GraphQLType[] = [];
  let queries: GraphQLField[] = [];
  let mutations: GraphQLField[] = [];

  for (const t of schema.types || []) {
    if (BUILTIN_TYPES.has(t.name)) continue;

    const fields = (t.fields || []).map((f: any) => parseField(f));

    if (t.name === queryTypeName) {
      queries = fields;
      continue;
    }
    if (t.name === mutationTypeName) {
      mutations = fields;
      continue;
    }

    if (SKIP_TYPE_PREFIXES.some(p => t.name.startsWith(p))) continue;

    types.push({
      name: t.name,
      kind: t.kind,
      description: t.description,
      fields,
      isEntity: false, // will be set during entity detection
      defaultFields: [],
    });
  }

  return { queryType: queryTypeName, mutationType: mutationTypeName, types, queries, mutations, endpoint };
}

function parseField(f: any): GraphQLField {
  const resolved = resolveType(f.type);
  return {
    name: f.name,
    type: resolved.name,
    kind: resolved.kind,
    isList: resolved.isList,
    isNonNull: resolved.isNonNull,
    description: f.description,
    args: (f.args || []).map((a: any) => ({
      name: a.name,
      type: resolveType(a.type).name,
      isRequired: a.type?.kind === 'NON_NULL',
      defaultValue: a.defaultValue,
      description: a.description,
    })),
  };
}

function resolveType(t: any): { name: string; kind: string; isList: boolean; isNonNull: boolean } {
  if (!t) return { name: 'unknown', kind: 'SCALAR', isList: false, isNonNull: false };

  let isList = false;
  let isNonNull = false;
  let current = t;

  while (current) {
    if (current.kind === 'NON_NULL') { isNonNull = true; current = current.ofType; continue; }
    if (current.kind === 'LIST') { isList = true; current = current.ofType; continue; }
    return { name: current.name || 'unknown', kind: current.kind || 'SCALAR', isList, isNonNull };
  }

  return { name: 'unknown', kind: 'SCALAR', isList, isNonNull };
}

// ─── Entity Detection ────────────────────────────────────────

/**
 * Detect which GraphQL types are queryable entities
 * An entity is a type that:
 * 1. Has a root query field that returns it (or a list of it)
 * 2. Has at least 3 fields
 * 3. Is not an enum/scalar/input type
 */
export function detectEntities(schema: GraphQLSchema): GraphQLEntitySpec[] {
  const typeMap = new Map(schema.types.map(t => [t.name, t]));
  const entities: GraphQLEntitySpec[] = [];

  for (const queryField of schema.queries) {
    const typeName = queryField.type;
    const type = typeMap.get(typeName);

    // Also check if returns a list of a type
    if (!type && !typeMap.has(typeName)) continue;
    const resolvedType = type || typeMap.get(typeName);
    if (!resolvedType || resolvedType.kind !== 'OBJECT') continue;
    if (resolvedType.fields.length < 3) continue;

    // Detect pagination args
    const args = queryField.args || [];
    const hasFilter = args.some(a => a.name === 'filter' || a.name === 'where' || a.name === 'query');
    const hasLimit = args.some(a => a.name === 'limit' || a.name === 'first' || a.name === 'take');
    const hasOffset = args.some(a => a.name === 'offset' || a.name === 'skip');
    const hasCursor = args.some(a => a.name === 'after' || a.name === 'cursor' || a.name === 'before');

    // Pick default fields (scalars only, max 12)
    const defaultFields = resolvedType.fields
      .filter(f => !f.isList && ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'Date'].includes(f.type))
      .slice(0, 12)
      .map(f => f.name);

    // Also include common nested objects (1 level deep) for important refs
    const nestedDefaults = resolvedType.fields
      .filter(f => !f.isList && f.kind === 'OBJECT')
      .slice(0, 3)
      .map(f => {
        const nestedType = typeMap.get(f.type);
        if (!nestedType) return f.name;
        const subFields = nestedType.fields
          .filter(sf => ['String', 'Int', 'Boolean', 'ID'].includes(sf.type))
          .slice(0, 3)
          .map(sf => sf.name);
        return subFields.length ? `${f.name} { ${subFields.join(' ')} }` : f.name;
      });

    if (!defaultFields.includes('id') && resolvedType.fields.some(f => f.name === 'id')) {
      defaultFields.unshift('id');
    }

    // Detect filter type for the query language
    const filterArg = args.find(a => a.name === 'filter' || a.name === 'where');
    const filterType = filterArg?.type;

    // Find matching mutations
    const entityMutations = schema.mutations.filter(m =>
      m.name.toLowerCase().includes(resolvedType.name.toLowerCase())
    ).map(m => ({
      name: m.name,
      operationName: m.name,
      inputType: m.args?.[0]?.type,
      description: m.description || `${m.name} operation`,
    }));

    const pluralName = queryField.name;

    entities.push({
      name: resolvedType.name,
      pluralName,
      queryFieldName: queryField.name,
      fields: resolvedType.fields,
      defaultFields: [...defaultFields, ...nestedDefaults],
      filterType,
      supportsLimit: hasLimit,
      supportsOffset: hasOffset,
      supportsCursor: hasCursor,
      mutations: entityMutations,
    });

    // Mark the type as an entity
    resolvedType.isEntity = true;
  }

  return entities;
}

// ─── Code Generation ─────────────────────────────────────────

/**
 * Generate MCP files for a GraphQL API
 */
export function generateGraphQLMcp(
  spec: GraphQLSpec,
  mcpName: string,
  prefix: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const entities = spec.entities;

  // 1. GraphQL client module
  files.push({
    path: 'src/graphql-client.ts',
    content: generateGraphQLClient(spec, prefix),
  });

  // 2. Types module
  files.push({
    path: 'src/types.ts',
    content: generateEntityTypes(entities),
  });

  // 3. Main index.ts with all tools
  files.push({
    path: 'src/index.ts',
    content: generateGraphQLIndex(spec, entities, mcpName, prefix),
  });

  return files;
}

function generateGraphQLClient(spec: GraphQLSpec, prefix: string): string {
  const queryLanguageHint = spec.entities.some(e => e.filterType === 'String')
    ? '// Filter param accepts the platform\'s query language (e.g. BQL, JQL)\n' : '';

  // Build default fields map
  const defaultFieldsEntries = spec.entities.map(e =>
    `    ${e.queryFieldName}: ${JSON.stringify(e.defaultFields)},`
  ).join('\n');

  return `// Auto-generated by MCP Forge — GraphQL Client
${queryLanguageHint}
const BASE_URL = process.env.${prefix}_BASE_URL || '${spec.baseUrl}';
const GRAPHQL_ENDPOINT = '${spec.schema.endpoint.replace(spec.baseUrl, '')}';

export async function graphqlQuery<T = any>(
  query: string,
  variables?: Record<string, any>,
  headers?: Record<string, string>,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const token = process.env.${prefix}_API_TOKEN;
  if (!token) throw new Error('No API token configured. Set ${prefix}_API_TOKEN env var.');

  const url = \`\${BASE_URL}\${GRAPHQL_ENDPOINT}\`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${token}\`,
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(\`GraphQL request failed (\${resp.status}): \${text}\`);
  }

  return resp.json() as Promise<{ data?: T; errors?: Array<{ message: string }> }>;
}

const DEFAULT_FIELDS: Record<string, string[]> = {
${defaultFieldsEntries}
};

export function buildEntityQuery(
  entityType: string,
  filter?: string,
  fields?: string[],
  limit: number = 50,
  offset: number = 0,
): string {
  const selectedFields = fields || DEFAULT_FIELDS[entityType] || ['id', 'name'];
  const fieldStr = selectedFields.join('\\n    ');
  const args: string[] = [];
  if (filter) args.push(\`filter: "\${filter}"\`);
  args.push(\`limit: \${limit}\`);
  if (offset > 0) args.push(\`offset: \${offset}\`);

  return \`{
  \${entityType}(\${args.join(', ')}) {
    \${fieldStr}
  }
}\`;
}
`;
}

function generateEntityTypes(entities: GraphQLEntitySpec[]): string {
  const interfaces = entities.map(e => {
    const fields = e.fields
      .filter(f => !f.isList && ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(f.type))
      .map(f => {
        const tsType = f.type === 'Int' || f.type === 'Float' ? 'number'
          : f.type === 'Boolean' ? 'boolean' : 'string';
        return `  ${f.name}${f.isNonNull ? '' : '?'}: ${tsType};`;
      });
    return `export interface ${e.name} {\n${fields.join('\n')}\n  [key: string]: any;\n}`;
  });

  return `// Auto-generated by MCP Forge — Entity Types\n\n${interfaces.join('\n\n')}\n`;
}

function generateGraphQLIndex(
  spec: GraphQLSpec,
  entities: GraphQLEntitySpec[],
  mcpName: string,
  prefix: string,
): string {
  const toolDefs: string[] = [];
  const toolCases: string[] = [];

  // Auth status tool
  addTool(toolDefs, toolCases, {
    name: `${mcpName.replace(/-mcp$/, '')}_auth_status`,
    description: 'Check authentication status',
    params: {},
    body: `const token = process.env.${prefix}_API_TOKEN;
      return ok({ configured: !!token, baseUrl: process.env.${prefix}_BASE_URL || '${spec.baseUrl}' });`,
  });

  // Raw GraphQL tool
  addTool(toolDefs, toolCases, {
    name: `${mcpName.replace(/-mcp$/, '')}_graphql`,
    description: 'Execute a raw GraphQL query',
    params: {
      query: { type: 'string', description: 'GraphQL query string', required: true },
      variables: { type: 'string', description: 'JSON variables (optional)' },
    },
    body: `const vars = args.variables ? JSON.parse(args.variables as string) : undefined;
      return ok(await graphqlQuery(args.query as string, vars));`,
  });

  // Schema introspection tool
  addTool(toolDefs, toolCases, {
    name: `${mcpName.replace(/-mcp$/, '')}_introspect_schema`,
    description: 'Discover the GraphQL schema — lists all available types and fields',
    params: {},
    body: `return ok(await graphqlQuery(\`{
  __schema {
    queryType { name }
    types { name kind fields { name type { name kind ofType { name kind } } } }
  }
}\`));`,
  });

  // Entity tools: list + search per entity
  for (const entity of entities) {
    const nameBase = mcpName.replace(/-mcp$/, '');
    const entityLower = entity.pluralName.toLowerCase();

    // list tool
    addTool(toolDefs, toolCases, {
      name: `${nameBase}_list_${entityLower}`,
      description: `List ${entity.pluralName} with optional filter`,
      params: {
        filter: { type: 'string', description: `Filter expression${spec.entities[0]?.filterType === 'String' ? ' (query language supported)' : ''}` },
        limit: { type: 'number', description: 'Max records (default 50)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
      body: `const q = buildEntityQuery('${entity.queryFieldName}', args.filter as string, undefined, (args.limit as number) || 50, (args.offset as number) || 0);
      return ok(await graphqlQuery(q));`,
    });

    // search tool (if entity has obvious searchable fields)
    const searchableFields = entity.fields.filter(f =>
      ['displayName', 'name', 'hostname', 'ipAddress', 'email', 'title'].includes(f.name)
    );
    if (searchableFields.length > 0) {
      const searchFilter = searchableFields
        .map(f => `${f.name} contains "\${args.searchTerm}"`)
        .join(' OR ');

      addTool(toolDefs, toolCases, {
        name: `${nameBase}_search_${entityLower}`,
        description: `Search ${entity.pluralName} by keyword`,
        params: {
          searchTerm: { type: 'string', description: 'Search term', required: true },
          limit: { type: 'number', description: 'Max records (default 20)' },
        },
        body: `const q = buildEntityQuery('${entity.queryFieldName}', \`${searchFilter}\`, undefined, (args.limit as number) || 20);
      return ok(await graphqlQuery(q));`,
      });
    }
  }

  // Count tools
  const toolCount = toolDefs.length;

  return `#!/usr/bin/env node
// Auto-generated by MCP Forge — GraphQL MCP Server
// Tools: ${toolCount} | API: GraphQL | Auth: ${spec.authStrategy}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { graphqlQuery, buildEntityQuery } from './graphql-client.js';

const server = new McpServer({ name: '${mcpName}', version: '1.0.0' });

function ok(data: any): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(error: any): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: \`Error: \${msg}\` }], isError: true };
}

${toolDefs.join('\n\n')}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
`;
}

// ─── Tool Builder Helpers ────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
  body: string;
}

function addTool(defs: string[], cases: string[], tool: ToolDef): void {
  const paramEntries = Object.entries(tool.params);
  const schemaStr = paramEntries.length === 0 ? '{}'
    : `{\n${paramEntries.map(([k, v]) => {
        const zodType = v.type === 'number' ? 'z.number()' : 'z.string()';
        const full = v.required ? zodType : `${zodType}.optional()`;
        return `    ${k}: ${full}.describe(${JSON.stringify(v.description)}),`;
      }).join('\n')}\n  }`;

  defs.push(`server.tool('${tool.name}', ${JSON.stringify(tool.description)}, ${schemaStr}, async (args: any) => {
  try {
    ${tool.body}
  } catch (e) { return err(e); }
});`);
}
