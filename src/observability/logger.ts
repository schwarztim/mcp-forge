/**
 * Structured logging with Winston
 * File-based logging to avoid breaking MCP's JSON-RPC over stdio
 */

import winston from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const LOG_FILE = process.env.THESUN_LOG_FILE ?? './logs/thesun.log';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// Ensure log directory exists
const logDir = dirname(LOG_FILE);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

/**
 * Custom format for structured logging
 */
const structuredFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Human-readable format for console (development)
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

/**
 * Main logger instance
 */
export const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'thesun' },
  transports: [
    // File transport (structured JSON)
    new winston.transports.File({
      filename: LOG_FILE,
      format: structuredFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // Error-only file
    new winston.transports.File({
      filename: LOG_FILE.replace('.log', '-error.log'),
      level: 'error',
      format: structuredFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

// Add console transport in development (but not when running as MCP server)
if (process.env.NODE_ENV !== 'production' && !process.env.MCP_MODE) {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: Record<string, unknown>): winston.Logger {
  return logger.child(context);
}

/**
 * Build-specific logger
 */
export function createBuildLogger(buildId: string, toolName: string): winston.Logger {
  return logger.child({ buildId, toolName });
}

/**
 * Log performance metrics
 */
export function logPerformance(
  operation: string,
  durationMs: number,
  meta?: Record<string, unknown>
): void {
  logger.info(`Performance: ${operation}`, {
    operation,
    durationMs,
    type: 'performance',
    ...meta,
  });
}

/**
 * Log API calls for debugging
 */
export function logApiCall(
  method: string,
  url: string,
  statusCode: number,
  durationMs: number,
  meta?: Record<string, unknown>
): void {
  const level = statusCode >= 400 ? 'warn' : 'debug';
  logger[level](`API: ${method} ${url} → ${statusCode}`, {
    method,
    url,
    statusCode,
    durationMs,
    type: 'api_call',
    ...meta,
  });
}

/**
 * Log state transitions
 */
export function logStateTransition(
  buildId: string,
  from: string,
  to: string,
  reason?: string
): void {
  logger.info(`State: ${from} → ${to}`, {
    buildId,
    from,
    to,
    reason,
    type: 'state_transition',
  });
}

/**
 * Log security events
 */
export function logSecurityEvent(
  event: string,
  severity: 'info' | 'warn' | 'critical',
  details: Record<string, unknown>
): void {
  const level = severity === 'critical' ? 'error' : severity;
  logger[level](`Security: ${event}`, {
    event,
    severity,
    type: 'security',
    ...details,
  });
}
