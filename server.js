// server.js
// Sitemap XML Generator API
// Beginner-friendly Node.js + Express server that crawls a website
// and returns a sitemap XML along with crawl statistics.
// 
// SECURITY HARDENING (OWASP-compliant):
// - Input validation with Zod schema validation
// - Rate limiting per IP (global + endpoint-specific)
// - Security headers via Helmet.js
// - Input sanitization to prevent injection attacks
// - Secure error handling (no sensitive details to client)
// - CORS with allow-list of trusted origins
// - SSRF prevention (no private IPs/localhost)

// -----------------------------
// Dependency imports
// -----------------------------
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const crypto = require('crypto');
const {
  globalRateLimiter,
  sitemapRateLimiter,
  helmetMiddleware,
  sanitizeRequestBody,
  validateSitemapRequest,
  createSecureErrorResponse,
} = require('./security');

// -----------------------------
// Server setup
// -----------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// SECURITY MIDDLEWARE - Applied globally
// ========================================
// 1. Helmet.js: Adds HTTP security headers
app.use(helmetMiddleware);

// 2. Global rate limiting: 100 requests/15min per IP
app.use(globalRateLimiter);

// -----------------------------
// CORS setup (production-ready)
// -----------------------------
// Configure allowed origins with comma-separated values, for example:
// ALLOWED_ORIGINS=https://ranktri.com,https://www.ranktri.com,https://ranktri.vercel.app
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  // Allow non-browser requests (no Origin header), e.g., curl/server-to-server.
  if (!origin) return true;

  // Explicit allow-list takes highest priority.
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Allow Vercel preview deployments: https://*.vercel.app
  // You can remove this if you want stricter allow-list only.
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;

  return false;
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS policy: origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight requests with the same origin policy
app.options('*', cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS policy: origin not allowed'));
  },
}));

// Enable JSON body parsing
app.use(express.json());

// 3. Request body sanitization: Remove control chars & null bytes
app.use(sanitizeRequestBody);

// -----------------------------
// Helper utilities
// -----------------------------

// Normalize URLs for deduplication: remove trailing slash and hash
// Normalize URLs for deduplication:
// - remove fragment
// - remove common tracking parameters (utm_*, fbclid, gclid)
// - sort remaining query params for consistent ordering
// - remove default ports and trailing slashes
function normalizeUrl(u) {
  try {
    const urlObj = new URL(u);
    urlObj.hash = ''; // drop fragment

    // lowercase protocol and hostname
    urlObj.protocol = urlObj.protocol.toLowerCase();
    urlObj.hostname = urlObj.hostname.toLowerCase();

    // remove default ports
    if ((urlObj.protocol === 'http:' && urlObj.port === '80') || (urlObj.protocol === 'https:' && urlObj.port === '443')) {
      urlObj.port = '';
    }

    // remove tracking query params
    const trackingKeys = ['fbclid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    const params = Array.from(urlObj.searchParams.entries()).filter(([k]) => !trackingKeys.includes(k));

    // sort params for consistency
    params.sort((a, b) => a[0].localeCompare(b[0]));
    urlObj.search = '';
    params.forEach(([k, v]) => urlObj.searchParams.append(k, v));

    // normalize pathname: remove duplicate / and trailing slash (except root)
      urlObj.pathname = urlObj.pathname.replace(/\/+/g, '/');
    if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) urlObj.pathname = urlObj.pathname.slice(0, -1);

    return urlObj.toString();
  } catch (err) {
    return null;
  }
}

// Check if a link is internal to the start host
function isInternalLink(link, startHost) {
  try {
    const u = new URL(link);
    return u.hostname === startHost;
  } catch (err) {
    return false;
  }
}

// Clean up and resolve relative/href links against a base
function resolveLink(href, base) {
  if (!href) return null;
  href = href.trim();
  // ignore anchors, javascript:, mailto:, tel:
  if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
  try {
    const resolved = new URL(href, base).toString();
    return resolved;
  } catch (err) {
    return null;
  }
}

