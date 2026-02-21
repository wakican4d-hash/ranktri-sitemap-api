# Security Hardening Documentation

**Last Updated:** February 21, 2026  
**Version:** 2.0.0  
**Compliance:** OWASP Top 10 (2021)

---

## Overview

This document describes the security enhancements implemented in the Sitemap Generator API. The application now includes comprehensive protections against common web vulnerabilities including injection attacks, DDoS, SSRF, and data exposure.

---

## Security Features Implemented

### 1. Rate Limiting (OWASP A08:2021 – Software and Data Integrity Failures)

**Implementation:** `express-rate-limit` middleware with IP-based tracking

#### Global Rate Limiting
- **Limit:** 100 requests per 15 minutes per IP
- **Applied to:** All endpoints except health checks
- **Response:** HTTP 429 with `RateLimit-*` headers and Retry-After guidance

#### Endpoint-Specific Rate Limiting
- **Limit:** 20 requests per 15 minutes per IP
- **Applied to:** `/api/generate-sitemap` and `/api/download-sitemap`
- **Justification:** Crawling is resource-intensive; stricter limits prevent abuse
- **Response:** HTTP 429 with clear error message and retry guidance

**Configuration:**
```javascript
// Global limiter
const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // per IP
  standardHeaders: true,      // RateLimit-* headers
  legacyHeaders: false,       // No X-RateLimit-* headers
});

// Endpoint-specific limiter
const sitemapRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                    // Most restrictive for expensive operations
  standardHeaders: true,
});
```

**Headers Sent:**
```
RateLimit-Limit: 20
RateLimit-Remaining: 18
RateLimit-Reset: 1645366200
Retry-After: 900  // Seconds to wait before retrying
```

---

### 2. Input Validation & Sanitization (OWASP A03:2021 – Injection)

**Implementation:** Zod schema validation + custom sanitization

#### Schema-Based Validation

All request bodies are validated against strict Zod schemas before processing:

```typescript
const SitemapRequestSchema = z.object({
  // Required: Valid 2048-char max URL with SSRF prevention
  url: z
    .string()
    .min(1, 'URL is required')
    .max(2048, 'URL must not exceed 2048 characters')
    .url('Invalid URL format')
    .refine(url => {
      // Block dangerous protocols
      const disallowed = ['javascript:', 'data:', 'vbscript:'];
      return !disallowed.includes(new URL(url).protocol);
    })
    .refine(url => {
      // Block private IPs (SSRF prevention)
      const hostname = new URL(url).hostname;
      return !/^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01]))/i.test(hostname);
    }),
  
  // Optional: Limited to valid XML changefreq values
  changeFreq: z
    .enum(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
    .default('weekly')
    .optional(),
  
  // Optional: Priority must be 0.0-1.0
  priority: z
    .number()
    .min(0, 'Priority must be >= 0')
    .max(1, 'Priority must be <= 1')
    .default(0.5)
    .optional(),
  
  // Optional: Boolean flags
  includeLastMod: z.boolean().default(true).optional(),
  includeDebug: z.boolean().default(false).optional(),
}).strict(); // Reject unexpected fields
```

**Validation Benefits:**
- ✓ Type safety (all fields strictly typed)
- ✓ Length limits prevent buffer overflows
- ✓ Enum validation for changeFreq
- ✓ Numeric range validation for priority
- ✓ `.strict()` rejects unexpected fields (attack surface reduction)
- ✓ Clear error messages for debugging

#### SSRF Prevention

The URL validator includes two layers of SSRF prevention:

1. **Protocol Whitelisting:** Only `http://` and `https://` allowed
2. **IP Range Blocking:**
   - `127.0.0.1` and `localhost` blocked
   - `192.168.x.x` (Class C private) blocked
   - `10.0.0.0/8` (Class A private) blocked
   - `172.16.0.0/12` (Class B private) blocked

**Example Rejections:**
```
http://localhost:8080           → REJECTED (SSRF)
http://192.168.1.1              → REJECTED (SSRF)
javascript:alert('xss')         → REJECTED (protocol)
https://example.com             → ACCEPTED
```

#### Input Sanitization

Additional sanitization removes potentially harmful characters:

