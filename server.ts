import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import https from 'https';
import { URL } from 'url';

const app = express();
const PORT = 3000;

// High-performance reusable connection pool agents with keepAlive
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 15000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 15000,
  rejectUnauthorized: false
});

// In-memory cache for live manifests to eliminate round-trip latency
interface CacheEntry {
  body: string;
  contentType: string;
  expires: number;
}
const manifestCache = new Map<string, CacheEntry>();
const MANIFEST_CACHE_TTL_MS = 2000; // 2s cache for live HLS manifests

// Periodic cleanup of expired cache
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of manifestCache.entries()) {
    if (now > entry.expires) {
      manifestCache.delete(key);
    }
  }
}, 5000);

/**
 * Helper: Resolve child URI against parent URI while preserving parent query parameters
 * (Critical for Akamai/EdgeAuth tokens like hdnea=exp=...hmac=... used by Sony and CDN streams)
 */
function resolveChildUriWithInheritedQuery(childRaw: string, parentUrl: URL): string {
  const resolved = new URL(childRaw, parentUrl);
  // If the child URL has no query string but the parent does (e.g., auth tokens), inherit them
  if (!resolved.search && parentUrl.search) {
    resolved.search = parentUrl.search;
  }
  return resolved.href;
}

/**
 * Ultra-Fast Low-Latency CORS Proxy Route for M3U8 Manifests and TS Segments / DRM Keys
 * Query param: ?url=<encoded_target_url>
 */
