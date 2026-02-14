/**
 * MCP Forge — Known API Pattern Library
 *
 * Pre-built specs for commonly requested APIs. When the user says
 * "forge servicenow" or "forge github", we can skip discovery entirely.
 */

import type { ApiSpec, AuthStrategy, AuthConfig, ApiEndpoint } from '../types/index.js';

type KnownApiEntry = Omit<ApiSpec, 'envVars'>;

export const KNOWN_APIS: Record<string, KnownApiEntry> = {
  servicenow: {
    title: 'ServiceNow API',
    description: 'IT Service Management platform - incidents, changes, CMDB, catalog, approvals',
    version: 'latest',
    baseUrl: 'https://instance.service-now.com',
    authStrategy: 'sso_browser',
    authConfig: { strategy: 'sso_browser', loginUrl: 'https://instance.service-now.com/login.do', cookieDomain: 'service-now.com' },
    apiStyle: 'rest',
    tags: ['incidents', 'changes', 'cmdb', 'catalog', 'users', 'groups', 'approvals'],
    endpoints: buildServiceNowEndpoints(),
  },
  github: {
    title: 'GitHub API',
    description: 'GitHub REST API v3 - repositories, issues, pull requests, actions',
    version: 'v3',
    baseUrl: 'https://api.github.com',
    authStrategy: 'bearer',
    authConfig: { strategy: 'bearer', envVarName: 'GITHUB_TOKEN' },
    apiStyle: 'rest',
    tags: ['repos', 'issues', 'pulls', 'actions', 'users'],
    endpoints: buildGitHubEndpoints(),
  },
  jira: {
    title: 'Jira Cloud API',
    description: 'Atlassian Jira - issues, projects, sprints, boards',
    version: 'v3',
    baseUrl: 'https://your-domain.atlassian.net',
    authStrategy: 'api_key',
    authConfig: { strategy: 'api_key', headerName: 'Authorization', envVarName: 'JIRA_API_TOKEN' },
    apiStyle: 'rest',
    tags: ['issues', 'projects', 'boards', 'sprints'],
    endpoints: buildJiraEndpoints(),
  },
  confluence: {
    title: 'Confluence Cloud API',
    description: 'Atlassian Confluence - pages, spaces, search',
    version: 'v2',
    baseUrl: 'https://your-domain.atlassian.net/wiki',
    authStrategy: 'api_key',
    authConfig: { strategy: 'api_key', headerName: 'Authorization', envVarName: 'CONFLUENCE_API_TOKEN' },
    apiStyle: 'rest',
    tags: ['pages', 'spaces', 'search'],
    endpoints: [],
  },
  slack: {
    title: 'Slack Web API',
    description: 'Slack messaging - channels, messages, users, reactions',
    version: 'v2',
    baseUrl: 'https://slack.com/api',
    authStrategy: 'bearer',
    authConfig: { strategy: 'bearer', envVarName: 'SLACK_BOT_TOKEN' },
    apiStyle: 'rest',
    tags: ['channels', 'messages', 'users'],
    endpoints: [],
  },
  stripe: {
    title: 'Stripe API',
    description: 'Payment processing - customers, charges, subscriptions, invoices',
    version: 'v1',
    baseUrl: 'https://api.stripe.com/v1',
    authStrategy: 'bearer',
    authConfig: { strategy: 'bearer', envVarName: 'STRIPE_SECRET_KEY' },
    apiStyle: 'rest',
    tags: ['customers', 'charges', 'subscriptions', 'invoices', 'products'],
    endpoints: [],
  },
  akamai: {
    title: 'Akamai API',
    description: 'CDN and edge platform - properties, certificates, purge',
    version: 'v1',
    baseUrl: 'https://akab-xxxxx.luna.akamaiapis.net',
    authStrategy: 'api_key',
    authConfig: { strategy: 'api_key', headerName: 'Authorization', envVarName: 'AKAMAI_EDGERC' },
    apiStyle: 'rest',
    tags: ['property', 'purge', 'certificates', 'dns'],
    endpoints: [],
  },
  azure: {
    title: 'Azure Resource Manager API',
    description: 'Microsoft Azure cloud management API',
    version: '2023-01-01',
    baseUrl: 'https://management.azure.com',
    authStrategy: 'oauth2',
    authConfig: {
      strategy: 'oauth2',
      tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
      authUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
      scopes: ['https://management.azure.com/.default'],
    },
    apiStyle: 'rest',
    tags: ['subscriptions', 'resources', 'deployments'],
    endpoints: [],
  },
};

// ─── Endpoint Builders ───────────────────────────────────────

