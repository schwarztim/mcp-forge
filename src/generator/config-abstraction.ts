/**
 * Configuration Abstraction Layer
 *
 * Ensures generated MCPs are generic and reusable by separating:
 * - Tool logic (generic, publishable to GitHub)
 * - Company-specific configuration (environment variables, .env files)
 *
 * All company data MUST be abstracted to environment variables.
 */

import { z } from 'zod';

/**
 * Configuration categories
 */
export type ConfigCategory = 'auth' | 'endpoint' | 'feature' | 'limit' | 'custom';

/**
 * Configuration item definition
 */
export interface ConfigItem {
  /** Environment variable name (e.g., AKAMAI_HOST) */
  envVar: string;
  /** Human-readable description */
  description: string;
  /** Category for documentation */
  category: ConfigCategory;
  /** Is this required for the MCP to function? */
  required: boolean;
  /** Default value if not set (only for non-secrets) */
  defaultValue?: string;
  /** Is this a secret that should never be logged? */
  isSecret: boolean;
  /** Example value for documentation (use fake data for secrets) */
  example: string;
  /** Validation pattern (regex) */
  pattern?: string;
}

/**
 * Standard config items common to most MCPs
 */
export const STANDARD_CONFIG_ITEMS: ConfigItem[] = [
  {
    envVar: 'LOG_LEVEL',
    description: 'Logging verbosity level',
    category: 'feature',
    required: false,
    defaultValue: 'info',
    isSecret: false,
    example: 'debug',
    pattern: '^(error|warn|info|debug)$',
  },
  {
    envVar: 'REQUEST_TIMEOUT',
    description: 'Request timeout in milliseconds',
    category: 'limit',
    required: false,
    defaultValue: '30000',
    isSecret: false,
    example: '30000',
    pattern: '^\\d+$',
  },
  {
    envVar: 'MAX_RETRIES',
    description: 'Maximum retry attempts for failed requests',
    category: 'limit',
    required: false,
    defaultValue: '3',
    isSecret: false,
    example: '3',
    pattern: '^\\d+$',
  },
  {
    envVar: 'RATE_LIMIT_RPS',
    description: 'Rate limit in requests per second',
    category: 'limit',
    required: false,
    defaultValue: '10',
    isSecret: false,
    example: '10',
    pattern: '^\\d+$',
  },
];

/**
 * Auth-type specific config templates
 */
export const AUTH_CONFIG_TEMPLATES: Record<string, ConfigItem[]> = {
  api_key: [
    {
      envVar: '{TOOL}_API_KEY',
      description: 'API key for authentication',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'sk-xxxxxxxxxxxxxxxxxxxx',
    },
  ],
  bearer: [
    {
      envVar: '{TOOL}_TOKEN',
      description: 'Bearer token for authentication',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'eyJhbGciOiJIUzI1NiIs...',
    },
  ],
  oauth2: [
    {
      envVar: '{TOOL}_CLIENT_ID',
      description: 'OAuth 2.0 client ID',
      category: 'auth',
      required: true,
      isSecret: false,
      example: 'client-id-12345',
    },
    {
      envVar: '{TOOL}_CLIENT_SECRET',
      description: 'OAuth 2.0 client secret',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'secret-xxxxxxxxxxxx',
    },
  ],
  basic: [
    {
      envVar: '{TOOL}_USERNAME',
      description: 'Basic auth username',
      category: 'auth',
      required: true,
      isSecret: false,
      example: 'api-user',
    },
    {
      envVar: '{TOOL}_PASSWORD',
      description: 'Basic auth password',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'your-password',
    },
  ],
  custom: [
    {
      envVar: '{TOOL}_AUTH_CONFIG',
      description: 'Custom authentication configuration (JSON)',
      category: 'auth',
      required: true,
      isSecret: true,
      example: '{"type":"custom","token":"xxx"}',
    },
  ],
  har_file: [
    {
      envVar: '{TOOL}_HAR_FILE_PATH',
      description: 'Path to HAR file containing authentication data',
      category: 'auth',
      required: false,
      isSecret: false,
      example: './auth/{tool}.har',
    },
    {
      envVar: '{TOOL}_LOGIN_URL',
      description: 'Login URL for interactive authentication (if HAR not available)',
      category: 'auth',
      required: false,
      isSecret: false,
      example: 'https://login.{tool}.com',
    },
    {
      envVar: '{TOOL}_EXTRACTED_TOKEN',
      description: 'Extracted auth token from HAR file (auto-populated)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: '',
    },
    {
      envVar: '{TOOL}_EXTRACTED_COOKIES',
      description: 'Extracted cookies from HAR file as JSON (auto-populated)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: '',
    },
  ],
  har_or_api_key: [
    {
      envVar: '{TOOL}_API_KEY',
      description: 'API key for authentication (if available)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: 'sk-xxxxxxxxxxxxxxxxxxxx',
    },
    {
      envVar: '{TOOL}_HAR_FILE_PATH',
      description: 'Path to HAR file containing authentication data (fallback if no API key)',
      category: 'auth',
      required: false,
      isSecret: false,
      example: './auth/{tool}.har',
    },
    {
      envVar: '{TOOL}_LOGIN_URL',
      description: 'Login URL for interactive authentication (fallback)',
      category: 'auth',
      required: false,
      isSecret: false,
      example: 'https://login.{tool}.com',
    },
    {
      envVar: '{TOOL}_EXTRACTED_TOKEN',
      description: 'Extracted auth token from HAR file (auto-populated)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: '',
    },
  ],
};

/**
 * Generate config items for a tool
 */
