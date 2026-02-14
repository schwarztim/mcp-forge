/**
 * Core type definitions for thesun platform
 */

import { z } from "zod";

// ============================================================================
// Tool Definition
// ============================================================================

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string(),
  vendor: z.string().optional(),
  category: z.enum([
    "observability",
    "security",
    "devops",
    "data",
    "communication",
    "other",
  ]),
  authType: z.enum(["oauth2", "api_key", "basic", "bearer", "custom", "none"]),
  specSources: z
    .array(
      z.object({
        type: z.enum(["openapi", "swagger", "graphql", "grpc", "custom"]),
        url: z.string().url().optional(),
        path: z.string().optional(),
      }),
    )
    .optional(),
  docUrls: z.array(z.string().url()).optional(),
  existingMcps: z.array(z.string().url()).optional(),
});

export type ToolSpec = z.infer<typeof ToolSpecSchema>;

// ============================================================================
// Build State Machine
// ============================================================================

export const BuildPhase = {
  PENDING: "pending",
  DISCOVERING: "discovering",
  GENERATING: "generating",
  TESTING: "testing",
  SECURITY_SCAN: "security_scan",
  OPTIMIZING: "optimizing",
  VALIDATING: "validating",
  VALIDATE_REQUIREMENTS: "validate_requirements", // NEW: Final check all requirements met
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type BuildPhase = (typeof BuildPhase)[keyof typeof BuildPhase];

export const BuildStateSchema = z.object({
  id: z.string().uuid(),
  toolName: z.string(),
  phase: z.enum([
    "pending",
    "discovering",
    "generating",
    "testing",
    "security_scan",
    "optimizing",
    "validating",
    "validate_requirements",
    "completed",
    "failed",
  ]),
  bobInstanceId: z.string().uuid().optional(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),

  // Discovery results
  discovery: z
    .object({
      endpoints: z.number().default(0),
      specFiles: z.array(z.string()).default([]),
      authMethods: z.array(z.string()).default([]),
      gaps: z.array(z.string()).default([]),
    })
    .optional(),

  // Generation results
  generation: z
    .object({
      toolsGenerated: z.number().default(0),
      filesCreated: z.array(z.string()).default([]),
      templateUsed: z.string().optional(),
    })
    .optional(),

  // Test results
  testing: z
    .object({
      totalTests: z.number().default(0),
      passed: z.number().default(0),
      failed: z.number().default(0),
      coverage: z.number().default(0),
      iterations: z.number().default(0),
    })
    .optional(),

  // Security results
  security: z
    .object({
      sastIssues: z.number().default(0),
      criticalCves: z.number().default(0),
      secretsDetected: z.number().default(0),
      passed: z.boolean().default(false),
    })
    .optional(),

  // Performance metrics
  performance: z
    .object({
      startupTimeMs: z.number().optional(),
      avgRequestTimeMs: z.number().optional(),
      memoryUsageMb: z.number().optional(),
    })
    .optional(),

  // Requirement validation results
  requirementValidation: z
    .object({
      totalRequirements: z.number().default(0),
      passed: z.number().default(0),
      failed: z.number().default(0),
      failedRequirements: z.array(z.string()).default([]),
      remediationAttempts: z.number().default(0),
      allMet: z.boolean().default(false),
    })
    .optional(),
});

export type BuildState = z.infer<typeof BuildStateSchema>;

// ============================================================================
// Bob Instance
// ============================================================================

export const BobInstanceSchema = z.object({
  id: z.string().uuid(),
  toolName: z.string(),
  workspace: z.string(),
  env: z.record(z.string()),
  status: z.enum(["creating", "running", "stopped", "destroyed"]),
  createdAt: z.date(),
  lastActivityAt: z.date().optional(),
  pid: z.number().optional(),
});

export type BobInstance = z.infer<typeof BobInstanceSchema>;

// ============================================================================
// Discovery Types
// ============================================================================

export const DiscoveredEndpointSchema = z.object({
  path: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        in: z.enum(["path", "query", "header", "cookie"]),
        required: z.boolean().default(false),
        schema: z.unknown().optional(),
      }),
    )
    .default([]),
  requestBody: z.unknown().optional(),
  responses: z.record(z.unknown()).optional(),
  security: z.array(z.unknown()).optional(),
  pagination: z
    .object({
      supported: z.boolean(),
      style: z.enum(["offset", "cursor", "page", "link"]).optional(),
      params: z.array(z.string()).optional(),
    })
    .optional(),
});

export type DiscoveredEndpoint = z.infer<typeof DiscoveredEndpointSchema>;

