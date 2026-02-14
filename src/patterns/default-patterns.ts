/**
 * Default API patterns for well-known services
 *
 * These patterns help thesun generate more reliable MCP implementations
 * by applying proven patterns from industry-leading APIs.
 */

import type { ApiPattern } from "./pattern-engine.js";

/**
 * Known API patterns indexed by service name
 */
export const KNOWN_PATTERNS: Record<string, ApiPattern> = {
  stripe: {
    name: "stripe",
    pagination: {
      style: "cursor",
      params: ["starting_after", "ending_before", "limit"],
    },
    errorFormat: {
      style: "stripe",
      errorPath: "error",
      messagePath: "error.message",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "Stripe-Version",
      // Stripe uses 429 status with Retry-After
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
    idempotency: {
      header: "Idempotency-Key",
    },
  },

  github: {
    name: "github",
    pagination: {
      style: "link-header",
      params: ["page", "per_page"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "message",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "X-RateLimit-Limit",
      remainingHeader: "X-RateLimit-Remaining",
      resetHeader: "X-RateLimit-Reset",
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  aws: {
    name: "aws",
    pagination: {
      style: "cursor",
      params: ["NextToken", "MaxResults", "MaxItems"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "Message",
    },
    rateLimiting: {
      hasRateLimiting: true,
      retryAfterHeader: "Retry-After",
    },
    auth: {
      type: "signature-v4",
    },
    regions: true, // AWS has regional endpoints
  },

  twilio: {
    name: "twilio",
    pagination: {
      style: "cursor",
      params: ["PageToken", "PageSize"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "message",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "basic",
      header: "Authorization",
    },
  },

  slack: {
    name: "slack",
    pagination: {
      style: "cursor",
      params: ["cursor", "limit"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "error",
    },
    rateLimiting: {
      hasRateLimiting: true,
      retryAfterHeader: "Retry-After",
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  shopify: {
    name: "shopify",
    pagination: {
      style: "link-header",
      params: ["limit"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "errors",
      messagePath: "errors",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "X-Shopify-Shop-Api-Call-Limit",
    },
    auth: {
      type: "api-key",
      header: "X-Shopify-Access-Token",
    },
  },

  salesforce: {
    name: "salesforce",
    pagination: {
      style: "cursor",
      params: ["nextRecordsUrl"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "message",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "Sforce-Limit-Info",
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  datadog: {
    name: "datadog",
    pagination: {
      style: "cursor",
      params: ["page[cursor]", "page[limit]"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "errors",
      messagePath: "errors",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "X-RateLimit-Limit",
      remainingHeader: "X-RateLimit-Remaining",
    },
    auth: {
      type: "api-key",
      header: "DD-API-KEY",
    },
  },

  sendgrid: {
    name: "sendgrid",
    pagination: {
      style: "offset",
      params: ["offset", "limit"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "errors",
      messagePath: "errors[0].message",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  mailchimp: {
    name: "mailchimp",
    pagination: {
      style: "offset",
      params: ["offset", "count"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "detail",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "basic",
      header: "Authorization",
    },
  },

  zendesk: {
    name: "zendesk",
    pagination: {
      style: "cursor",
      params: ["page[after]", "page[size]"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "error",
      messagePath: "error.message",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "X-Rate-Limit",
      remainingHeader: "X-Rate-Limit-Remaining",
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  intercom: {
    name: "intercom",
    pagination: {
      style: "cursor",
      params: ["starting_after", "per_page"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "errors",
      messagePath: "errors[0].message",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "X-RateLimit-Limit",
      remainingHeader: "X-RateLimit-Remaining",
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  jira: {
    name: "jira",
    pagination: {
      style: "offset",
      params: ["startAt", "maxResults"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "errorMessages",
      messagePath: "errorMessages",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  confluence: {
    name: "confluence",
    pagination: {
      style: "cursor",
      params: ["cursor", "limit"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "message",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },

  akamai: {
    name: "akamai",
    pagination: {
      style: "offset",
      params: ["offset", "limit"],
    },
    errorFormat: {
      style: "rfc7807",
      errorPath: "",
      messagePath: "detail",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "edgegrid",
      header: "Authorization",
    },
  },

  dynatrace: {
    name: "dynatrace",
    pagination: {
      style: "cursor",
      params: ["nextPageKey", "pageSize"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "error",
      messagePath: "error.message",
    },
    rateLimiting: {
      hasRateLimiting: true,
    },
    auth: {
      type: "api-key",
      header: "Authorization",
    },
  },

  elastic: {
    name: "elastic",
    pagination: {
      style: "cursor",
      params: ["search_after", "size"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "error",
      messagePath: "error.reason",
    },
    rateLimiting: {
      hasRateLimiting: false,
    },
    auth: {
      type: "basic",
      header: "Authorization",
    },
  },

  okta: {
    name: "okta",
    pagination: {
      style: "link-header",
      params: ["limit", "after"],
    },
    errorFormat: {
      style: "simple",
      errorPath: "",
      messagePath: "errorSummary",
    },
    rateLimiting: {
      hasRateLimiting: true,
      limitHeader: "X-Rate-Limit-Limit",
      remainingHeader: "X-Rate-Limit-Remaining",
      resetHeader: "X-Rate-Limit-Reset",
    },
    auth: {
      type: "bearer",
      header: "Authorization",
    },
  },
};

/**
 * Get all known pattern names
 */
export function getKnownPatternNames(): string[] {
  return Object.keys(KNOWN_PATTERNS);
}

/**
 * Check if a pattern exists for the given name
 */
export function hasPattern(name: string): boolean {
  const lowerName = name.toLowerCase();
  return Object.keys(KNOWN_PATTERNS).some(
    (key) => key === lowerName || lowerName.includes(key),
  );
}
