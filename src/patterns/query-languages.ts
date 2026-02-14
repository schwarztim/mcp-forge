/**
 * MCP Forge — Query Language Registry
 *
 * Known platform-specific query languages with syntax hints.
 * Learned from Brinqa build: BQL filter params get much better
 * tool descriptions when we include syntax examples.
 */

import type { QueryLanguageDef } from '../types/index.js';

export const QUERY_LANGUAGES: Record<string, QueryLanguageDef> = {
  bql: {
    name: 'BQL',
    fullName: 'Brinqa Query Language',
    platform: 'Brinqa',
    syntaxHint: 'field=value, field>value, field contains "text", AND/OR operators',
    examples: [
      'status=Active',
      'severity=Critical AND ageInDays < 30',
      'complianceStatus=Non-Compliant OR complianceStatus=Overdue',
      'displayName contains "prod"',
      'riskRating > 8',
    ],
    paramName: 'filter',
    docUrl: 'https://docs.brinqa.com/docs/bql',
  },

  jql: {
    name: 'JQL',
    fullName: 'Jira Query Language',
    platform: 'Jira',
    syntaxHint: 'field = value, field IN (a, b), ORDER BY field ASC/DESC',
    examples: [
      'project = PROJ AND status = "In Progress"',
      'assignee = currentUser() AND resolution = Unresolved',
      'priority IN (Highest, High) AND created >= -7d',
      'labels = "production" ORDER BY priority DESC',
      'type = Bug AND status != Done',
    ],
    paramName: 'jql',
    docUrl: 'https://support.atlassian.com/jira-software-cloud/docs/jql-fields/',
  },

  nrql: {
    name: 'NRQL',
    fullName: 'New Relic Query Language',
    platform: 'New Relic',
    syntaxHint: 'SELECT ... FROM ... WHERE ... SINCE ... FACET ...',
    examples: [
      'SELECT count(*) FROM Transaction SINCE 1 hour ago',
      'SELECT average(duration) FROM Transaction WHERE appName = "MyApp" FACET host',
      'SELECT * FROM SystemSample WHERE hostname LIKE "%prod%"',
    ],
    paramName: 'nrql',
    docUrl: 'https://docs.newrelic.com/docs/nrql/get-started/introduction-nrql-new-relics-query-language/',
  },

  kql: {
    name: 'KQL',
    fullName: 'Kusto Query Language',
    platform: 'Azure',
    syntaxHint: 'table | where field == "value" | project field1, field2 | top N by field',
    examples: [
      'SecurityEvent | where EventID == 4625 | top 10 by TimeGenerated',
      'Heartbeat | summarize count() by Computer',
      'AzureActivity | where OperationName contains "delete"',
    ],
    paramName: 'query',
    docUrl: 'https://learn.microsoft.com/en-us/azure/data-explorer/kusto/query/',
  },

  spl: {
    name: 'SPL',
    fullName: 'Splunk Processing Language',
    platform: 'Splunk',
    syntaxHint: 'search terms | command1 | command2 | stats count by field',
    examples: [
      'index=main sourcetype=syslog error | stats count by host',
      'index=web status>=400 | timechart count by status',
      'source="/var/log/messages" | top 10 user',
    ],
    paramName: 'search',
    docUrl: 'https://docs.splunk.com/Documentation/SplunkCloud/latest/SearchReference/',
  },

  sq: {
    name: 'Encoded Query',
    fullName: 'ServiceNow Encoded Query',
    platform: 'ServiceNow',
    syntaxHint: 'field=value^field2!=value2^ORfield3=value3^NQ (^ = AND, ^OR = OR, ^NQ = new query)',
    examples: [
      'state=1^priority=1',
      'assigned_to=javascript:gs.getUserID()^state!=7',
      'category=hardware^ORcategory=software^active=true',
      'sys_created_on>=javascript:gs.daysAgoStart(7)',
    ],
    paramName: 'sysparm_query',
    docUrl: 'https://docs.servicenow.com/bundle/latest/page/use/common-ui-elements/reference/r_OpAvailableFiltersQueries.html',
  },

  wql: {
    name: 'FQL',
    fullName: 'Falcon Query Language',
    platform: 'CrowdStrike',
    syntaxHint: "field:'value', field:['v1','v2'], field:>N, +field (AND), field (OR)",
    examples: [
      "platform_name:'Windows'+hostname:'PROD*'",
      "severity:>3+status:'new'",
      "device_id:['id1','id2']",
    ],
    paramName: 'filter',
    docUrl: 'https://falcon.crowdstrike.com/documentation/45/falcon-query-language-fql',
  },

  graphql_filter: {
    name: 'GraphQL Filter',
    fullName: 'GraphQL Where/Filter',
    platform: 'Generic GraphQL',
    syntaxHint: 'JSON-style: { field: { _eq: "value" }, _and: [...], _or: [...] }',
    examples: [
      '{ status: { _eq: "active" } }',
      '{ _and: [{ priority: { _gte: 3 } }, { status: { _neq: "closed" } }] }',
    ],
    paramName: 'where',
  },
};

/**
 * Detect which query language a platform uses
 */
export function detectQueryLanguage(
  platformName: string,
  endpoints?: Array<{ path: string; parameters: Array<{ name: string }> }>,
): QueryLanguageDef | undefined {
  const lower = platformName.toLowerCase();

  // Direct platform match
  for (const ql of Object.values(QUERY_LANGUAGES)) {
    if (ql.platform.toLowerCase() === lower) return ql;
  }

  // Keyword match
  if (lower.includes('brinqa')) return QUERY_LANGUAGES.bql;
  if (lower.includes('jira') || lower.includes('atlassian')) return QUERY_LANGUAGES.jql;
  if (lower.includes('newrelic') || lower.includes('new relic')) return QUERY_LANGUAGES.nrql;
  if (lower.includes('azure') || lower.includes('sentinel') || lower.includes('kusto')) return QUERY_LANGUAGES.kql;
  if (lower.includes('splunk')) return QUERY_LANGUAGES.spl;
  if (lower.includes('servicenow') || lower.includes('snow')) return QUERY_LANGUAGES.sq;
  if (lower.includes('crowdstrike') || lower.includes('falcon')) return QUERY_LANGUAGES.wql;

  // Detect from parameter names
  if (endpoints) {
    const allParams = endpoints.flatMap(e => e.parameters.map(p => p.name.toLowerCase()));
    if (allParams.includes('jql')) return QUERY_LANGUAGES.jql;
    if (allParams.includes('nrql')) return QUERY_LANGUAGES.nrql;
    if (allParams.includes('sysparm_query')) return QUERY_LANGUAGES.sq;
    if (allParams.includes('spl') || allParams.includes('search_query')) return QUERY_LANGUAGES.spl;
  }

  return undefined;
}

/**
 * Enrich a parameter description with query language syntax hints
 */
export function enrichFilterDescription(
  paramName: string,
  baseDescription: string,
  ql: QueryLanguageDef,
): string {
  const examples = ql.examples.slice(0, 3).map(e => `"${e}"`).join(', ');
  return `${baseDescription} (${ql.name}: ${ql.syntaxHint}). Examples: ${examples}`;
}
