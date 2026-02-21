import type { SitemapRequest, SitemapResponse } from '../types/sitemap.types';

const DEFAULT_TIMEOUT_MS = 10_000;

// In Vite, you can set this in .env as VITE_API_BASE_URL=http://localhost:3000
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '';

export class ApiError extends Error {
  public readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSitemapResponse(value: unknown): value is SitemapResponse {
  if (!isObject(value)) return false;

  const stats = value.stats;
  if (!isObject(stats)) return false;

  return (
    typeof value.sitemapXML === 'string' &&
    typeof stats.urlsDiscovered === 'number' &&
    typeof stats.urlsInSitemap === 'number' &&
    typeof stats.crawlTimeSeconds === 'number'
  );
}

async function fetchWithTimeout<TResponse>(
  path: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    let responseBody: unknown;

    // Parse JSON safely to improve error handling for invalid payloads.
    try {
      responseBody = await response.json();
    } catch {
      throw new ApiError('Invalid response format from server', response.status);
    }

    if (!response.ok) {
      const serverMessage =
        isObject(responseBody) && typeof responseBody.error === 'string'
          ? responseBody.error
          : `Request failed with status ${response.status}`;

      throw new ApiError(serverMessage, response.status);
    }

    return responseBody as TResponse;
  } catch (error: unknown) {
    // Timeout errors from AbortController
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('Request timed out. Please try again.', 408);
    }

    // Already a normalized API error
    if (error instanceof ApiError) {
      throw error;
    }

    // Browser/network level error
    throw new ApiError('Network error. Please check your connection and try again.');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function generateSitemapRequest(payload: SitemapRequest): Promise<SitemapResponse> {
  const data = await fetchWithTimeout<unknown>(
    '/api/generate-sitemap',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    DEFAULT_TIMEOUT_MS,
  );

  if (!isSitemapResponse(data)) {
    throw new ApiError('Server returned an invalid sitemap response');
  }

  return data;
}
