import { RuntimeCache } from '../src/cache.js';
import { ConfigurationError, readConfig } from '../src/config.js';
import { createProxy } from '../src/proxy.js';

let handler: ReturnType<typeof createProxy> | undefined;
export default {
  async fetch(request: Request): Promise<Response> {
    try { handler ??= createProxy(readConfig(), { cache: new RuntimeCache() }); }
    catch (error) {
      const details = error instanceof ConfigurationError ? { field: error.field, reason: error.message } : {};
      console.error(JSON.stringify({ event: 'configuration_error', ...details }));
      return new Response(JSON.stringify({ message: 'Invalid server configuration', code: 'INVALID_CONFIGURATION', ...details }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' },
      });
    }
    return handler(request);
  },
};