export function generateConfigItems(
  toolName: string,
  authType: string,
  additionalConfig?: ConfigItem[]
): ConfigItem[] {
  const toolPrefix = toolName.toUpperCase().replace(/-/g, '_');

  // Start with standard config
  const items: ConfigItem[] = [...STANDARD_CONFIG_ITEMS];

  // Add auth-specific config (with tool prefix substitution)
  const authTemplate = AUTH_CONFIG_TEMPLATES[authType] ?? [];
  for (const item of authTemplate) {
    items.push({
      ...item,
      envVar: item.envVar.replace('{TOOL}', toolPrefix),
      description: item.description.replace('{tool}', toolName),
    });
  }

  // Add tool-specific endpoint config
  items.push({
    envVar: `${toolPrefix}_BASE_URL`,
    description: `Base URL for ${toolName} API`,
    category: 'endpoint',
    required: false,
    isSecret: false,
    example: `https://api.${toolName.toLowerCase()}.com`,
    defaultValue: `https://api.${toolName.toLowerCase()}.com`,
  });

  // Add any additional config
  if (additionalConfig) {
    items.push(...additionalConfig);
  }

  return items;
}

/**
 * Generate Zod schema for config validation
 */
export function generateConfigSchema(items: ConfigItem[]): string {
  const lines: string[] = [
    `import { z } from 'zod';`,
    ``,
    `export const ConfigSchema = z.object({`,
  ];

  for (const item of items) {
    const zodType = item.pattern
      ? `z.string().regex(/${item.pattern}/)`
      : 'z.string()';

    const schema = item.required
      ? zodType
      : item.defaultValue
        ? `${zodType}.default('${item.defaultValue}')`
        : `${zodType}.optional()`;

    lines.push(`  /** ${item.description} */`);
    lines.push(`  ${item.envVar}: ${schema},`);
  }

  lines.push(`});`);
  lines.push(``);
  lines.push(`export type Config = z.infer<typeof ConfigSchema>;`);

  return lines.join('\n');
}

/**
 * Generate .env.example file content
 */
export function generateEnvExample(items: ConfigItem[]): string {
  const lines: string[] = [
    `# ${new Date().toISOString().split('T')[0]} - Auto-generated configuration`,
    `# Copy this file to .env and fill in your values`,
    ``,
  ];

  const byCategory = new Map<ConfigCategory, ConfigItem[]>();
  for (const item of items) {
    const categoryItems = byCategory.get(item.category) ?? [];
    categoryItems.push(item);
    byCategory.set(item.category, categoryItems);
  }

  const categoryOrder: ConfigCategory[] = ['auth', 'endpoint', 'limit', 'feature', 'custom'];

  for (const category of categoryOrder) {
    const categoryItems = byCategory.get(category);
    if (!categoryItems || categoryItems.length === 0) continue;

    lines.push(`# === ${category.toUpperCase()} ===`);

    for (const item of categoryItems) {
      lines.push(`# ${item.description}`);
      if (item.required) {
        lines.push(`# Required: yes`);
      }
      if (item.isSecret) {
        lines.push(`# Secret: yes (never commit real values)`);
      }
      const value = item.defaultValue ?? item.example;
      lines.push(`${item.envVar}=${item.isSecret ? '' : value}`);
      lines.push(``);
    }
  }

  return lines.join('\n');
}

/**
 * Generate README section for configuration
 */
export function generateConfigReadme(items: ConfigItem[]): string {
  const lines: string[] = [
    `## Configuration`,
    ``,
    `This MCP is configured via environment variables. Copy \`.env.example\` to \`.env\` and set your values.`,
    ``,
    `### Required Variables`,
    ``,
    `| Variable | Description |`,
    `|----------|-------------|`,
  ];

  const required = items.filter((i) => i.required);
  const optional = items.filter((i) => !i.required);

  for (const item of required) {
    lines.push(`| \`${item.envVar}\` | ${item.description} |`);
  }

  if (optional.length > 0) {
    lines.push(``);
    lines.push(`### Optional Variables`);
    lines.push(``);
    lines.push(`| Variable | Description | Default |`);
    lines.push(`|----------|-------------|---------|`);

    for (const item of optional) {
      lines.push(`| \`${item.envVar}\` | ${item.description} | \`${item.defaultValue ?? '-'}\` |`);
    }
  }

  lines.push(``);
  lines.push(`### Security Notes`);
  lines.push(``);
  lines.push(`- Never commit \`.env\` files with real credentials`);
  lines.push(`- Use secret management (Azure Key Vault, AWS Secrets Manager) in production`);
  lines.push(`- All secrets are marked in \`.env.example\` with \`# Secret: yes\``);

  return lines.join('\n');
}

/**
 * Check if code contains any hardcoded company-specific data
 */
export function detectHardcodedConfig(code: string): string[] {
  const issues: string[] = [];

  // Patterns that suggest hardcoded config
  const patterns = [
    // URLs with specific domains (not localhost/example.com)
    { regex: /https?:\/\/(?!localhost|127\.0\.0\.1|example\.com|api\.example\.com)[a-z0-9-]+\.(com|net|org|io)/gi, desc: 'Hardcoded domain' },
    // API keys/tokens (common patterns)
    { regex: /['"`](sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xoxb-[a-zA-Z0-9-]+)['"`]/g, desc: 'Hardcoded API key' },
    // Email addresses
    { regex: /['"`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"`]/g, desc: 'Hardcoded email' },
    // IP addresses (not localhost)
    { regex: /\b(?!127\.0\.0\.1)(?!0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, desc: 'Hardcoded IP address' },
  ];

  for (const { regex, desc } of patterns) {
    const matches = code.match(regex);
    if (matches) {
      for (const match of matches) {
        issues.push(`${desc}: ${match}`);
      }
    }
  }

  return issues;
}