export const DiscoveryResultSchema = z.object({
  toolName: z.string(),
  timestamp: z.date(),
  specVersion: z.string().optional(),
  baseUrl: z.string().url().optional(),
  endpoints: z.array(DiscoveredEndpointSchema),
  authSchemes: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  globalParameters: z.array(z.unknown()).default([]),
  rateLimits: z
    .object({
      requestsPerSecond: z.number().optional(),
      requestsPerMinute: z.number().optional(),
      requestsPerDay: z.number().optional(),
    })
    .optional(),
  existingMcpAnalysis: z
    .object({
      found: z.boolean(),
      url: z.string().optional(),
      coverage: z.number().optional(),
      gaps: z.array(z.string()).optional(),
    })
    .optional(),
});

export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

// ============================================================================
// Security Types
// ============================================================================

export const SecurityFindingSchema = z.object({
  id: z.string(),
  type: z.enum(["sast", "dependency", "secret", "config"]),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  title: z.string(),
  description: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  cwe: z.string().optional(),
  cve: z.string().optional(),
  remediation: z.string().optional(),
});

export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;

export const SecurityReportSchema = z.object({
  toolName: z.string(),
  timestamp: z.date(),
  passed: z.boolean(),
  findings: z.array(SecurityFindingSchema),
  summary: z.object({
    critical: z.number().default(0),
    high: z.number().default(0),
    medium: z.number().default(0),
    low: z.number().default(0),
    info: z.number().default(0),
  }),
});

export type SecurityReport = z.infer<typeof SecurityReportSchema>;

// ============================================================================
// Workflow Types
// ============================================================================

export const WorkflowTriggerSchema = z.object({
  type: z.enum([
    "jira_issue",
    "schedule",
    "webhook",
    "manual",
    "dependency_update",
  ]),
  config: z.record(z.unknown()),
});

export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["mcp_call", "script", "approval", "notification", "condition"]),
  config: z.record(z.unknown()),
  onSuccess: z.string().optional(),
  onFailure: z.string().optional(),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  triggers: z.array(WorkflowTriggerSchema),
  steps: z.array(WorkflowStepSchema),
  timeout: z.number().optional(),
  retries: z.number().default(0),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ============================================================================
// Orchestrator Config
// ============================================================================

export const OrchestratorConfigSchema = z.object({
  dataDir: z.string(),
  workspace: z.string(),
  maxParallelBuilds: z.number().default(4),
  bobIsolationMode: z.enum(["process", "container", "vm"]).default("process"),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  securityGates: z
    .object({
      blockOnCriticalSast: z.boolean().default(true),
      blockOnCriticalCve: z.boolean().default(true),
      blockOnSecrets: z.boolean().default(true),
      minCoverage: z.number().default(70),
    })
    .default({}),
  feedbackLoops: z
    .object({
      maxTestIterations: z.number().default(5),
      maxOptimizationIterations: z.number().default(3),
      performanceThresholdMs: z.number().default(100),
    })
    .default({}),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

// ============================================================================
// Requirement Tracking Types
// ============================================================================

export const RequirementTypeSchema = z.enum([
  "generate_mcp", // Generate an MCP server
  "run_archcheck", // Run archcheck skill
  "publish_github", // Publish to GitHub
  "create_confluence", // Create Confluence page
  "run_tests", // Run test suite
  "security_scan", // Run security scan
  "custom", // Custom requirement
]);

export type RequirementType = z.infer<typeof RequirementTypeSchema>;

export const RequirementStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
]);

export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

export const RequirementSchema = z.object({
  id: z.string(),
  type: RequirementTypeSchema,
  description: z.string(),
  target: z.string().optional(), // e.g., tool name, page title
  status: RequirementStatusSchema.default("pending"),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
  error: z.string().optional(),
  evidence: z
    .object({
      // Proof of completion
      files: z.array(z.string()).optional(), // Files created
      urls: z.array(z.string()).optional(), // URLs (GitHub, Confluence)
      commands: z.array(z.string()).optional(), // Commands run
      outputs: z.array(z.string()).optional(), // Command outputs
    })
    .optional(),
  dependencies: z.array(z.string()).optional(), // Other requirement IDs that must complete first
});

