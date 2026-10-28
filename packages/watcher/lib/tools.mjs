/**
 * tools — 音乐工具，由 DSH 宿主直接注册（不走 MCP）
 *
 * 为什么不走 MCP：
 *   MCP 需要 cordis.patch.yml 里写一个绝对路径（指向本包内的 server.mjs），
 *   而 patch 是静态 YAML，装到别人机器上路径就对不上了。
 *   直接在宿主里注册工具，装完重启就能用，零配置。
 *
 * 工具的实现和 packages/mcp-music 里的那份完全一致 —— 都走 HTTP 调 hub，
 * 所以"hub 在本地"和"hub 在远端服务器"两种用法行为一样。
 */

import { createRecommendationTools } from './recommendation-tools.mjs';

/* ------------------------------------------------------------------ */
/* hub 客户端                                                          */
/* ------------------------------------------------------------------ */

function makeClient(hubUrl, token) {
  const HUB = String(hubUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const H = token ? { authorization: `Bearer ${token}` } : {};

  return {
    async get(pathAndQuery) {
      const res = await fetch(`${HUB}${pathAndQuery}`, {
        headers: H,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`music-hub returned ${res.status}`);
      return res.json();
    },
    async post(pathname, body) {
      const res = await fetch(`${HUB}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...H },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`music-hub returned ${res.status}: ${t.slice(0, 200)}`);
      }
      return res.json();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

const artistsOf = (track) =>
  track?.artists?.length ? track.artists.join('/') : '未知歌手';

const formatDuration = (sec) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function describeNow(now) {
  if (!now || !now.track) return '还没收到任何播放数据。可能是桌面端的 watcher 没在跑。';

  const bits = [`《${now.track.title}》`, artistsOf(now.track), now.playing ? '正在播放' : '已暂停'];
  let line = bits.join(' — ');

  if (now.track.duration) line += `，时长 ${formatDuration(now.track.duration)}`;
  if (Number.isFinite(now.listenedSeconds) && now.listenedSeconds >= 0) {
    line += `，已听约 ${Math.round(now.listenedSeconds)} 秒`;
  }

  if (now.stale) {
    line += `（已经 ${now.ageSeconds} 秒没更新了，可能关掉了播放器）`;
  } else if (now.track.duration && typeof now.progress === 'number') {
    const pct = Math.round((now.progress / now.track.duration) * 100);
    line += `（进度约 ${pct}%）`;
  }

  if (now.track.album) line += `，专辑《${now.track.album}》`;
  if (now.track.id) line += `，歌曲 ID ${now.track.id}`;
  if (now.source && now.source !== 'other') line += `，来源 ${now.source}`;
  return line;
}

function describeHistory(items) {
  if (!items?.length) return '还没有听歌记录。';
  return items
    .map((it, i) => {
      const t = it.track || {};
      const at = new Date(it.at).toLocaleString('zh-CN', {
        hour12: false,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      let tail = '';
      if (typeof it.listenedSeconds === 'number') {
        tail = `（上一首听了 ${it.listenedSeconds}s）`;
      }
      return `${i + 1}. ${at} 《${t.title}》— ${artistsOf(t)}${tail}`;
    })
    .join('\n');
}

function describeTaste(taste) {
  if (!taste) return '还没有记录口味。可以先看一阵子 music_history，再写进来。';
  const lines = [];
  if (taste.artists?.length) {
    lines.push(
      '歌手：' +
        taste.artists
          .map((a) => `${a.name}(${a.affinity > 0 ? '+' : ''}${a.affinity})`)
          .join('、'),
    );
  }
  if (taste.tags?.length) lines.push('风格：' + taste.tags.join('、'));
  if (taste.notes) lines.push('笔记：' + taste.notes);
  if (taste.updatedAt) {
    lines.push('更新于 ' + new Date(taste.updatedAt).toLocaleString('zh-CN', { hour12: false }));
  }
  return lines.join('\n') || '口味记录是空的。';
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

/**
 * 返回可直接塞给 `ctx.tools.register()` 的工具定义。
 * 不依赖 defineTool：parameters 直接就是 JSON Schema，output.schema 是结果类型。
 */
export function createMusicTools({ hubUrl, token }) {
  const hub = makeClient(hubUrl, token);
  const inboxUrl = `${String(hubUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '')}/recommendations`;

  /** 统一把异常转成"读不到"，让 agent 知道失败而不是编答案 */
  const fail = (err) => ({
    content: [{ type: 'text', text: `读不到音乐数据：${err.message}` }],
    isError: true,
  });

  return [
    ...createRecommendationTools(hub, inboxUrl),
    {
      name: 'music_now_playing',
      description:
        '查看主人此刻正在听什么歌。当主人提到音乐、问你在听什么、或你想主动接话聊音乐时用。返回歌名、歌手、播放状态；如果很久没更新会标注可能已关闭。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        try {
          return describeNow(await hub.get('/v1/now-playing'));
        } catch (err) {
          // 404 = 还没收到过任何数据，这是正常状态，不该报成"读不到"
          if (String(err?.message || '').includes('404')) {
            return '还没收到任何播放数据。可能是桌面端的 watcher 没在跑。';
          }
          throw err;
        }
      },
    },

    {
      name: 'music_history',
      description:
        '查看主人在桌面上最近听过哪些歌（按时间倒序）。用来了解他的听歌口味、判断某首歌他是不是反复在听。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '返回多少条，默认 20，最多 100',
            minimum: 1,
            maximum: 100,
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args = {}) {
        try {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
          const { items } = await hub.get(`/v1/history?limit=${limit}`);
          return describeHistory(items);
        } catch (err) {
          throw err;
        }
      },
    },

    {
      name: 'music_recommend',
      description:
        '把一首歌放进推荐收件箱。推之前先用 music_recommendations 看待听和已跳过的歌；重复待听不会新增。reason 会原样展示给主人。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '歌名' },
          artist: { type: 'string', description: '歌手' },
          reason: { type: 'string', description: '为什么推这首，一句话，会展示给主人' },
          id: { type: 'string', description: '可选，网易云歌曲 ID（有就带上，能精确匹配）' },
        },
        required: ['title', 'artist', 'reason'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args = {}) {
        const title = String(args.title || '').trim();
        const artist = String(args.artist || '').trim();
        if (!title) {
          throw new Error('推荐失败：歌名不能为空');
        }
        try {
          const res = await hub.post('/v1/recommend', {
            title,
            artist,
            reason: String(args.reason || '').trim(),
            id: args.id ? String(args.id) : null,
          });
          return (
            `${res.duplicate ? '这首已在待听队列' : '已放进待听队列'}：《${title}》${artist ? ` — ${artist}` : ''}。` +
            `推荐 ID：${res.item.id}。收件箱：${inboxUrl}`
          );
        } catch (err) {
          throw err;
        }
      },
    },

    {
      name: 'music_taste',
      description:
        '查看或更新你对主人口味的了解（歌手亲密度、风格标签、随手笔记）。不带参数 = 读；带参数 = 整体覆盖写。写之前先读一次，在原有基础上补充，别把之前记的丢掉。affinity 是 -5..5 的整数，正数表示喜欢，note 写一句印象。',
      parameters: {
        type: 'object',
        properties: {
          artists: {
            type: 'array',
            description: '歌手列表，整体覆盖写',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '歌手名' },
                affinity: { type: 'integer', description: '-5..5，正数表示喜欢' },
                note: { type: 'string', description: '一句话印象' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
          tags: {
            type: 'array',
            description: '风格/语言标签，如「独立摇滚」「粤语」',
            items: { type: 'string' },
          },
          notes: { type: 'string', description: '自由笔记，4000 字以内' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args = {}) {
        const hasWrite =
          args.artists !== undefined || args.tags !== undefined || args.notes !== undefined;
        try {
          if (!hasWrite) {
            const { taste } = await hub.get('/v1/taste');
            return describeTaste(taste);
          }
          const res = await hub.post('/v1/taste', {
            artists: Array.isArray(args.artists) ? args.artists : [],
            tags: Array.isArray(args.tags) ? args.tags : [],
            notes: String(args.notes || ''),
          });
          return '口味已更新：\n' + describeTaste(res?.taste);
        } catch (err) {
          throw err;
        }
      },
    },
  ];
}