function ep(method: ApiEndpoint['method'], path: string, opId: string, summary: string, tags: string[], params: any[] = []): ApiEndpoint {
  return {
    method, path, operationId: opId, summary,
    parameters: params, tags, requiresAuth: true,
    responses: { '200': { statusCode: '200', description: 'Success' } },
  };
}

function pathParam(name: string, desc: string) {
  return { name, in: 'path' as const, required: true, type: 'string', description: desc };
}

function queryParam(name: string, desc: string, required = false) {
  return { name, in: 'query' as const, required, type: 'string', description: desc };
}

function buildServiceNowEndpoints(): ApiEndpoint[] {
  return [
    ep('GET', '/api/now/table/{tableName}', 'table_query', 'Query any ServiceNow table', ['table'], [pathParam('tableName', 'Table name'), queryParam('sysparm_query', 'Encoded query'), queryParam('sysparm_limit', 'Max results'), queryParam('sysparm_fields', 'Fields to return')]),
    ep('GET', '/api/now/table/{tableName}/{sys_id}', 'table_get', 'Get a single record', ['table'], [pathParam('tableName', 'Table name'), pathParam('sys_id', 'Record sys_id')]),
    ep('POST', '/api/now/table/{tableName}', 'table_create', 'Create a record', ['table'], [pathParam('tableName', 'Table name')]),
    ep('PUT', '/api/now/table/{tableName}/{sys_id}', 'table_update', 'Update a record', ['table'], [pathParam('tableName', 'Table name'), pathParam('sys_id', 'Record sys_id')]),
    ep('DELETE', '/api/now/table/{tableName}/{sys_id}', 'table_delete', 'Delete a record', ['table'], [pathParam('tableName', 'Table name'), pathParam('sys_id', 'Record sys_id')]),
    ep('GET', '/api/now/cmdb/instance/{className}', 'cmdb_list', 'List CMDB instances by class', ['cmdb'], [pathParam('className', 'CI class name')]),
    ep('GET', '/api/sn_sc/servicecatalog/items', 'catalog_items', 'List service catalog items', ['catalog']),
    ep('POST', '/api/sn_sc/servicecatalog/items/{sys_id}/order_now', 'catalog_order', 'Order a catalog item', ['catalog'], [pathParam('sys_id', 'Item sys_id')]),
  ];
}

function buildGitHubEndpoints(): ApiEndpoint[] {
  return [
    ep('GET', '/repos/{owner}/{repo}', 'get_repo', 'Get repository details', ['repos'], [pathParam('owner', 'Repo owner'), pathParam('repo', 'Repo name')]),
    ep('GET', '/repos/{owner}/{repo}/issues', 'list_issues', 'List issues', ['issues'], [pathParam('owner', 'Repo owner'), pathParam('repo', 'Repo name'), queryParam('state', 'open/closed/all')]),
    ep('POST', '/repos/{owner}/{repo}/issues', 'create_issue', 'Create an issue', ['issues'], [pathParam('owner', 'Repo owner'), pathParam('repo', 'Repo name')]),
    ep('GET', '/repos/{owner}/{repo}/pulls', 'list_pulls', 'List pull requests', ['pulls'], [pathParam('owner', 'Repo owner'), pathParam('repo', 'Repo name')]),
    ep('GET', '/repos/{owner}/{repo}/actions/runs', 'list_runs', 'List workflow runs', ['actions'], [pathParam('owner', 'Repo owner'), pathParam('repo', 'Repo name')]),
    ep('GET', '/user', 'get_user', 'Get authenticated user', ['users']),
  ];
}

function buildJiraEndpoints(): ApiEndpoint[] {
  return [
    ep('GET', '/rest/api/3/search', 'search_issues', 'Search issues with JQL', ['issues'], [queryParam('jql', 'JQL query', true), queryParam('maxResults', 'Max results')]),
    ep('GET', '/rest/api/3/issue/{issueIdOrKey}', 'get_issue', 'Get issue details', ['issues'], [pathParam('issueIdOrKey', 'Issue key like PROJ-123')]),
    ep('POST', '/rest/api/3/issue', 'create_issue', 'Create an issue', ['issues']),
    ep('PUT', '/rest/api/3/issue/{issueIdOrKey}', 'update_issue', 'Update an issue', ['issues'], [pathParam('issueIdOrKey', 'Issue key')]),
    ep('GET', '/rest/api/3/project', 'list_projects', 'List all projects', ['projects']),
    ep('GET', '/rest/agile/1.0/board', 'list_boards', 'List Jira boards', ['boards']),
    ep('GET', '/rest/agile/1.0/board/{boardId}/sprint', 'list_sprints', 'List sprints for a board', ['sprints'], [pathParam('boardId', 'Board ID')]),
  ];
}
