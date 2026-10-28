/**
 * hub — 音乐状态中枢（可嵌入版）
 *
 * 和 packages/music-hub 那份是同一套逻辑，区别只有一点：
 * 这里导出一个 `createHub(options)` 工厂，由调用方决定端口、数据目录、日志去处。
 * hub 做成插件时，就不用再单开一个进程了。
 *
 * 只做三件事：收、存、给。没有数据库，没有依赖，出问题 `cat` 一下就能明白。
 *
 * options：
 *   port      监听端口（默认 8787）
 *   host      绑定地址（默认 127.0.0.1）
 *   token     写接口共享密钥；不设则所有接口直接 401
 *   dataDir   数据目录
 *   staleMs   多久没更新算"没在听"（默认 600_000）
 *   behavior  主动发言策略（见 notify.mjs）
 *   log       日志函数
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { createNotifier } from './notify.mjs';
import { createRecommendationQueue } from './recommendations.mjs';
import { serveInbox } from './inbox.mjs';

export function createHub(options = {}) {
  const PORT = Number(options.port) > 0 ? Number(options.port) : 8787;
  const HOST = String(options.host || '127.0.0.1');
  const TOKEN = String(options.token || '').trim();
  const DATA_DIR = String(options.dataDir || '');
  const STALE_MS =
    (Number(options.staleMs) > 0 ? Number(options.staleMs) : 600 * 1000);
  const behavior = options.behavior || {};
  const log = options.log || (() => {});

  if (!DATA_DIR) throw new Error('createHub: dataDir is required');

  const FILES = {
    now: path.join(DATA_DIR, 'now-playing.json'),
    history: path.join(DATA_DIR, 'history.jsonl'),
    recs: path.join(DATA_DIR, 'recommendations.json'),
    taste: path.join(DATA_DIR, 'taste.json'),
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES.taste ? path.dirname(FILES.taste) : DATA_DIR, { recursive: true });

  /* ---------------------------------------------------------------- */
  /* 小工具                                                            */
  /* ---------------------------------------------------------------- */

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };

  /** 原子写：先写临时文件再 rename，断电也不会留下半个 JSON */
  const writeJson = (file, obj) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  };

  const readHistory = (limit) => {
    const lines = [];
    try {
      const raw = fs.readFileSync(FILES.history, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line));
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 文件还不存在 */
    }
    return lines.slice(-limit).reverse();
  };

  const appendHistory = (entry) => {
    fs.appendFileSync(FILES.history, `${JSON.stringify(entry)}\n`);
  };

  const trackKey = (track) =>
    `${(track?.title || '').trim()}|${(track?.artists || []).join(',')}`;

  /* ---------------------------------------------------------------- */
  /* HTTP 小框架                                                       */
  /* ---------------------------------------------------------------- */

  const send = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  const readBody = (req, limit = 64 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });

  /** 鉴权：Authorization: Bearer <token> 或 ?token=<token> */
  const authorized = (req, url) => {
    if (!TOKEN) return false;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ') && header.slice(7).trim() === TOKEN) return true;
    return url.searchParams.get('token') === TOKEN;
  };

  /* ---------------------------------------------------------------- */
  /* 业务                                                              */
  /* ---------------------------------------------------------------- */

  const notifier = createNotifier(behavior, log);
  const recommendations = createRecommendationQueue({
    read: () => readJson(FILES.recs, []),
    write: (items) => writeJson(FILES.recs, items),
    log,
  });

  let lastKey = (() => {
    const prev = readJson(FILES.now, null);
    if (!prev?.track) return null;
    const last = readHistory(1)[0];
    return last?.track ? trackKey(last.track) : prev.playing !== false ? trackKey(prev.track) : null;
  })();

  function handleNowPlaying(body) {
    if (!body || !body.track || !body.track.title) {
      return { status: 400, payload: { ok: false, error: 'track.title is required' } };
    }

    const track = {
      title: String(body.track.title).slice(0, 200),
      artists: Array.isArray(body.track.artists)
        ? body.track.artists.map((a) => String(a).slice(0, 100)).slice(0, 8)
        : [],
      album: body.track.album ? String(body.track.album).slice(0, 200) : '',
      id: body.track.id ?? null,
      duration: typeof body.track.duration === 'number' ? body.track.duration : null,
    };

    const playing = body.playing !== false;
    const now = new Date().toISOString();
    const key = trackKey(track);
    const changed = key !== lastKey;

    // 播放位置不能当听歌时长：暂停、拖进度条和采集空白都不该增加计数。
    const prev = readJson(FILES.now, null);
    const sameTrack = prev?.track && trackKey(prev.track) === key;
    const device = body.device ? String(body.device).slice(0, 64) : 'unknown';
    const source = body.source ? String(body.source).slice(0, 64) : 'unknown';
    const nonnegative = (value) => Number.isFinite(value) && value >= 0;
    const previousTotal = nonnegative(prev?.listenedSeconds) ? prev.listenedSeconds : 0;
    let pending = nonnegative(prev?.pendingListenedSeconds) ? prev.pendingListenedSeconds : null;
    if (!sameTrack && prev?.track && trackKey(prev.track) === lastKey) pending = previousTotal;

    let total = sameTrack ? previousTotal : key === lastKey ? pending ?? 0 : 0;
    const reported = nonnegative(body.listenedSeconds) ? body.listenedSeconds : null;
    const gap = Date.parse(now) - Date.parse(prev?.updatedAt);
    if (sameTrack && prev.device === device && prev.source === source &&
        gap >= 0 && gap <= STALE_MS) {
      if (reported !== null && nonnegative(prev.watcherListenedSeconds)) {
        // 计数归零表示 watcher 重启或丢失媒体，不能跨这段空白累加。
        total += Math.min(Math.max(0, reported - prev.watcherListenedSeconds), gap / 1000);
      } else if (reported === null && prev.playing) {
        // 兼容旧 watcher：只统计前一轮在播放的有效采样间隔。
        total += gap / 1000;
      }
    }

    const listenedSeconds = pending === null ? null : Math.round(pending);
    const startedAt = !sameTrack || !prev?.startedAt ? now : prev.startedAt;

    const state = {
      track,
      progress: typeof body.progress === 'number' ? body.progress : null,
      playing,
      device,
      source,
      listenedSeconds: total,
      watcherListenedSeconds: reported,
      // 暂停时切歌不写历史；把上一首的计数保留到新歌真正开始播放。
      pendingListenedSeconds: changed && playing ? null : pending,
      startedAt,
      updatedAt: now,
      stale: false,
    };
    writeJson(FILES.now, state);
    if (playing) recommendations.markListened(track, state.source);

    if (changed && playing) {
      appendHistory({ at: now, track, device: state.device, listenedSeconds });
      lastKey = key;
      notifier.maybeNotify(state, true);
      log(
        `history += ${track.title} — ${track.artists.join('/') || '未知歌手'}` +
          (listenedSeconds != null ? `（上一首听了 ${listenedSeconds}s）` : ''),
      );
    }

    return { status: 200, payload: { ok: true, changed } };
  }

  function handleGetNowPlaying() {
    const state = readJson(FILES.now, null);
    if (!state) return { status: 404, payload: { ok: false, error: 'no data yet' } };
    const age = Date.now() - new Date(state.updatedAt).getTime();
    return {
      status: 200,
      payload: { ...state, stale: age > STALE_MS, ageSeconds: Math.round(age / 1000) },
    };
  }

  function handleGetTaste() {
    return { status: 200, payload: { ok: true, taste: readJson(FILES.taste, null) } };
  }

  function handlePutTaste(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, payload: { ok: false, error: 'body must be a JSON object' } };
    }
    const artists = Array.isArray(body.artists)
      ? body.artists
          .filter((x) => x && typeof x === 'object' && x.name)
          .slice(0, 100)
          .map((x) => {
            const n = Number(x.affinity);
            return {
              name: String(x.name).slice(0, 100),
              affinity: Number.isFinite(n) ? Math.max(-5, Math.min(5, n)) : 0,
              note: x.note ? String(x.note).slice(0, 300) : '',
            };
          })
      : [];
    const taste = {
      artists,
      tags: Array.isArray(body.tags)
        ? body.tags.slice(0, 50).map((x) => String(x).slice(0, 60))
        : [],
      notes: body.notes ? String(body.notes).slice(0, 4000) : '',
      updatedAt: new Date().toISOString(),
    };
    writeJson(FILES.taste, taste);
    log(`taste updated: ${taste.artists.length} artists / ${taste.tags.length} tags`);
    return { status: 200, payload: { ok: true, taste } };
  }

  /* ---------------------------------------------------------------- */
  /* 路由                                                              */
  /* ---------------------------------------------------------------- */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (serveInbox(req, res, url.pathname)) return;
      if (url.pathname.startsWith('/v1/') && !authorized(req, url)) {
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }

      const feedback = /^\/v1\/recommendations\/([^/]+)\/feedback$/.exec(url.pathname);
      if (req.method === 'POST' && feedback) {
        const body = await readBody(req);
        const { status, payload } = recommendations.feedback(decodeURIComponent(feedback[1]), body);
        return send(res, status, payload);
      }

      switch (route) {
        case 'GET /health':
          return send(res, 200, {
            ok: true,
            service: 'music-hub',
            uptime: process.uptime(),
          });

        case 'GET /v1/now-playing':
          return send(res, ...Object.values(handleGetNowPlaying()));

        case 'GET /v1/history': {
          const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 200);
          return send(res, 200, { ok: true, items: readHistory(limit) });
        }

        case 'GET /v1/recommendations':
          return send(res, ...Object.values(recommendations.list(url.searchParams)));

        case 'GET /v1/taste':
          return send(res, ...Object.values(handleGetTaste()));

        case 'POST /v1/now-playing': {
          const body = await readBody(req);
          const { status, payload } = handleNowPlaying(body);
          return send(res, status, payload);
        }

        case 'POST /v1/recommend': {
          const body = await readBody(req);
          const { status, payload } = recommendations.recommend(body);
          return send(res, status, payload);
        }

        case 'POST /v1/taste': {
          const body = await readBody(req);
          const { status, payload } = handlePutTaste(body);
          return send(res, status, payload);
        }

        default:
          return send(res, 404, { ok: false, error: `no route: ${route}` });
      }
    } catch (err) {
      log('request failed:', err.message);
      return send(res, err instanceof SyntaxError || err instanceof URIError ? 400 : 500, { ok: false, error: err.message });
    }
  });

  const url = `http://${HOST}:${PORT}`;

  return {
    url,
    port: PORT,
    dataDir: DATA_DIR,
    describe() {
      return `hub：${url}（数据在 ${DATA_DIR}）`;
    },
    /** 起服务。端口被占用时 reject，交给调用方决定要不要降级。 */
    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          log(`music-hub listening on ${url}`);
          log(`data dir: ${DATA_DIR}`);
          log(notifier.describe());
          log(`stale after: ${Math.round(STALE_MS / 1000)}s`);
          log(TOKEN ? 'write endpoints: enabled' : 'token 为空，所有接口都会 401');
          resolve(this);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(PORT, HOST);
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1500).unref?.();
      });
    },
    notifier,
  };
}
