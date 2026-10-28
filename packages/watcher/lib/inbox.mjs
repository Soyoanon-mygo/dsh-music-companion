import fs from 'node:fs';

const ASSETS = new Map([
  ['/recommendations', ['inbox.html', 'text/html; charset=utf-8']],
  ['/recommendations/', ['inbox.html', 'text/html; charset=utf-8']],
  ['/recommendations/inbox.css', ['inbox.css', 'text/css; charset=utf-8']],
  ['/recommendations/inbox.js', ['inbox.js', 'text/javascript; charset=utf-8']],
]);

/** 只提供静态外壳，推荐数据仍必须带 Bearer token 从 /v1/ 读取。 */
export function serveInbox(req, res, pathname) {
  if (req.method !== 'GET' || !ASSETS.has(pathname)) return false;
  const [file, type] = ASSETS.get(pathname);
  const body = fs.readFileSync(new URL(`../ui/${file}`, import.meta.url));
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(body);
  return true;
}
