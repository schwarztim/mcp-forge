/**
 * MCP Forge — Core Types
 *
 * Every type the forge pipeline needs, from initial spec analysis
 * through code generation and registration.
 */

// ─── API Analysis ────────────────────────────────────────────

export type AuthStrategy = 'none' | 'api_key' | 'oauth2' | 'sso_browser' | 'basic' | 'bearer' | 'har_capture';
export type ApiStyle = 'rest' | 'graphql' | 'grpc' | 'soap' | 'websocket';
export type InputFormat = 'openapi' | 'har' | 'url' | 'name_only' | 'swagger' | 'postman' | 'browser_capture';
export type OutputLanguage = 'typescript';

export interface ForgeConfig {
  target: string;
  inputFormat: InputFormat;
  specPath?: string;
  outputDir?: string;
  authStrategy?: AuthStrategy;
  baseUrl?: string;
  dryRun?: boolean;
}

// ─── Service Grouping (learned from MS365 build) ─────────────

export interface ServiceGroup {
  name: string;
  prefix: string;
  tokenType: TokenType;
  endpoints: ApiEndpoint[];
  baseUrl?: string;
  customHeaders?: Record<string, string>;
}

export type TokenType = 'primary' | 'secondary' | 'graph' | 'custom';

export interface TokenConfig {
  type: TokenType;
  name: string;
  captureUrl: string;
  ttlMs: number;
  scopes?: string[];
}

// ─── Discovery Pass Tracking ─────────────────────────────────

export interface DiscoveryPass {
  timestamp: number;
  method: 'optic' | 'browser' | 'har' | 'postman';
  totalRequests: number;
  uniqueEndpoints: number;
  newEndpoints: number;
  harPath?: string;
  endpointsPath?: string;
}

export interface DiscoveryState {
  target: string;
  passes: DiscoveryPass[];
  mergedEndpoints: number;
  serviceGroups: Record<string, number>;
}

// ─── Region Detection ────────────────────────────────────────

export interface RegionConfig {
  region: string;
  apiPrefix: string;
  detected: boolean;
}

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  parameters: ApiParameter[];
  requestBody?: ApiRequestBody;
  responses: Record<string, ApiResponse>;
  tags: string[];
  requiresAuth: boolean;
}

export interface ApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required: boolean;
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
}

export interface ApiRequestBody {
  contentType: string;
  schema: Record<string, unknown>;
  required: boolean;
  description?: string;
}

export interface ApiResponse {
  statusCode: string;
  description: string;
  schema?: Record<string, unknown>;
}

export interface ApiSpec {
  title: string;
  description: string;
  version: string;
  baseUrl: string;
  authStrategy: AuthStrategy;
  authConfig: AuthConfig;
  apiStyle: ApiStyle;
  endpoints: ApiEndpoint[];
  tags: string[];
  envVars: EnvVar[];
}

export interface AuthConfig {
  strategy: AuthStrategy;
  tokenUrl?: string;
  authUrl?: string;
  clientId?: string;
  scopes?: string[];
  tenantId?: string;
  headerName?: string;
  queryParam?: string;
  envVarName?: string;
  loginUrl?: string;
  cookieDomain?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface GenerationResult {
  success: boolean;
  outputDir: string;
  files: GeneratedFile[];
  mcpName: string;
  toolCount: number;
  resourceCount: number;
  errors: string[];
  warnings: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpoint: ApiEndpoint;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  endpoint: ApiEndpoint;
}

export interface EnvVar {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default?: string;
  example: string;
}

export interface McpRegistration {
  command: string;
  args: string[];
  env?: Record<string, string>;
  autostart?: boolean;
}

export type PipelinePhase =
  | 'init'
  | 'analyzing'
  | 'planning'
  | 'generating'
  | 'testing'
  | 'registering'
  | 'complete'
  | 'failed';

export interface PipelineState {
  phase: PipelinePhase;
  config: ForgeConfig;
  spec?: ApiSpec;
  result?: GenerationResult;
  startTime: number;
  errors: string[];
  log: string[];
}

// ══════════════════════════════════════════════════════════════════
// thesun Intelligence Layer Types (merged into Forge v3)
// ══════════════════════════════════════════════════════════════════

import { z } from 'zod';

// Re-export everything from thesun types for backward compatibility
export {
  ToolSpecSchema, type ToolSpec,
  BuildPhase, BuildStateSchema, type BuildState,
  BobInstanceSchema, type BobInstance,
  DiscoveredEndpointSchema, type DiscoveredEndpoint,
  DiscoveryResultSchema, type DiscoveryResult,
  SecurityFindingSchema, type SecurityFinding,
  SecurityReportSchema, type SecurityReport,
  WorkflowTriggerSchema, type WorkflowTrigger,
  WorkflowStepSchema, type WorkflowStep,
  WorkflowDefinitionSchema, type WorkflowDefinition,
  OrchestratorConfigSchema, type OrchestratorConfig,
  RequirementTypeSchema, type RequirementType,
  RequirementStatusSchema, type RequirementStatus,
  RequirementSchema, type Requirement,
  RequirementSetSchema, type RequirementSet,
  DiscoverySourceSchema, type DiscoverySource,
  DiscoveryLogSchema, type DiscoveryLog,
  ValidationRuleSchema, type ValidationRule,
  ValidationResultSchema, type ValidationResult,
  RequirementValidationReportSchema, type RequirementValidationReport,
  DependencyStatusSchema, type DependencyStatus,
  PreflightCheckResultSchema, type PreflightCheckResult,
  McpQualityScoreSchema, type McpQualityScore,
  ExistingMcpSchema, type ExistingMcp,
  McpSearchResultSchema, type McpSearchResult,
  AuthTypeSchema, type AuthType,
  StoredCredentialSchema, type StoredCredential,
  CredentialMetaSchema, type CredentialMeta,
  EndpointHealthStatusSchema, type EndpointHealthStatus,
  CheckedEndpointSchema, type CheckedEndpoint,
  HealthCheckResultSchema, type HealthCheckResult,
  RecoveryActionTypeSchema, type RecoveryActionType,
  RecoveryActionSchema, type RecoveryAction,
  HealthMetricsSchema, type HealthMetrics,
  AuthHealthStatusSchema, type AuthHealthStatus,
  VersionCheckResultSchema, type VersionCheckResult,
  ValidationGatePhaseSchema, type ValidationGatePhase,
  ValidationDetailSchema, type ValidationDetail,
  ValidationPhaseResultSchema, type ValidationPhaseResult,
  ValidationGateResultSchema, type ValidationGateResult,
  CachedSpecSchema, type CachedSpec,
  CacheDiffSchema, type CacheDiff,
  CacheStatsSchema, type CacheStats,
  ModifiedFileSchema, type ModifiedFile,
  HarEntrySchema, type HarEntry,
  HarFileSchema, type HarFile,
  SsoIdpTypeSchema, type SsoIdpType,
  GlobalSsoCredentialSchema, type GlobalSsoCredential,
  GlobalSsoStoreSchema, type GlobalSsoStore,
  SsoDetectionResultSchema, type SsoDetectionResult,
  SsoPatternSchema, type SsoPattern,
  ConfigValidationRuleSchema, type ConfigValidationRule,
  ConfigValidationResultSchema,
} from './thesun-types.js';
