export interface CrawlStats {
  urlsDiscovered: number;
  urlsInSitemap: number;
  crawlTimeSeconds: number;
}

export interface SitemapRequest {
  url: string;
  changeFreq: string;
  priority: number;
  includeLastMod: boolean;
}

export interface SitemapResponse {
  sitemapXML: string;
  stats: CrawlStats;
}