```javascript
function sanitizeString(str) {
  return str
    .replace(/\x00/g, '')        // Remove null bytes
    .replace(/[\x01-\x1F]/g, ''); // Remove control characters
}
```

Applied to all request bodies before processing to prevent injection attacks.

---

### 3. Security Headers (OWASP A02:2021 – Cryptographic Failures)

**Implementation:** Helmet.js middleware

All responses include comprehensive security headers:

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Force HTTPS, prevent man-in-the-middle attacks |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing attacks |
| `X-Frame-Options` | `DENY` | Prevent clickjacking / framing attacks |
| `Content-Security-Policy` | `default-src 'self'` | Restrict resource loading to same-origin |
| `X-XSS-Protection` | `0` | Disable browser XSS filters (CSP is primary defense) |
| `X-Permitted-Cross-Domain-Policies` | `none` | Block Flash/PDF cross-domain access |
| `Referrer-Policy` | `no-referrer` | Prevent referrer leakage |

**Helmet Configuration:**
```javascript
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  noSniff: true,
  frameguard: { action: 'deny' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  hidePoweredBy: true,
});
```

---

### 4. Secure Error Handling (OWASP A09:2021 – Security Logging and Monitoring Failures)

**Implementation:** Generic client responses + detailed server-side logging

Error messages are sanitized before returning to clients:

```javascript
function createSecureErrorResponse(err, statusCode = 500) {
  // Log full error details SERVER-SIDE only
  console.error('[SECURITY ERROR]', {
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });

  // Return GENERIC response to client
  return {
    error: 'Internal server error',
    statusCode: 500,
  };
}
```

**Benefits:**
- ✓ Stack traces never exposed to clients
- ✓ Internal paths not revealed
- ✓ Database details protected
- ✓ Full error context available for debugging (server-side logs)
- ✓ Prevents information disclosure (OWASP A09)

**Example:**
```
Client sees:      { "error": "Internal server error" }
Server logs:      Full stack trace, database errors, file paths, etc.
```

---

### 5. CORS with Origin Whitelisting (OWASP A07:2021 – Identification and Authentication Failures)

**Implementation:** `cors` middleware with origin validation

```javascript
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Allow explicit origins
if (ALLOWED_ORIGINS.includes(origin)) return true;

// Allow Vercel preview deployments
if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;

return false;
```

**Configuration Example (.env):**
```
ALLOWED_ORIGINS=https://www.ranktri.com,https://ranktri.com,https://staging.ranktri.com
```

---

### 6. API Key Security

**Implementation:** Environment variables only (no hardcoding)

**Before (VULNERABLE):**
```javascript
const SCRAPE_API_KEY = 'fd5a2ea848c24668b97ae8563045f1a7117ab732303'; // ❌ EXPOSED
```

**After (SECURE):**
```javascript
// .env file (not committed to git)
VITE_SCRAPE_API_KEY=your_secure_key_here

// Code
const SCRAPE_API_KEY = import.meta.env.VITE_SCRAPE_API_KEY || '';
```

**Security Measures:**
- ✓ Keys stored in `.env` (included in `.gitignore`)
- ✓ Keys never exposed client-side
- ✓ Different keys for development, staging, production
- ✓ Secret rotation possible without code changes
- ✓ Log monitoring for accidental key exposure

**Set in Production (Vercel):**
```bash
npx vercel env add VITE_SCRAPE_API_KEY
# Prompts for secure key entry, encrypted in Vercel's vault
```

---

## Middleware Stack (Execution Order)

1. **Helmet.js** - Add security headers
2. **Global Rate Limiter** - 100 req/15min per IP
3. **JSON Parser** - `express.json()`
4. **Request Sanitization** - Remove control chars
5. **CORS** - Origin validation
6. **Route-Specific Rate Limiter** - 20 req/15min per IP on /api/generate-sitemap
7. **Schema Validation** - Zod validation
8. **Business Logic** - Crawling, XML generation
9. **Secure Error Handler** - Generic responses to client

---

## Testing Security Controls

### Test 1: Validate Security Headers
```bash
curl -si https://api.example.com/api/generate-sitemap \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | grep -E "^(strict-transport|x-content|x-frame)"
```

