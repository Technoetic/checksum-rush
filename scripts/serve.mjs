import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBasePath } from './build.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const contained = (root, target) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };

export function createStaticServer({ directory = 'dist', basePath = '/' } = {}) {
  basePath = normalizeBasePath(basePath);
  const root = realpathSync(path.resolve(directory));
  return http.createServer(async (request, response) => {
    const reply = (status, body, headers = {}) => {
      const bytes = Buffer.from(body);
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': bytes.length, ...headers });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let pathname;
    try { pathname = decodeURIComponent((request.url || '/').split(/[?#]/, 1)[0]); }
    catch { return reply(400, 'Invalid URL'); }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) return reply(400, 'Invalid path');
    if (basePath !== '/' && pathname === basePath.slice(0, -1)) {
      const query = (request.url || '').match(/\?[^#]*/)?.[0] || '';
      return reply(308, 'Moved permanently', { Location: basePath + query });
    }
    if (!pathname.startsWith(basePath)) return reply(404, 'Not found');
    pathname = `/${pathname.slice(basePath.length)}`;
    if (pathname.split('/').some(segment => segment === '.' || segment === '..')) return reply(403, 'Forbidden');
    const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!contained(root, target)) return reply(403, 'Forbidden');
    try {
      const actual = await realpath(target);
      if (!contained(root, actual)) return reply(403, 'Forbidden');
      const info = await stat(actual);
      if (!info.isFile()) return reply(404, 'Not found');
      const body = await readFile(actual);
      const immutable = /^\/assets\/[a-f0-9]{12,64}\//.test(pathname);
      reply(200, body, { 'Content-Type': types[path.extname(actual).toLowerCase()] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return reply(404, 'Not found');
      reply(500, 'Server error');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { port: 8792, host: '127.0.0.1', directory: 'dist' };
    const args = process.argv.slice(2);
    while (args.length) {
      const flag = args.shift();
      if (!['--port', '--host', '--directory', '--base'].includes(flag) || !args.length) throw new Error(`Unknown or incomplete option: ${flag}`);
      options[flag === '--base' ? 'basePath' : flag.slice(2)] = args.shift();
    }
    options.port = Number(options.port);
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port');
    const server = createStaticServer(options);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(options.port, options.host, () => console.log(`CHECKSUM RUSH http://${options.host}:${server.address().port}`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
