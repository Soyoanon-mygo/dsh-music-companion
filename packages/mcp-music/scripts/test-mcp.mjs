#!/usr/bin/env node
/**
 * MCP 冒烟测试：起一个临时 hub，用官方 SDK 的 client 连上 mcp-music，
 * 列工具、调工具，确认 agent 侧真的能拿到数据。
 *
 *   npm run test:mcp
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unusedPort } from '../../../test/inbox-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..'); // packages/mcp-music/scripts → repo root
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'music-mcp-smoke-'));
const CONFIG = path.join(DATA_DIR, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ behavior: { onSongChange: 'silent' } }));
const PORT = await unusedPort();
const TOKEN = 'mcp-smoke-token';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`${url} 没起来`);
}

const hub = spawn(process.execPath, [path.join(ROOT, 'packages/music-hub/src/hub.mjs')], {
  env: {
    ...process.env,
    MUSIC_HUB_PORT: String(PORT),
    MUSIC_HUB_HOST: '127.0.0.1',
    MUSIC_HUB_TOKEN: TOKEN,
    MUSIC_HUB_DATA: DATA_DIR,
    // 别读到开发机上的真实 config.json（可能连着公网 hub）
    MUSIC_CONFIG: CONFIG,
  },
  stdio: 'ignore',
});

let failed = false;
try {
  await waitFor(`${BASE}/health`);

  // 造一条数据
  await fetch(`${BASE}/v1/now-playing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      track: { title: '贵人', artists: ['回春丹'], album: '鲜花', id: null, duration: null },
      playing: true,
      device: 'smoke',
    }),
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'packages/mcp-music/src/server.mjs')],
    env: { ...process.env, MUSIC_CONFIG: CONFIG, MUSIC_HUB_URL: BASE, MUSIC_HUB_TOKEN: TOKEN },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'mcp-music-smoke', version: '0.1.0' });
  await client.connect(transport);
  console.log('✓ client 连上 server');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['music_history', 'music_now_playing', 'music_recommend', 'music_recommendation_feedback', 'music_recommendations', 'music_taste']);
  console.log(`✓ 工具列表正确：${names.join(', ')}`);

  const now = await client.callTool({ name: 'music_now_playing', arguments: {} });
  const nowText = now.content?.[0]?.text ?? '';
  assert.ok(nowText.includes('贵人'), 'now_playing 应包含歌名');
  assert.ok(nowText.includes('回春丹'), 'now_playing 应包含歌手');
  assert.ok(nowText.includes('正在播放'), 'now_playing 应说明状态');
  console.log(`✓ music_now_playing → ${nowText}`);

  const hist = await client.callTool({ name: 'music_history', arguments: { limit: 5 } });
  const histText = hist.content?.[0]?.text ?? '';
  assert.ok(histText.includes('贵人'), 'history 应包含歌名');
  console.log(`✓ music_history → ${histText.split('\n')[0]}`);

  const bad = await client.callTool({ name: 'music_history', arguments: { limit: 999 } });
  assert.equal(bad.isError, undefined, 'limit 超范围应被夹紧而不是报错');
  console.log('✓ limit 被夹紧，没有炸');

  const rec = await client.callTool({
    name: 'music_recommend',
    arguments: { title: '花海', artist: '回春丹', reason: '跟你刚听的是同一支乐队' },
  });
  const recText = rec.content?.[0]?.text ?? '';
  assert.equal(rec.isError, undefined, 'recommend 不应报错');
  assert.ok(recText.includes('花海'), 'recommend 应回显歌名');
  const recs = await fetch(`${BASE}/v1/recommendations`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  assert.equal(recs.items.length, 1, 'hub 上应有一条推荐');
  assert.equal(recs.items[0].reason, '跟你刚听的是同一支乐队');
  console.log(`✓ music_recommend → ${recText}`);

  // taste：先读（空），再写，再读回
  const tasteEmpty = await client.callTool({ name: 'music_taste', arguments: {} });
  assert.ok(
    (tasteEmpty.content?.[0]?.text ?? '').includes('还没有'),
    '空口味应提示还没记录',
  );

  const tasteWrite = await client.callTool({
    name: 'music_taste',
    arguments: {
      artists: [{ name: '回春丹', affinity: 4, note: '现场比录音室好听' }],
      tags: ['独立摇滚'],
      notes: '深夜听抒情',
    },
  });
  assert.equal(tasteWrite.isError, undefined, 'taste 写不应报错');
  assert.ok((tasteWrite.content?.[0]?.text ?? '').includes('回春丹'), '写回显应含歌手');

  const tasteRead = await client.callTool({ name: 'music_taste', arguments: {} });
  const tasteText = tasteRead.content?.[0]?.text ?? '';
  assert.ok(tasteText.includes('回春丹'), '读回应含歌手');
  assert.ok(tasteText.includes('独立摇滚'), '读回应含标签');
  console.log(`✓ music_taste → ${tasteText.split('\n')[0]}`);

  // 推荐闭环：推一首，再上报"正在听"，应被标成 listened
  await client.callTool({
    name: 'music_recommend',
    arguments: { title: '晴天', artist: '周杰伦', reason: '试试' },
  });
  await fetch(`${BASE}/v1/now-playing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      track: { title: '晴天', artists: ['周杰伦'] },
      playing: true,
      device: 'smoke',
    }),
  });
  const recsAfter = await fetch(`${BASE}/v1/recommendations`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  const sunny = recsAfter.items.find((x) => x.title === '晴天');
  assert.equal(sunny?.status, 'listened', '听到推荐应标成 listened');
  console.log('✓ 推荐闭环：听到后被标成 listened');

  await client.close();
  console.log('\n全部通过');
} catch (err) {
  failed = true;
  console.error('\n失败：', err.message);
} finally {
  const stopped = hub.exitCode === null ? once(hub, 'exit') : Promise.resolve();
  hub.kill();
  await stopped;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
