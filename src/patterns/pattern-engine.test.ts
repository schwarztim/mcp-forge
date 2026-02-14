import { describe, it, expect } from "vitest";
import {
  PatternEngine,
  ApiPattern,
  PaginationStyle,
  ErrorFormatStyle,
} from "./pattern-engine.js";
import { KNOWN_PATTERNS } from "./default-patterns.js";

describe("PatternEngine", () => {
  const engine = new PatternEngine();

  describe("detectPagination", () => {
    it("detects cursor-style pagination (Stripe)", () => {
      const params = ["starting_after", "ending_before", "limit"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("cursor");
      expect(result.params).toContain("starting_after");
      expect(result.params).toContain("ending_before");
    });

    it("detects offset pagination", () => {
      const params = ["offset", "limit", "count"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("offset");
      expect(result.params).toContain("offset");
      expect(result.params).toContain("limit");
    });

    it("detects page-based pagination", () => {
      const params = ["page", "per_page", "total"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("page");
      expect(result.params).toContain("page");
    });

    it("detects GitHub-style page_size pagination", () => {
      const params = ["page", "page_size"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("page");
      expect(result.params).toContain("page");
      expect(result.params).toContain("page_size");
    });

    it("detects token-based pagination (AWS)", () => {
      const params = ["NextToken", "MaxResults"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("cursor");
      expect(result.params).toContain("NextToken");
    });

    it("returns none for no pagination params", () => {
      const params = ["id", "name", "value"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("none");
      expect(result.params).toHaveLength(0);
    });

    it("handles case-insensitive matching", () => {
      const params = ["OFFSET", "LIMIT"];
      const result = engine.detectPagination(params);

      expect(result.style).toBe("offset");
    });
  });

  describe("detectErrorFormat", () => {
    it("detects Stripe error format", () => {
      const response = {
        error: {
          type: "card_error",
          code: "card_declined",
          message: "Your card was declined",
          param: "card_number",
        },
      };

      const result = engine.detectErrorFormat(response);

      expect(result.style).toBe("stripe");
      expect(result.errorPath).toBe("error");
      expect(result.messagePath).toBe("error.message");
    });

    it("detects RFC 7807 problem detail format", () => {
      const response = {
        type: "https://api.example.com/errors/not-found",
        title: "Resource not found",
        status: 404,
        detail: "The requested resource could not be found.",
        instance: "/users/123",
      };

      const result = engine.detectErrorFormat(response);

      expect(result.style).toBe("rfc7807");
      expect(result.messagePath).toBe("detail");
    });

    it("detects simple error with message field", () => {
      const response = {
        message: "Something went wrong",
        status: 500,
      };

      const result = engine.detectErrorFormat(response);

      expect(result.style).toBe("simple");
      expect(result.messagePath).toBe("message");
    });

    it("detects simple error with error string", () => {
      const response = {
        error: "Authentication failed",
      };

      const result = engine.detectErrorFormat(response);

      expect(result.style).toBe("simple");
      expect(result.messagePath).toBe("error");
    });

    it("returns unknown for unrecognized format", () => {
      const response = {
        success: false,
        data: null,
      };

      const result = engine.detectErrorFormat(response);

      expect(result.style).toBe("unknown");
    });

    it("detects nested error message", () => {
      const response = {
        error: {
          message: "Invalid request",
        },
      };

      const result = engine.detectErrorFormat(response);

      expect(result.messagePath).toBe("error.message");
    });
  });

  describe("detectRateLimiting", () => {
    it("detects standard rate limit headers", () => {
      const headers = {
        "X-RateLimit-Limit": "1000",
        "X-RateLimit-Remaining": "999",
        "X-RateLimit-Reset": "1640000000",
      };

      const result = engine.detectRateLimiting(headers);

      expect(result.hasRateLimiting).toBe(true);
      expect(result.limitHeader).toBe("X-RateLimit-Limit");
      expect(result.remainingHeader).toBe("X-RateLimit-Remaining");
      expect(result.resetHeader).toBe("X-RateLimit-Reset");
    });

    it("detects Retry-After header", () => {
      const headers = {
        "Retry-After": "120",
      };

      const result = engine.detectRateLimiting(headers);

      expect(result.hasRateLimiting).toBe(true);
      expect(result.retryAfterHeader).toBe("Retry-After");
    });

    it("detects RateLimit-* headers (IETF draft)", () => {
      const headers = {
        RateLimit: "100",
        "RateLimit-Policy": "100;w=60",
        "RateLimit-Remaining": "50",
      };

      const result = engine.detectRateLimiting(headers);

      expect(result.hasRateLimiting).toBe(true);
      expect(result.limitHeader).toBe("RateLimit");
    });

    it("returns no rate limiting when no headers present", () => {
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": "1234",
      };

      const result = engine.detectRateLimiting(headers);

      expect(result.hasRateLimiting).toBe(false);
    });

    it("handles case-insensitive header matching", () => {
      const headers = {
        "x-ratelimit-limit": "500",
        "x-ratelimit-remaining": "499",
      };

      const result = engine.detectRateLimiting(headers);

      expect(result.hasRateLimiting).toBe(true);
    });

    it("detects GitHub rate limit headers", () => {
      const headers = {
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "4999",
        "X-RateLimit-Reset": "1640000000",
        "X-RateLimit-Used": "1",
        "X-RateLimit-Resource": "core",
      };

      const result = engine.detectRateLimiting(headers);

      expect(result.hasRateLimiting).toBe(true);
      expect(result.limitHeader).toBe("X-RateLimit-Limit");
    });
  });

  describe("detectAuthHeader", () => {
    it("detects Bearer token authentication", () => {
      const headers = {
        Authorization: "Bearer sk_test_1234",
      };

      const result = engine.detectAuthHeader(headers);

      expect(result.type).toBe("bearer");
      expect(result.header).toBe("Authorization");
    });

    it("detects Basic authentication", () => {
      const headers = {
        Authorization: "Basic dXNlcjpwYXNz",
      };

      const result = engine.detectAuthHeader(headers);

      expect(result.type).toBe("basic");
      expect(result.header).toBe("Authorization");
    });

    it("detects X-API-Key header", () => {
      const headers = {
        "X-API-Key": "my-api-key-123",
      };

      const result = engine.detectAuthHeader(headers);

      expect(result.type).toBe("api-key");
      expect(result.header).toBe("X-API-Key");
    });

    it("detects Api-Key header (alternate)", () => {
      const headers = {
        "Api-Key": "my-api-key-123",
      };

      const result = engine.detectAuthHeader(headers);

      expect(result.type).toBe("api-key");
      expect(result.header).toBe("Api-Key");
    });

    it("returns none when no auth header found", () => {
      const headers = {
        "Content-Type": "application/json",
      };

      const result = engine.detectAuthHeader(headers);

      expect(result.type).toBe("none");
    });
  });

  describe("matchKnownPattern", () => {
    it("matches Stripe by name", () => {
      const result = engine.matchKnownPattern("stripe");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("stripe");
      expect(result?.pagination.style).toBe("cursor");
      expect(result?.idempotency?.header).toBe("Idempotency-Key");
    });

    it("matches GitHub by name", () => {
      const result = engine.matchKnownPattern("github");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("github");
      expect(result?.pagination.style).toBe("link-header");
    });

    it("matches AWS by name", () => {
      const result = engine.matchKnownPattern("aws");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("aws");
      expect(result?.auth.type).toBe("signature-v4");
    });

    it("matches case-insensitively", () => {
      const result = engine.matchKnownPattern("STRIPE");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("stripe");
    });

    it("matches with partial name", () => {
      const result = engine.matchKnownPattern("stripe-api");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("stripe");
    });

    it("returns null for unknown API", () => {
      const result = engine.matchKnownPattern("unknown-api-xyz");

      expect(result).toBeNull();
    });

    it("matches Twilio pattern", () => {
      const result = engine.matchKnownPattern("twilio");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("twilio");
    });
  });

  describe("analyzeEndpoints", () => {
    it("infers pagination from endpoint parameters", () => {
      const endpoints = [
        {
          path: "/users",
          method: "GET",
          parameters: [
            { name: "limit", in: "query" },
            { name: "starting_after", in: "query" },
          ],
        },
        {
          path: "/orders",
          method: "GET",
          parameters: [
            { name: "limit", in: "query" },
            { name: "ending_before", in: "query" },
          ],
        },
      ];

      const result = engine.analyzeEndpoints(endpoints);

      expect(result.pagination.style).toBe("cursor");
    });

    it("infers auth from security definitions", () => {
      const endpoints = [
        {
          path: "/users",
          method: "GET",
          security: [{ bearerAuth: [] }],
        },
      ];

      const result = engine.analyzeEndpoints(endpoints);

      expect(result.auth.type).toBe("bearer");
    });

    it("infers API key auth from header parameter", () => {
      const endpoints = [
        {
          path: "/users",
          method: "GET",
          parameters: [{ name: "X-API-Key", in: "header", required: true }],
        },
      ];

      const result = engine.analyzeEndpoints(endpoints);

      expect(result.auth.type).toBe("api-key");
      expect(result.auth.header).toBe("X-API-Key");
    });

    it("returns default pattern for empty endpoints", () => {
      const result = engine.analyzeEndpoints([]);

      expect(result.pagination.style).toBe("none");
      expect(result.auth.type).toBe("none");
    });
  });

  describe("KNOWN_PATTERNS", () => {
    it("contains Stripe pattern with correct structure", () => {
      const stripe = KNOWN_PATTERNS.stripe;

      expect(stripe).toBeDefined();
      expect(stripe.name).toBe("stripe");
      expect(stripe.pagination.style).toBe("cursor");
      expect(stripe.pagination.params).toContain("starting_after");
      expect(stripe.errorFormat.style).toBe("stripe");
      expect(stripe.idempotency?.header).toBe("Idempotency-Key");
    });

    it("contains GitHub pattern with correct structure", () => {
      const github = KNOWN_PATTERNS.github;

      expect(github).toBeDefined();
      expect(github.name).toBe("github");
      expect(github.pagination.style).toBe("link-header");
      expect(github.rateLimiting.hasRateLimiting).toBe(true);
    });

    it("contains AWS pattern with correct structure", () => {
      const aws = KNOWN_PATTERNS.aws;

      expect(aws).toBeDefined();
      expect(aws.name).toBe("aws");
      expect(aws.auth.type).toBe("signature-v4");
      expect(aws.pagination.style).toBe("cursor");
      expect(aws.pagination.params).toContain("NextToken");
    });
  });
});