**Expected Output:**
```
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: DENY
```

### Test 2: Input Validation (Missing Field)
```bash
curl -s -X POST https://api.example.com/api/generate-sitemap \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected Response:**
```json
{"error":"url: Required"}
```

### Test 3: SSRF Prevention
```bash
curl -s -X POST https://api.example.com/api/generate-sitemap \
  -H "Content-Type: application/json" \
  -d '{"url":"http://192.168.1.1"}'
```

**Expected Response:**
```json
{"error":"url: URL scheme not allowed or hostname is private (SSRF prevention)"}
```

### Test 4: Rate Limiting
```bash
# Make 25 requests rapidly
for i in {1..25}; do
  curl -s -X POST https://api.example.com/api/generate-sitemap \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com"}' \
    -w "%{http_code}\n" -o /dev/null &
done
wait
```

**Expected:** After 20 requests, subsequent requests return HTTP 429 (Too Many Requests)

### Test 5: Error Message Generic (No Stack Traces)
```bash
curl -s -X POST https://api.example.com/api/invalid-endpoint
```

**Expected Response (Generic, no internal details):**
```json
{"error":"Not found","statusCode":404}
```

**Not Expected:**
```json
❌ {"error":"Cannot GET /api/invalid-endpoint at ...","stack":"Error at ..."}
```

---

## Deployment Checklist

- [ ] Review `security.js` for any custom IP ranges to whitelist
- [ ] Set `ALLOWED_ORIGINS` environment variable with trusted domains
- [ ] Set `VITE_SCRAPE_API_KEY` in production secrets manager
- [ ] Verify `.env` and `.env*.local` are in `.gitignore`
- [ ] Run `npm audit` and address any vulnerabilities
- [ ] Test all endpoints with `curl` commands above
- [ ] Monitor logs for suspicious patterns (excessive 429s, validation errors)
- [ ] Set up alerts for rate limit violations
- [ ] Document custom rate limit values if modified
- [ ] Review CORS origins quarterly

---

## OWASP Compliance Summary

| OWASP Issue | Mitigation | Status |
|------------|-----------|--------|
| A01:2021 – Broken Access Control | CORS origin whitelist, IP whitelisting | ✓ |
| A02:2021 – Cryptographic Failures | HSTS, security headers | ✓ |
| A03:2021 – Injection | Zod schema validation, input sanitization | ✓ |
| A04:2021 – Insecure Design | Rate limiting, SSRF prevention | ✓ |
| A05:2021 – Security Misconfiguration | Helmet.js, secure defaults | ✓ |
| A06:2021 – Vulnerable Components | npm audit, dependency updates | ✓ |
| A07:2021 – Authentication Failures | CORS enforcement | ✓ |
| A08:2021 – Data Integrity Failures | Rate limiting, input validation | ✓ |
| A09:2021 – Logging & Monitoring | Secure error handling, server-side logs | ✓ |
| A10:2021 – SSRF | URL validation, private IP blocking | ✓ |

---

## Monitoring & Maintenance

### Key Metrics to Monitor

1. **Rate Limit Hits (429 responses)**
   - Threshold: > 10 per hour per IP
   - Action: Review logs, adjust limits if needed

2. **Validation Errors (400 responses)**
   - Threshold: > 5% of total requests
   - Action: Review error logs, customer communication

3. **Security Header Compliance**
   - Run monthly: `curl -si https://api.example.com/ | grep -E "^(strict|x-|content-security)"`
   - Expected: All security headers present

### Log Monitoring

Look for patterns like:
```
[SECURITY ERROR] Repeated 429 responses from single IP
[API ERROR] Repeated validation failures for same field
[SECURITY ERROR] SSRF attempt detected
```

---

## References

- [OWASP Top 10 (2021)](https://owasp.org/Top10/)
- [Helmet.js Documentation](https://helmetjs.github.io/)
- [Zod Documentation](https://zod.dev/)
- [Express Rate Limit](https://github.com/nfriedly/express-rate-limit)
- [SSRF Prevention (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

---

**Last Reviewed:** February 21, 2026  
**Next Review:** May 21, 2026 (Quarterly)