export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementSetSchema = z.object({
  id: z.string().uuid(),
  originalRequest: z.string(), // Raw user request
  parsedAt: z.date(),
  requirements: z.array(RequirementSchema),
  targets: z.array(z.string()), // All tools/targets extracted
  validationRules: z
    .array(
      z.object({
        requirementId: z.string(),
        rule: z.string(), // e.g., "file_exists", "url_accessible", "tests_pass"
        params: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
});

export type RequirementSet = z.infer<typeof RequirementSetSchema>;

// ============================================================================
// Discovery Logging Types
// ============================================================================

export const DiscoverySourceSchema = z.object({
  type: z.enum([
    "web_search",
    "openapi_spec",
    "existing_mcp",
    "vendor_docs",
    "github",
    "npm",
  ]),
  url: z.string(),
  title: z.string().optional(),
  relevance: z.number().min(0).max(1).optional(), // 0-1 relevance score
  usedInGeneration: z.boolean().default(false),
  timestamp: z.date(),
  content: z.string().optional(), // Summary or key info extracted
});

export type DiscoverySource = z.infer<typeof DiscoverySourceSchema>;

export const DiscoveryLogSchema = z.object({
  toolName: z.string(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  sources: z.array(DiscoverySourceSchema),
  summary: z
    .object({
      totalSourcesFound: z.number(),
      sourcesUsed: z.number(),
      openApiSpecsFound: z.number(),
      existingMcpsFound: z.number(),
      vendorDocsFound: z.number(),
    })
    .optional(),
  decisions: z
    .array(
      z.object({
        // Log why certain sources were used/rejected
        source: z.string(),
        decision: z.enum(["used", "rejected", "reference_only"]),
        reason: z.string(),
      }),
    )
    .optional(),
});

export type DiscoveryLog = z.infer<typeof DiscoveryLogSchema>;

// ============================================================================
// Validation Types
// ============================================================================

export const ValidationRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum([
    "file_exists", // Check file exists at path
    "directory_exists", // Check directory exists
    "url_accessible", // Check URL is accessible
    "command_succeeds", // Run command, check exit code 0
    "file_contains", // Check file contains string/pattern
    "git_remote_exists", // Check git remote is configured
    "confluence_page_exists", // Check Confluence page exists
    "tests_pass", // npm test passes
    "build_succeeds", // npm run build passes
    "custom", // Custom validation function
  ]),
  params: z.record(z.unknown()),
});

export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

export const ValidationResultSchema = z.object({
  ruleId: z.string(),
  passed: z.boolean(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  timestamp: z.date(),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const RequirementValidationReportSchema = z.object({
  requirementSetId: z.string(),
  validatedAt: z.date(),
  allPassed: z.boolean(),
  results: z.array(
    z.object({
      requirementId: z.string(),
      requirementDescription: z.string(),
      passed: z.boolean(),
      validationResults: z.array(ValidationResultSchema),
      remediationNeeded: z.boolean(),
      remediationSteps: z.array(z.string()).optional(),
    }),
  ),
  summary: z.object({
    totalRequirements: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }),
});

export type RequirementValidationReport = z.infer<
  typeof RequirementValidationReportSchema
>;

// ============================================================================
// Dependency Checking Types
// ============================================================================

export const DependencyStatusSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  available: z.boolean(),
  version: z.string().optional(),
  installCommand: z.string().optional(),
  error: z.string().optional(),
});

export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

export const PreflightCheckResultSchema = z.object({
  passed: z.boolean(),
  dependencies: z.array(DependencyStatusSchema),
  missingRequired: z.array(z.string()),
  timestamp: z.date(),
});

export type PreflightCheckResult = z.infer<typeof PreflightCheckResultSchema>;

// ============================================================================
// MCP Registry Search Types
// ============================================================================

export const McpQualityScoreSchema = z.object({
  coverage: z.number().min(0).max(100),
  maintenance: z.number().min(0).max(100),
  security: z.number().min(0).max(100),
  authSupport: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
});

export type McpQualityScore = z.infer<typeof McpQualityScoreSchema>;

export const ExistingMcpSchema = z.object({
  name: z.string(),
  source: z.enum([
    "npm",
    "github",
    "smithery",
    "user-installed",
    "mcp-registry",
  ]),
  url: z.string(),
  version: z.string().optional(),
  lastUpdated: z.date().optional(),
  stars: z.number().optional(),
  description: z.string().optional(),
  score: McpQualityScoreSchema.optional(),
  recommendation: z.enum(["use", "extend", "generate-new"]).optional(),
});

export type ExistingMcp = z.infer<typeof ExistingMcpSchema>;

export const McpSearchResultSchema = z.object({
  target: z.string(),
  searched: z.array(z.string()),
  found: z.array(ExistingMcpSchema),
  bestMatch: ExistingMcpSchema.optional(),
  recommendation: z.enum(["use-existing", "extend-existing", "generate-new"]),
  timestamp: z.date(),
});

export type McpSearchResult = z.infer<typeof McpSearchResultSchema>;

// ============================================================================
// Credential Wizard Types
// ============================================================================

export const AuthTypeSchema = z.enum([
  "oauth2",
  "oauth2-pkce",
  "api-key",
  "bearer",
  "session-cookie",
  "basic",
  "none",
]);

export type AuthType = z.infer<typeof AuthTypeSchema>;

export const StoredCredentialSchema = z.object({
  target: z.string(),
  authType: AuthTypeSchema,
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  apiKey: z.string().optional(),
  sessionCookie: z.string().optional(),
  expiresAt: z.number().optional(), // Unix timestamp (milliseconds)
  scopes: z.array(z.string()).optional(),
  baseUrl: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

export const CredentialMetaSchema = z.object({
  target: z.string(),
  authType: AuthTypeSchema,
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
  lastRefresh: z.coerce.date().optional(),
  refreshCount: z.number().default(0),
});

export type CredentialMeta = z.infer<typeof CredentialMetaSchema>;

// ============================================================================
// Self-Healing / Health Monitoring Types
// ============================================================================

export const EndpointHealthStatusSchema = z.enum(["ok", "error", "timeout"]);

export type EndpointHealthStatus = z.infer<typeof EndpointHealthStatusSchema>;

export const CheckedEndpointSchema = z.object({
  endpoint: z.string(),
  status: EndpointHealthStatusSchema,
  latencyMs: z.number(),
  error: z.string().optional(),
});

export type CheckedEndpoint = z.infer<typeof CheckedEndpointSchema>;

export const HealthCheckResultSchema = z.object({
  target: z.string(),
  healthy: z.boolean(),
  checkedEndpoints: z.array(CheckedEndpointSchema),
  authValid: z.boolean(),
  timestamp: z.coerce.date(),
});

export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

export const RecoveryActionTypeSchema = z.enum([
  "refresh-auth",
  "backoff",
  "regenerate",
  "retry",
  "none",
]);

export type RecoveryActionType = z.infer<typeof RecoveryActionTypeSchema>;

export const RecoveryActionSchema = z.object({
  action: RecoveryActionTypeSchema,
  waitMs: z.number().optional(),
  message: z.string(),
});

export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const HealthMetricsSchema = z.object({
  target: z.string(),
  successCount: z.number(),
  failureCount: z.number(),
  successRate: z.number(),
  lastSuccess: z.coerce.date().optional(),
  lastFailure: z.coerce.date().optional(),
  errorPatterns: z.record(z.number()), // statusCode -> count
});

export type HealthMetrics = z.infer<typeof HealthMetricsSchema>;

export const AuthHealthStatusSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
  expiresAt: z.number().optional(),
  needsRefresh: z.boolean(),
});

export type AuthHealthStatus = z.infer<typeof AuthHealthStatusSchema>;

export const VersionCheckResultSchema = z.object({
  target: z.string(),
  expectedVersion: z.string(),
  actualVersion: z.string().optional(),
  compatible: z.boolean(),
  deprecationWarning: z.string().optional(),
});

export type VersionCheckResult = z.infer<typeof VersionCheckResultSchema>;

// ============================================================================
// Validation Gate Types
// ============================================================================

export const ValidationGatePhaseSchema = z.enum([
  "build",
  "endpoints",
  "auth",
  "integration",
]);

export type ValidationGatePhase = z.infer<typeof ValidationGatePhaseSchema>;

export const ValidationDetailSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  error: z.string().optional(),
  duration: z.number().optional(),
});

export type ValidationDetail = z.infer<typeof ValidationDetailSchema>;

export const ValidationPhaseResultSchema = z.object({
  phase: ValidationGatePhaseSchema,
  passed: z.boolean(),
  details: z.array(ValidationDetailSchema),
  timestamp: z.coerce.date(),
});

export type ValidationPhaseResult = z.infer<typeof ValidationPhaseResultSchema>;

export const ValidationGateResultSchema = z.object({
  target: z.string(),
  allPassed: z.boolean(),
  phases: z.array(ValidationPhaseResultSchema),
  iterations: z.number(),
  totalDuration: z.number(),
  failedPhase: ValidationGatePhaseSchema.optional(),
});

export type ValidationGateResult = z.infer<typeof ValidationGateResultSchema>;

// ============================================================================
// Smart Cache Types
// ============================================================================

export const CachedSpecSchema = z.object({
  target: z.string(),
  specUrl: z.string(),
  hash: z.string(), // SHA256
  fetchedAt: z.coerce.date(),
  version: z.string().optional(),
  endpoints: z.array(z.string()), // List of endpoint paths
});

export type CachedSpec = z.infer<typeof CachedSpecSchema>;

export const CacheDiffSchema = z.object({
  target: z.string(),
  added: z.array(z.string()), // New endpoints
  removed: z.array(z.string()), // Removed endpoints
  modified: z.array(z.string()), // Changed endpoints
  unchanged: z.array(z.string()), // Same endpoints
});

export type CacheDiff = z.infer<typeof CacheDiffSchema>;

export const CacheStatsSchema = z.object({
  targets: z.array(z.string()),
  totalSize: z.number(),
  oldestEntry: z.coerce.date().optional(),
  newestEntry: z.coerce.date().optional(),
});

export type CacheStats = z.infer<typeof CacheStatsSchema>;

export const ModifiedFileSchema = z.object({
  path: z.string(),
  modifiedAt: z.coerce.date(),
  backupPath: z.string().optional(),
});

export type ModifiedFile = z.infer<typeof ModifiedFileSchema>;

export const HarEntrySchema = z.object({
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
    postData: z.unknown().optional(),
  }),
  response: z.object({
    status: z.number(),
    statusText: z.string(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
    content: z.unknown().optional(),
  }),
  startedDateTime: z.string(),
  time: z.number(),
});