async function proxyStreamRequest(
  targetUrl: string,
  req: Request,
  res: Response,
  redirectCount: number = 0
): Promise<void> {
  try {
    const parsedTarget = new URL(targetUrl);
    const isHttps = parsedTarget.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const isM3u8 = parsedTarget.pathname.endsWith('.m3u8') || parsedTarget.pathname.includes('.m3u8');
    const isMpd = parsedTarget.pathname.endsWith('.mpd') || parsedTarget.pathname.includes('.mpd');

    // Check manifest cache for instantaneous response
    if (isM3u8 && req.method === 'GET' && !req.headers.range) {
      const cached = manifestCache.get(targetUrl);
      if (cached && Date.now() < cached.expires) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Cache-Control', 'max-age=1, public');
        res.send(cached.body);
        return;
      }
    }

    const incomingForwarded = req.headers['x-forwarded-for'];
    const clientIp = typeof incomingForwarded === 'string'
      ? incomingForwarded.split(',')[0].trim()
      : req.socket.remoteAddress;

    // Clean, high-compatibility headers for upstream media CDNs
    const outgoingHeaders: Record<string, string> = {
      'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive'
    };

    if (clientIp) {
      outgoingHeaders['X-Forwarded-For'] = clientIp;
      outgoingHeaders['X-Real-IP'] = clientIp;
    }

    const hdneaParam = parsedTarget.searchParams.get('hdnea');
    if (hdneaParam) {
      outgoingHeaders['Cookie'] = `hdnea=${hdneaParam}`;
    }

    if (req.headers.range) {
      outgoingHeaders['Range'] = req.headers.range;
    }

    const proxyReq = client.request(
      parsedTarget,
      {
        method: req.method,
        headers: outgoingHeaders,
        agent,
        timeout: 8000
      },
      (proxyRes) => {
        // Handle HTTP redirects (301, 302, 303, 307, 308)
        const statusCode = proxyRes.statusCode || 200;
        if ([301, 302, 303, 307, 308].includes(statusCode) && proxyRes.headers.location) {
          const resolvedRedirect = new URL(proxyRes.headers.location, parsedTarget).href;
          console.log(`[CORS Proxy] Following redirect (${statusCode}) -> ${resolvedRedirect}`);
          proxyRes.resume(); // Ensure socket is drained and returned to agent pool immediately
          if (redirectCount < 5) {
            proxyStreamRequest(resolvedRedirect, req, res, redirectCount + 1);
            return;
          } else {
            res.status(statusCode);
            res.setHeader('Location', `/api/proxy?url=${encodeURIComponent(resolvedRedirect)}`);
            res.end();
            return;
          }
        }

        // Forward HTTP status
        res.status(statusCode);

        // Forward important media headers
        const headersToPass = [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'location'
        ];

        headersToPass.forEach((hdr) => {
          const val = proxyRes.headers[hdr];
          if (val) {
            res.setHeader(hdr, val);
          }
        });

        const contentType = proxyRes.headers['content-type'] || '';

        // Set low-latency cache hints
        const isManifest = isM3u8 || isMpd || contentType.includes('mpegurl') || contentType.includes('m3u8') || contentType.includes('dash+xml');
        if (isManifest) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=30'); // TS/mp4 segments are immutable
        }

        const isSuccess = statusCode >= 200 && statusCode < 300;
        const shouldRewriteManifest = isSuccess && (isM3u8 || contentType.includes('mpegurl') || contentType.includes('m3u8'));

        // Rewrite relative URLs in manifests
        if (shouldRewriteManifest && req.method === 'GET') {
          let manifestBody = '';
          proxyRes.setEncoding('utf-8');

          proxyRes.on('data', (chunk) => {
            manifestBody += chunk;
          });

          proxyRes.on('end', () => {
            try {
              const effectiveContentType = 'application/vnd.apple.mpegurl';
              res.setHeader('Content-Type', effectiveContentType);
              const lines = manifestBody.split('\n');
              const rewrittenLines = lines.map((line) => {
                const trimmed = line.trim();
                if (!trimmed) return line;

                // Handle EXT-X-KEY (AES-128 DRM encryption keys)
                if (trimmed.startsWith('#EXT-X-KEY:')) {
                  return trimmed.replace(/URI="([^"]+)"/, (_match, keyUri) => {
                    const resolvedKeyUri = resolveChildUriWithInheritedQuery(keyUri, parsedTarget);
                    return `URI="/api/proxy?url=${encodeURIComponent(resolvedKeyUri)}"`;
                  });
                }

                // Handle EXT-X-MAP (Initialization segments for fMP4)
                if (trimmed.startsWith('#EXT-X-MAP:')) {
                  return trimmed.replace(/URI="([^"]+)"/, (_match, mapUri) => {
                    const resolvedMapUri = resolveChildUriWithInheritedQuery(mapUri, parsedTarget);
                    return `URI="/api/proxy?url=${encodeURIComponent(resolvedMapUri)}"`;
                  });
                }

                // Header / Directive
                if (trimmed.startsWith('#')) {
                  return line;
                }

                // Media segment or nested playlist URI
                const resolvedUri = resolveChildUriWithInheritedQuery(trimmed, parsedTarget);
                return `/api/proxy?url=${encodeURIComponent(resolvedUri)}`;
              });

              const rewrittenManifest = rewrittenLines.join('\n');

              // Store in short TTL cache
              manifestCache.set(targetUrl, {
                body: rewrittenManifest,
                contentType: effectiveContentType,
                expires: Date.now() + MANIFEST_CACHE_TTL_MS
              });

              res.setHeader('X-Cache', 'MISS');
              res.send(rewrittenManifest);
            } catch (rewriteErr) {
              console.error('[CORS Proxy] Error parsing manifest:', rewriteErr);
              res.send(manifestBody);
            }
          });
        } else {
          // Continuous live stream / raw MPEG-TS video slices: disable timeout once piping starts
          proxyReq.setTimeout(0);
          req.on('close', () => {
            try {
              proxyReq.destroy();
            } catch (e) {}
          });
          proxyRes.pipe(res);
        }
      }
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Stream Gateway Timeout' });
      }
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Stream Proxy Gateway Error', details: err.message });
      }
    });

    if (req.method === 'POST' || req.method === 'PUT') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy media stream', details: err.message });
    }
  }
}

