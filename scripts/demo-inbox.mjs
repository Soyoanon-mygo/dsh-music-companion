#!/usr/bin/env node
/** 推荐收件箱演示：仅使用临时目录和示例歌曲，不读个人配置。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../packages/watcher/lib/hub.mjs';
import { unusedPort } from '../test/inbox-fixture.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-inbox-demo-'));
const token = 'demo-inbox';
const hub = createHub({
  port: await unusedPort(),
  host: '127.0.0.1',
  token,
  dataDir,
  behavior: { onSongChange: 'silent' },
});
await hub.start();
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const songs = [
  {
    title: '春日影',
    artist: 'MyGO!!!!!',
    reason: '你最近常听日系乐队。把情绪慢慢铺开的这首，可能正好适合现在。',
  },
  {
    title: '陪葬夏天的健忘录',
    artist: '指错',
    id: '2757490399',
    reason: '从你偏爱的抒情歌里，挑了一首更安静的。留给夜晚，也留一点余地。',
  },
  {
    title: '花海',
    artist: '回春丹',
    reason:
      '如果今天需要换个心情，试试这首。吉他和人声，都带着一点夏天的气息。',
  },
  {
    title: '影色舞',
    artist: 'MyGO!!!!!',
    reason: '同一支乐队，另一种能量。做事的时候，也许你会想把音量调大一点。',
  },
  {
    title: '晴天',
    artist: '周杰伦',
    reason: '偶尔也听一首熟悉的老歌。',
    status: 'listened',
    note: '熟悉的前奏，一听就想起学生时代。',
  },
  {
    title: '示例：不合口味的歌',
    artist: '示例歌手',
    reason: '看看哪些推荐被跳过，下一次就能更懂你的口味。',
    status: 'skipped',
    note: '最近想听轻快一点的，不想听慢歌。',
  },
];
for (const song of songs) {
  const response = await fetch(`${hub.url}/v1/recommend`, {
    method: 'POST',
    headers,
    body: JSON.stringify(song),
  });
  if (!response.ok) throw new Error(`demo seed failed: ${response.status}`);
  const { item } = await response.json();
  if (song.status) {
    await fetch(`${hub.url}/v1/recommendations/${item.id}/feedback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status: song.status, note: song.note }),
    });
  }
}
console.log(`推荐收件箱演示（示例数据）：${hub.url}/recommendations`);
console.log(`访问令牌：${token}`);
console.log('按 Ctrl+C 关闭并删除演示数据。');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await hub.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
}
