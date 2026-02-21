import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, generateSitemapRequest } from '../services/sitemap.service';
import type { SitemapRequest, SitemapResponse } from '../types/sitemap.types';

const PROGRESS_MESSAGES = [
  'Crawling website',
  'Discovering URLs',
  'Generating XML',
  'Finalizing sitemap',
] as const;

interface UseSitemapGeneratorResult {
  generateSitemap: (request: SitemapRequest) => Promise<void>;
  loading: boolean;
  error: string | null;
  data: SitemapResponse | null;
  progressText: string;
}

export function useSitemapGenerator(): UseSitemapGeneratorResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SitemapResponse | null>(null);
  const [progressText, setProgressText] = useState(PROGRESS_MESSAGES[0]);

  const progressIndexRef = useRef(0);

  // Rotate loading message every 2 seconds while loading is true.
  useEffect(() => {
    if (!loading) {
      progressIndexRef.current = 0;
      setProgressText(PROGRESS_MESSAGES[0]);
      return;
    }

    const intervalId = window.setInterval(() => {
      progressIndexRef.current = (progressIndexRef.current + 1) % PROGRESS_MESSAGES.length;
      setProgressText(PROGRESS_MESSAGES[progressIndexRef.current]);
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [loading]);

  const generateSitemap = useCallback(async (request: SitemapRequest) => {
    setLoading(true);
    setError(null);

    try {
      const response = await generateSitemapRequest(request);
      setData(response);
    } catch (err: unknown) {
      setData(null);

      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Something went wrong while generating sitemap.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    generateSitemap,
    loading,
    error,
    data,
    progressText,
  };
}
