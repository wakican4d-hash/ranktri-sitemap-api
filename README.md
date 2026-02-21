# Sitemap Generator API

This is a beginner-friendly Node.js + Express API that crawls a website (internal links only) and returns a Sitemap XML plus crawl statistics.

Files:
- `server.js` — main server and implementation

Quick start

1. Install dependencies

```bash
npm install
```

2. Run the server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

API

POST /api/generate-sitemap

Request body (JSON):

```json
{
  "url": "https://example.com",
  "changeFreq": "weekly",
  "priority": 0.8,
  "includeLastMod": true
}
```

Success response (JSON):

```json
{
  "sitemapXML": "...xml string...",
  "stats": {
    "urlsDiscovered": 10,
    "urlsInSitemap": 8,
    "crawlTimeSeconds": 2.34
  }
}
```

Example curl

```bash
curl -X POST http://localhost:3000/api/generate-sitemap \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","changeFreq":"weekly","priority":0.8,"includeLastMod":true}'
```

Notes & limits
- Crawls internal links only (same hostname)
- Max 50 pages
- 5 second timeout per request
- Avoids duplicate URLs
- No database required — results are returned in the response

If you'd like, I can add a small test script or run the server locally and show an example response.