export type HarEntry = z.infer<typeof HarEntrySchema>;

export const HarFileSchema = z.object({
  log: z.object({
    version: z.string(),
    creator: z.object({ name: z.string(), version: z.string() }),
    entries: z.array(HarEntrySchema),
  }),
});

export type HarFile = z.infer<typeof HarFileSchema>;

// ============================================================================
// Global SSO Credential Types
// ============================================================================

export const SsoIdpTypeSchema = z.enum([
  "azure-ad",
  "okta",
  "auth0",
  "generic",
]);

export type SsoIdpType = z.infer<typeof SsoIdpTypeSchema>;

export const GlobalSsoCredentialSchema = z.object({
  realm: z.string().describe("Domain realm, e.g., 'qvc.com'"),
  email: z.string().email().describe("User email address"),
  passwordKeychainKey: z
    .string()
    .describe("Keychain entry name for password storage"),
  mfaScript: z.string().optional().describe("Path to TOTP generator script"),
  idpType: SsoIdpTypeSchema.describe("Identity provider type"),
  tenantId: z.string().optional().describe("Azure AD tenant ID if applicable"),
  createdAt: z.coerce.date(),
  lastUsed: z.coerce.date(),
});

export type GlobalSsoCredential = z.infer<typeof GlobalSsoCredentialSchema>;

