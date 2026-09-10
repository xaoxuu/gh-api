import { createServer } from 'node:http';
import { MemoryCache } from '../src/cache.js';
import { readConfig } from '../src/config.js';
import { createProxy } from '../src/proxy.js';

const handler = createProxy(readConfig(), { cache: new MemoryCache() });
const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const result = await handler(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers }));
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Internal error'); }
}).listen(port, '127.0.0.1', () => console.info(`gh-api: http://localhost:${port} (local memory cache)`));