app.all('/api/proxy', async (req: Request, res: Response): Promise<void> => {
  let targetUrl = req.query.url as string;

  // Maximum permissive CORS headers to completely eradicate browser CORS blocking
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges, X-Cache, Location');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (!targetUrl) {
    res.status(400).json({ error: 'Missing "url" query parameter' });
    return;
  }

  // Prevent recursive proxy nesting: unwrap down to the real upstream URL
  let loopCount = 0;
  while (targetUrl && (targetUrl.includes('/api/proxy?url=') || targetUrl.includes('%2Fapi%2Fproxy')) && loopCount < 30) {
    loopCount++;
    const match = targetUrl.match(/(?:\/api\/proxy\?url=|%2Fapi%2Fproxy%3Furl%3D)(.+)$/i);
    if (match && match[1]) {
      try {
        targetUrl = decodeURIComponent(match[1]);
      } catch {
        targetUrl = match[1];
      }
    } else {
      break;
    }
  }

  // Also decode any remaining multi-encoded URL until it begins with http:// or https://
  let decodeCount = 0;
  while (targetUrl && !targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && decodeCount < 10) {
    decodeCount++;
    try {
      const decoded = decodeURIComponent(targetUrl);
      if (decoded === targetUrl) break;
      targetUrl = decoded;
    } catch {
      break;
    }
  }

  // Check if corsproxy.io upstream is requested (only route externally if an API key is present)
  const upstream = (req.query.upstream as string) || (req.headers['x-proxy-upstream'] as string) || '';
  const corsProxyKey = (req.query.key as string) || (req.headers['x-corsproxy-key'] as string) || process.env.CORSPROXY_API_KEY || '';

  if (upstream === 'corsproxy' && corsProxyKey) {
    // Attempt fetching via corsproxy.io with the provided API key
    const corsProxyTarget = `https://corsproxy.io/?key=${encodeURIComponent(corsProxyKey)}&url=${encodeURIComponent(targetUrl)}`;

    console.log(`[CORS Proxy] Routing via corsproxy.io (with API key) -> ${targetUrl}`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const corsRes = await fetch(corsProxyTarget, {
        headers: {
          'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (corsRes.ok) {
        res.status(corsRes.status);
        corsRes.headers.forEach((val, key) => {
          if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
            res.setHeader(key, val);
          }
        });
        res.setHeader('X-Proxy-Engine', 'corsproxy.io');
        const buffer = await corsRes.arrayBuffer();
        res.send(Buffer.from(buffer));
        return;
      } else {
        console.warn(`[CORS Proxy] corsproxy.io returned HTTP ${corsRes.status}. Using direct high-speed proxy.`);
      }
    } catch (corsErr: any) {
      console.warn(`[CORS Proxy] corsproxy.io error (${corsErr.message}). Using direct high-speed proxy.`);
    }
  }

  await proxyStreamRequest(targetUrl, req, res);
});

/**
 * Player Embed Proxy Route
 * Proxies and renders protected player embeds (e.g. binge-giotv player2)
 * Bypasses referer restrictions and strips Telegram redirect guards
 */
app.get('/api/player-embed', async (req: Request, res: Response) => {
  const targetUrl = (req.query.url as string) || 'https://binge-giotv.pages.dev/player2?id=ss1tel';
  const domainList = (req.query.domain as string) || 'https://bingewave-sports.pages.dev, https://binge-sports.pages.dev';
  const primaryDomain = domainList.split(',')[0].trim();

  try {
    const fetchRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': primaryDomain.endsWith('/') ? primaryDomain : primaryDomain + '/'
      }
    });

    const rawData = await fetchRes.text();

    // Check if the page contains obfuscated script
    let cleanHtml = rawData;
    if (rawData.includes('// == Namaste == //') && rawData.includes('//-->')) {
      const startIdx = rawData.indexOf('// == Namaste == //');
      const endIdx = rawData.lastIndexOf('//-->');
      const jsCode = rawData.slice(startIdx, endIdx);

      let extracted = '';
      (globalThis as any).__extractEmbedOutput = function(html: string) {
        extracted = html;
      };

      const patched = jsCode.replace(/document\[_0x2ac307\(0x507\)\]\s*\(/g, '(globalThis).__extractEmbedOutput(');
      try {
        eval(patched);
        if (extracted) {
          cleanHtml = extracted;
        }
      } catch (evalErr) {
        console.warn('[Player Embed] De-obfuscation fallback warning:', evalErr);
      }
    }

    // Neutralize protection.js to prevent unauthorized Telegram breakout redirects
    cleanHtml = cleanHtml.replace(/<script\s+src=["']\.?\/protection\.js["']><\/script>/gi, '<!-- protection neutralized -->');
    // Ensure data JSON URL is fully qualified
    cleanHtml = cleanHtml.replace(/const\s+CHANNELS_JSON_URL\s*=\s*["']\/data\/id\.json["'];/gi, 'const CHANNELS_JSON_URL = "https://binge-giotv.pages.dev/data/id.json";');

    // Add base tag for any relative assets
    let targetOrigin = 'https://sonucdn-v2.pages.dev';
    try {
      const parsed = new URL(targetUrl);
      targetOrigin = `${parsed.protocol}//${parsed.host}`;
    } catch (e) {}

    if (!cleanHtml.includes('<base')) {
      cleanHtml = cleanHtml.replace('<head>', `<head>\n  <base href="${targetOrigin}/">`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.send(cleanHtml);
  } catch (err: any) {
    console.error('[Player Embed Error]', err);
    res.status(500).send(`Failed to load embedded stream: ${err.message}`);
  }
});

// Redirect any legacy routes to main live sports player
app.get(['/tnt', '/tnt.html'], (_req: Request, res: Response) => {
  res.redirect(301, '/');
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile('index.html', { root: 'dist' });
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Stream Server] Ultra-fast low-latency streaming server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