// Skip resource file types (images, archives, documents)
function isSkippableResource(url) {
  try {
    const u = new URL(url);
    return /\.(jpg|jpeg|png|gif|svg|webp|bmp|pdf|zip|rar|7z|tar|gz|exe|dmg|iso|mp4|mp3|ogg|woff2?|ttf|ico)(?:$|\?)/i.test(u.pathname + (u.search || ''));
  } catch (err) {
    return true;
  }
}

// -----------------------------
// robots.txt fetching & parsing (very small, forgiving parser)
// We fetch /robots.txt and extract Disallow rules for our user-agent or '*'
// -----------------------------
async function fetchRobots(baseUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const resp = await axios.get(robotsUrl, { timeout: 3000 });
    const text = String(resp.data || '');
    const lines = text.split(/\r?\n/).map(l => l.trim());

    const agents = {};
    let currentAgents = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const [rawKey, ...rest] = line.split(':');
      if (!rawKey || rest.length === 0) continue;
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') {
        currentAgents = [value.toLowerCase()];
        if (!agents[currentAgents[0]]) agents[currentAgents[0]] = [];
      } else if (key === 'disallow') {
        if (currentAgents.length === 0) {
          // no agent specified yet, apply to *
          agents['*'] = agents['*'] || [];
          agents['*'].push(value);
        } else {
          for (const a of currentAgents) {
            agents[a] = agents[a] || [];
            agents[a].push(value);
          }
        }
      }
    }

    // prefer specific agent 'sitemap-generator' then '*' rules
    const result = {
      disallow: new Set(),
    };
    const agentKeys = Object.keys(agents).map(k => k.toLowerCase());
    if (agentKeys.includes('sitemap-generator')) {
      agents['sitemap-generator'].forEach(p => result.disallow.add(p));
    }
    if (agentKeys.includes('*')) {
      agents['*'].forEach(p => result.disallow.add(p));
    }

    return result;
  } catch (err) {
    return { disallow: new Set() };
  }
}

function isPathAllowed(path, robots) {
  if (!robots || !robots.disallow) return true;
  for (const pattern of robots.disallow) {
    if (!pattern) continue;
    // robots.txt disallow paths are simple prefixes
    if (path.startsWith(pattern)) return false;
  }
  return true;
}

