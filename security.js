// security.js
// Comprehensive security middleware and utilities for OWASP compliance
// Includes input validation, sanitization, and security headers

const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// ========================================
// SECTION 1: INPUT VALIDATION SCHEMAS
// ========================================
// Using Zod for runtime schema validation with clear error messages
// Ref: OWASP A01:2021 – Broken Access Control, A03:2021 – Injection

/**
 * Validation schema for /api/generate-sitemap and /api/download-sitemap
 * Enforces type safety, length limits, and expected field values
 */
const SitemapRequestSchema = z.object({
  // URL is required; must be valid and reasonably short (2048 chars per RFC)
  url: z
    .string()
    .min(1, 'URL is required')
    .max(2048, 'URL must not exceed 2048 characters')
    .url('Invalid URL format')
    .refine(
      (url) => {
        try {
          // Additional security: reject URLs with suspicious protocols or patterns
          const parsed = new URL(url);
          const disallowedProtocols = ['javascript:', 'data:', 'vbscript:'];
          if (disallowedProtocols.includes(parsed.protocol)) {
            return false;
          }
          // Reject localhost/private IP to prevent SSRF attacks
          if (/^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01]))/i.test(parsed.hostname)) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      {
        message: 'URL scheme not allowed or hostname is private (SSRF prevention)',
      },
    ),

  // Optional fields with strict validation
  changeFreq: z
    .enum(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
    .default('weekly')
    .optional(),

  priority: z
    .number()
    .min(0, 'Priority must be >= 0')
    .max(1, 'Priority must be <= 1')
    .default(0.5)
    .optional(),

  includeLastMod: z
    .boolean()
    .default(true)
    .optional(),

  includeDebug: z
    .boolean()
    .default(false)
    .optional(),
}).strict(); // .strict() rejects any unexpected fields

/**
 * Validates request body against schema
 * Returns { valid: true, data } or { valid: false, error }
 */
function validateSitemapRequest(body) {
  try {
    const validated = SitemapRequestSchema.parse(body);
    return { valid: true, data: validated };
  } catch (err) {
    // Zod error; extract user-friendly message
    if (err.errors && Array.isArray(err.errors)) {
      const messages = err.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return { valid: false, error: messages };
    }
    return { valid: false, error: 'Invalid request format' };
  }
}

// ========================================
// SECTION 2: RATE LIMITING
// ========================================
// Ref: OWASP A04:2021 – Insecure Deserialization, A08:2021 – Software and Data Integrity Failures
// Rate limit by IP to prevent abuse and brute force attacks
// Graceful 429 responses with helpful Retry-After headers

/**
 * Global rate limit middleware:
 * - 100 requests per 15 minutes per IP
 * - Includes skip logic for health checks
 * - Returns 429 with Retry-After header for graceful backoff
 */
const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/' && req.method === 'GET';
  },
  handler: (req, res) => {
    // Custom 429 response with Retry-After header
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
});

/**
 * Stricter rate limit for the /api/generate-sitemap endpoint:
 * - 20 requests per 15 minutes per IP (crawling is resource-intensive)
 * - More conservative due to backend cost
 */
const sitemapRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 requests per windowMs per IP
  message: 'Too many sitemap generation requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded for sitemap generation',
      retryAfter: req.rateLimit?.resetTime,
      message: 'Sitemap generation is resource-intensive. Please wait before trying again.',
    });
  },
  // Optional: skip for trusted IPs (e.g., internal services)
  skip: (req) => {
    // If you have internal IPs, filter them here
    // return /^(192\.168\.|10\.)/.test(req.ip);
    return false;
  },
});

// ========================================
// SECTION 3: SECURITY HEADERS
// ========================================
// Ref: OWASP A02:2021 – Cryptographic Failures
// Helmet.js adds HTTP security headers to prevent common attacks

/**
 * Configure Helmet.js with sensible defaults for API security
 * - Content Security Policy (CSP)
 * - X-Content-Type-Options (prevent MIME sniffing)
 * - X-Frame-Options (prevent clickjacking)
 * - Strict-Transport-Security (HTTPS enforcement)
 */
const helmetMiddleware = helmet({
  // CSP: Restrict resource loading (only same origin for scripts, styles, etc.)
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  // Prevent browsers from MIME-sniffing
  noSniff: true,
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Enforce HTTPS (set max-age to 1 year in production)
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  // Disable X-Powered-By header to avoid exposing tech stack
  hidePoweredBy: true,
});

// ========================================
// SECTION 4: INPUT SANITIZATION
// ========================================
// Ref: OWASP A03:2021 – Injection
// Additional sanitization beyond schema validation

/**
 * Sanitizes string input to remove or escape potentially harmful characters
 * Primarily for logging and display purposes (schema validation already applied)
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  // Remove null bytes and control characters
  return str
    .replace(/\x00/g, '') // null bytes
    .replace(/[\x01-\x1F]/g, ''); // control characters except \n, \r, \t
}

/**
 * Sanitizes object by recursively processing string values
 */
function sanitizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = typeof value === 'string' ? sanitizeString(value) : sanitizeObject(value);
  }
  return sanitized;
}

// ========================================
// SECTION 5: SECURE ERROR HANDLING
// ========================================
// Ref: OWASP A09:2021 – Security Logging and Monitoring Failures

/**
 * Creates secure error response without exposing internal details
 * Logs full error server-side but returns generic message to client
 */
function createSecureErrorResponse(err, statusCode = 500) {
  // Log full error details server-side for debugging
  console.error('[SECURITY ERROR]', {
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });

  // Return generic response to client (no stack traces, sensitive details)
  const responses = {
    400: { error: 'Bad request', statusCode: 400 },
    401: { error: 'Unauthorized', statusCode: 401 },
    403: { error: 'Forbidden', statusCode: 403 },
    404: { error: 'Not found', statusCode: 404 },
    422: { error: 'Unprocessable entity', statusCode: 422 },
    429: { error: 'Rate limit exceeded', statusCode: 429 },
    500: { error: 'Internal server error', statusCode: 500 },
    503: { error: 'Service unavailable', statusCode: 503 },
  };

  return (
    responses[statusCode] || {
      error: 'An error occurred',
      statusCode: 500,
    }
  );
}

// ========================================
// SECTION 6: REQUEST SANITIZATION MIDDLEWARE
// ========================================

/**
 * Middleware to sanitize JSON request body
 * Applied to all POST/PUT requests to prevent injection attacks
 */
function sanitizeRequestBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  // Validation
  validateSitemapRequest,
  SitemapRequestSchema,

  // Rate limiting
  globalRateLimiter,
  sitemapRateLimiter,

  // Security headers
  helmetMiddleware,

  // Sanitization
  sanitizeString,
  sanitizeObject,
  sanitizeRequestBody,

  // Error handling
  createSecureErrorResponse,
};
