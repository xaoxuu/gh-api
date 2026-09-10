const statusCodes: Record<number, string> = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN',
  404: 'UNSUPPORTED_ENDPOINT', 405: 'METHOD_NOT_ALLOWED', 422: 'UNPROCESSABLE_REQUEST',
  429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 503: 'SERVICE_UNAVAILABLE',
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
    public code = statusCodes[status] ?? 'INTERNAL_ERROR',
  ) { super(message); }
}

export function errorResponse(failure: HttpError, headers = new Headers(), details: Record<string, string> | null = null): Response {
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) headers.set(name, 'no-store');
  if (failure.retryAfter !== undefined) headers.set('Retry-After', String(failure.retryAfter));
  return new Response(JSON.stringify({
    success: false,
    code: failure.code,
    status: failure.status,
    message: failure.message,
    details,
    retryAfter: failure.retryAfter ?? null,
  }), { status: failure.status, headers });
}