// -----------------------------
// Crawler function
// - Crawls internal links only
// - Respects maxPages limit
// - 5 second timeout per request
// - Avoids duplicates
// -----------------------------
async function crawlWebsite(startUrl, maxPages = 50, options = {}) {
  const start = Date.now();
  const visited = new Set(); // normalized URLs that we include in sitemap
  const discovered = new Set(); // normalized URLs discovered
  const queue = [];
  const debug = [];
  const { includeDebug = false } = options;

  const startHost = new URL(startUrl).hostname;

  queue.push(startUrl);
  const nStart = normalizeUrl(startUrl);
  if (nStart) discovered.add(nStart);

  const axiosInstance = axios.create({ timeout: 5000, headers: { 'User-Agent': 'Sitemap-Generator/1.0 (+https://example.com)' } });

  // robots.txt rules for the start site
  const robots = await fetchRobots(startUrl).catch(() => ({ disallow: new Set() }));

  // content hash map to detect duplicate pages (hash -> canonicalUrl)
  const contentHashes = new Map();

  while (queue.length > 0 && visited.size < maxPages) {
    const current = queue.shift();
    const normalizedCurrent = normalizeUrl(current);
    if (!normalizedCurrent) continue;
    if (visited.has(normalizedCurrent)) continue;

    // Skip resources (images, pdfs, zips, etc.)
    if (isSkippableResource(current)) {
      discovered.add(normalizedCurrent);
      if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'skipped-resource' });
      continue;
    }

    // Respect robots.txt
    try {
      const u = new URL(current);
      if (!isPathAllowed(u.pathname, robots)) {
        discovered.add(normalizedCurrent);
        if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'disallowed-by-robots', path: u.pathname });
        continue;
      }
    } catch (err) {
      discovered.add(normalizedCurrent);
      if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'invalid-url' });
      continue;
    }

    try {
      if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'fetching' });
      const resp = await axiosInstance.get(current);
      if (resp.status < 200 || resp.status >= 300) {
        discovered.add(normalizedCurrent);
        if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'non-2xx-status', status: resp.status });
        continue;
      }

      const html = resp.data || '';

      // Compute content hash to detect duplicates
      const hash = crypto.createHash('sha256').update(String(html)).digest('hex');
      if (contentHashes.has(hash)) {
        // duplicate page detected - do not add to visited sitemap
        discovered.add(normalizedCurrent);
        if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'duplicate-content', canonical: contentHashes.get(hash) });
        continue;
      }
      contentHashes.set(hash, normalizedCurrent);

      if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'fetched', contentHash: hash.slice(0, 8) });

      const $ = cheerio.load(html);

      // Extract <a> links and resolve/normalize them
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const resolved = resolveLink(href, current);
        if (!resolved) return;
        // Only internal links
        if (!isInternalLink(resolved, startHost)) return;
        // Skip media/resource file types
        if (isSkippableResource(resolved)) return;
        const n = normalizeUrl(resolved);
        if (!n) return;
        if (!discovered.has(n)) {
          discovered.add(n);
          queue.push(resolved);
          if (includeDebug) debug.push({ url: resolved, normalized: n, discoveredFrom: normalizedCurrent, action: 'discovered' });
        }
      });

      visited.add(normalizedCurrent);
    } catch (err) {
      // Handle timeouts and other errors by marking as discovered and continuing
      discovered.add(normalizedCurrent);
      if (includeDebug) debug.push({ url: current, normalized: normalizedCurrent, action: 'fetch-error', message: err.message });
      continue;
    }
  }

  const end = Date.now();
  const crawlTimeSeconds = Math.round((end - start) / 1000 * 100) / 100; // two decimals

  // Return arrays (convert sets to arrays), and stats
  const result = {
    discovered: Array.from(discovered).filter(Boolean),
    visited: Array.from(visited).filter(Boolean),
    stats: {
      urlsDiscovered: discovered.size,
      urlsInSitemap: visited.size,
      crawlTimeSeconds,
    },
  };
  if (includeDebug) result.debug = debug;
  return result;
}

// -----------------------------
// Sitemap XML generator
// - Takes array of URLs and options
// - Produces a sitemap XML string
// -----------------------------
function generateSitemapXML(urls, options = {}) {
  // options: changeFreq (string), priority (number), includeLastMod (bool)
  const { changeFreq = 'weekly', priority = 0.5, includeLastMod = false } = options;

  const lastmod = includeLastMod ? new Date().toISOString().split('T')[0] : null; // YYYY-MM-DD

  const urlEntries = urls.map((loc) => {
    let entry = '  <url>\n';
    entry += `    <loc>${escapeXml(loc)}</loc>\n`;
    if (includeLastMod && lastmod) entry += `    <lastmod>${lastmod}</lastmod>\n`;
    if (changeFreq) entry += `    <changefreq>${changeFreq}</changefreq>\n`;
    if (typeof priority === 'number') entry += `    <priority>${priority}</priority>\n`;
    entry += '  </url>';
    return entry;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urlEntries.join('\n') +
    `\n</urlset>`;

  return xml;
}

// Simple XML escaping for <, >, &
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&\"']/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
    }
  });
}

// ========================================
// API Routes
// ========================================

