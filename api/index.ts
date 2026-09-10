import { RuntimeCache } from '../src/cache.js';
import { ConfigurationError, readConfig } from '../src/config.js';
import { createProxy } from '../src/proxy.js';
import { errorResponse, HttpError } from '../src/errors.js';

let handler: ReturnType<typeof createProxy> | undefined;
export default {
  async fetch(request: Request): Promise<Response> {
    try { handler ??= createProxy(readConfig(), { cache: new RuntimeCache() }); }
    catch (error) {
      const details = error instanceof ConfigurationError ? { field: error.field, reason: error.message } : null;
      console.error(JSON.stringify({ event: 'configuration_error', ...details }));
      const response = errorResponse(new HttpError(500, 'Invalid server configuration', undefined, 'INVALID_CONFIGURATION'), undefined, details);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    return handler(request);
  },
};
