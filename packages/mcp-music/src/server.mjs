#!/usr/bin/env node
/**
 * mcp-music — 给 DSH agent 用的音乐工具（stdio MCP server）
 *
 * v0.1 只暴露两个只读工具：
 *   music_now_playing  现在在听什么
 *   music_history      最近听过什么
 *
 * 环境变量：
 *   MUSIC_HUB_URL   music-hub 地址，默认 http://127.0.0.1:8787
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, pick } from '../../shared/config.mjs';
import { createRecommendationTools } from '../../watcher/lib/recommendation-tools.mjs';

const CFG = loadConfig();

const HUB = String(pick('MUSIC_HUB_URL', CFG.hub?.url, 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const TOKEN = String(pick('MUSIC_HUB_TOKEN', CFG.hub?.token, '')).trim();

/* ------------------------------------------------------------------ */
/* hub 客户端                                                          */
/* ------------------------------------------------------------------ */

async function hubGet(pathAndQuery) {
  const res = await fetch(`${HUB}${pathAndQuery}`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`music-hub returned ${res.status}`);
  }
  return res.json();
}

async function hubPost(pathname, body) {
  const res = await fetch(`${HUB}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`music-hub returned ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
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

  const bits = [
    `《${now.track.title}》`,
    artistsOf(now.track),
    now.playing ? '正在播放' : '已暂停',
  ];

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
  // songId 是 agent 调歌词/评论接口的钥匙，拿到就告诉她
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
      // listenedSeconds 是"换到这首之前，上一首听了多久"，用来判断那是听完还是跳过
      let tail = '';
      if (typeof it.listenedSeconds === 'number') {
        const sec = it.listenedSeconds;
        tail = `（上一首听了 ${sec}s）`;
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
/* MCP server                                                          */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: 'mcp-music', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const inboxUrl = `${HUB}/recommendations`;
const recommendationTools = createRecommendationTools({ get: hubGet, post: hubPost }, inboxUrl);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...recommendationTools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
    {
      name: 'music_now_playing',
      description:
        '查看主人此刻正在听什么歌。当主人提到音乐、问你在听什么、或你想主动接话聊音乐时用。返回歌名、歌手、播放状态；如果很久没更新会标注可能已关闭。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'music_history',
      description:
        '查看主人在桌面上最近听过哪些歌（按时间倒序）。用来了解他的听歌口味、判断某首歌他是不是反复在听。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: '返回多少条，默认 20，最多 100',
            minimum: 1,
            maximum: 100,
          },
        },
      },
    },
    {
      name: 'music_recommend',
      description:
        '把一首歌放进推荐收件箱。推之前先用 music_recommendations 看待听和已跳过的歌；重复待听不会新增。reason 会原样展示给主人。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '歌名' },
          artist: { type: 'string', description: '歌手' },
          reason: { type: 'string', description: '为什么推这首，一句话，会展示给主人' },
          id: { type: 'string', description: '可选，网易云歌曲 ID（有就带上，能精确匹配）' },
        },
        required: ['title', 'artist', 'reason'],
      },
    },
    {
      name: 'music_taste',
      description:
        '查看或更新你对主人口味的了解（歌手亲密度、风格标签、随手笔记）。' +
        '不带参数 = 读；带参数 = 整体覆盖写。写之前先读一次，在原有基础上补充，别把之前记的丢掉。' +
        'affinity 是 -5..5 的整数，正数表示喜欢，note 写一句印象。',
      inputSchema: {
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
            },
          },
          tags: {
            type: 'array',
            description: '风格/语言标签，如「独立摇滚」「粤语」',
            items: { type: 'string' },
          },
          notes: { type: 'string', description: '自由笔记，4000 字以内' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    const recommendationTool = recommendationTools.find((tool) => tool.name === name);
    if (recommendationTool) return text(await recommendationTool.execute(args));
    if (name === 'music_now_playing') {
      const now = await hubGet('/v1/now-playing');
      return text(describeNow(now));
    }

    if (name === 'music_history') {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const { items } = await hubGet(`/v1/history?limit=${limit}`);
      return text(describeHistory(items));
    }

    if (name === 'music_recommend') {
      const title = String(args.title || '').trim();
      const artist = String(args.artist || '').trim();
      if (!title) {
        return { ...text('推荐失败：歌名不能为空'), isError: true };
      }
      const res = await hubPost('/v1/recommend', {
        title,
        artist,
        reason: String(args.reason || '').trim(),
        id: args.id ? String(args.id) : null,
      });
      return text(
        `${res.duplicate ? '这首已在待听队列' : '已放进待听队列'}：《${title}》${artist ? ` — ${artist}` : ''}。` +
          `推荐 ID：${res.item.id}。收件箱：${inboxUrl}`,
      );
    }

    if (name === 'music_taste') {
      const hasWrite =
        args.artists !== undefined || args.tags !== undefined || args.notes !== undefined;
      if (!hasWrite) {
        const { taste } = await hubGet('/v1/taste');
        return text(describeTaste(taste));
      }
      const res = await hubPost('/v1/taste', {
        artists: Array.isArray(args.artists) ? args.artists : [],
        tags: Array.isArray(args.tags) ? args.tags : [],
        notes: String(args.notes || ''),
      });
      return text('口味已更新：\n' + describeTaste(res?.taste));
    }

    return { ...text(`未知工具：${name}`), isError: true };
  } catch (err) {    // 工具失败要返回 isError，让 agent 知道"读不到"，而不是编一个答案
    return {
      content: [{ type: 'text', text: `读不到音乐数据：${err.message}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