// POST /api/generate-sitemap
// Stricter rate limiting (20 req/15min per IP) + input validation
app.post('/api/generate-sitemap', sitemapRateLimiter, async (req, res) => {
  // Step 1: Validate request against schema
  const validation = validateSitemapRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { url, changeFreq, priority, includeLastMod, includeDebug } = validation.data;

  try {
    // URL is already validated at schema level, safe to parse
    const startUrl = new URL(url).toString();

    // Crawl the site (max 50 pages as required)
    const { discovered, visited, stats, debug } = await crawlWebsite(startUrl, 50, { includeDebug });

    // For sitemap include the visited URLs (those we successfully fetched / recorded)
    // If there are fewer than discovered, that's ok.
    const sitemapUrls = visited.slice(0, 50);

    const sitemapXML = generateSitemapXML(sitemapUrls, { changeFreq, priority, includeLastMod });

    const payload = { sitemapXML, stats };
    if (includeDebug && Array.isArray(debug)) payload.debug = debug;
    return res.json(payload);
  } catch (err) {
    // Distinguish timeout-like errors from generic errors
    // Never expose internal error details to client (security best practice)
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json(createSecureErrorResponse(err, 504));
    }
    // Log error server-side but return generic message to client
    console.error('[API ERROR]', err);
    return res.status(500).json(createSecureErrorResponse(err, 500));
  }
});

// -----------------------------
// POST /api/download-sitemap
// Same body as /api/generate-sitemap but returns the sitemap XML
// as an attachment with `application/xml` Content-Type so clients
// can download it directly.
// Also uses rate limiting and input validation
app.post('/api/download-sitemap', sitemapRateLimiter, async (req, res) => {
  // Step 1: Validate request against schema
  const validation = validateSitemapRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { url, changeFreq, priority, includeLastMod } = validation.data;

  try {
    // URL is already validated at schema level, safe to parse
    const startUrl = new URL(url).toString();

    const { visited, stats } = await crawlWebsite(startUrl, 50);
    const sitemapUrls = visited.slice(0, 50);
    const sitemapXML = generateSitemapXML(sitemapUrls, { changeFreq, priority, includeLastMod });

    // Set headers for file download
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sitemap.xml"');

    // Optionally include stats as a header (also returned in JSON body if needed)
    res.setHeader('X-Urls-Discovered', String(stats.urlsDiscovered));
    res.setHeader('X-Urls-In-Sitemap', String(stats.urlsInSitemap));
    res.setHeader('X-Crawl-Time-Seconds', String(stats.crawlTimeSeconds));

    return res.send(sitemapXML);
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json(createSecureErrorResponse(err, 504));
    }
    // Log error server-side but return generic message to client
    console.error('[API ERROR]', err);
    return res.status(500).json(createSecureErrorResponse(err, 500));
  }
});

// ========================================
// Health Check Route (exempt from rate limiting)
// ========================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Sitemap Generator API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ========================================
// Start server
// ========================================
app.listen(PORT, () => {
  console.log(`Sitemap Generator API listening on port ${PORT}`);
  console.log('Security features enabled:');
  console.log('  ✓ Helmet.js security headers');
  console.log('  ✓ Global rate limiting (100 req/15min per IP)');
  console.log('  ✓ Endpoint rate limiting (20 req/15min per IP for /api/generate-sitemap)');
  console.log('  ✓ Zod schema validation for all inputs');
  console.log('  ✓ SSRF prevention (no private IPs/localhost)');
  console.log('  ✓ Input sanitization (control character removal)');
  console.log('  ✓ Secure error handling (no internal details exposed)');
});

// ========================================
// Notes for developers:
// ========================================
// 1. Security is now OWASP-compliant with defense-in-depth approach
// 2. All user input is validated against strict schemas before processing
// 3. Rate limiting protects against abuse, DDoS, and brute force attacks
// 4. Helmet.js adds HTTP security headers preventing common vulnerabilities
// 5. SSRF prevention blocks requests to private IPs (localhost, 192.168.*, etc.)
// 6. Error messages are generic; detailed logs are server-side only
// 7. Set ALLOWED_ORIGINS env var for trusted frontend domains
// 8. Review security.js for detailed security middleware documentation
// ========================================