export const GlobalSsoStoreSchema = z.object({
  version: z.number().default(1),
  credentials: z.array(GlobalSsoCredentialSchema),
  updatedAt: z.coerce.date(),
});

export type GlobalSsoStore = z.infer<typeof GlobalSsoStoreSchema>;

// ============================================================================
// SSO Detection Types
// ============================================================================

export const SsoDetectionResultSchema = z.object({
  requiresSso: z.boolean(),
  idpType: SsoIdpTypeSchema.nullable(),
  realm: z.string().nullable(),
  loginUrl: z.string().nullable(),
  tenantId: z.string().nullable().optional(),
  indicators: z.array(z.string()).describe("Evidence that led to detection"),
  existingCredential: GlobalSsoCredentialSchema.optional(),
});

export type SsoDetectionResult = z.infer<typeof SsoDetectionResultSchema>;

// ============================================================================
// SSO Pattern Types
// ============================================================================

export const SsoPatternSchema = z.object({
  name: z.string(),
  idpType: SsoIdpTypeSchema,
  urlPatterns: z
    .array(z.string())
    .describe("URL patterns that indicate this IdP"),
  realmExtractor: z
    .string()
    .optional()
    .describe("Regex to extract realm from URL"),
  authModule: z
    .string()
    .describe("Name of auth module to generate, e.g., 'azure-ad-sso-auth'"),
});

export type SsoPattern = z.infer<typeof SsoPatternSchema>;

// ============================================================================
// Config Validation Types
// ============================================================================

export const ConfigValidationRuleSchema = z.object({
  field: z.string(),
  type: z.enum(["email", "url", "non-empty", "json-safe"]),
  message: z.string().describe("Error message if validation fails"),
});

export type ConfigValidationRule = z.infer<typeof ConfigValidationRuleSchema>;

export const ConfigValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      field: z.string(),
      value: z.string(),
      message: z.string(),
    }),
  ),
  corrupted: z.boolean().describe("True if corruption pattern detected"),
  recoverable: z.boolean().describe("True if backup exists and is valid"),
});
