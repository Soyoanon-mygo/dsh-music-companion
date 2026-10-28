import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRecommendationQueue,
  songId,
} from '../packages/watcher/lib/recommendations.mjs';

function fixture(initial = []) {
  let saved = structuredClone(initial);
  const queue = createRecommendationQueue({
    read: () => structuredClone(saved),
    write: (items) => {
      saved = structuredClone(items);
    },
  });
  return { queue, items: () => saved };
}

const recommend = (queue, extra = {}) =>
  queue.recommend({
    title: '春日影',
    artist: 'MyGO!!!!!',
    reason: '你最近常听乐队。',
    id: '12345',
    ...extra,
  });

test('preserves the song ID separately from a collision-resistant recommendation ID', () => {
  const { queue } = fixture();
  const first = recommend(queue).payload.item;
  const second = recommend(queue, { id: '67890' }).payload.item;
  assert.equal(first.songId, '12345');
  assert.equal(first.songUrl, 'https://music.163.com/song?id=12345');
  assert.notEqual(first.id, first.songId);
  assert.notEqual(first.id, second.id);
});

test('deduplicates pending songs by ID and keeps distinct recordings separate', () => {
  const { queue, items } = fixture();
  const first = recommend(queue).payload.item;
  const duplicate = recommend(queue, { title: 'Alternate spelling' }).payload;
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.item.id, first.id);
  recommend(queue, { id: '67890' });
  assert.equal(items().length, 2);
});

test('legacy title/artist matches can acquire a song ID without being duplicated', () => {
  const { queue, items } = fixture([
    { id: 'legacy', title: '春 日影', artist: 'mygo!!!!!', reason: 'original' },
  ]);
  const { item, duplicate } = recommend(queue).payload;
  assert.equal(duplicate, true);
  assert.equal(item.id, 'legacy');
  assert.equal(item.songId, '12345');
  assert.equal(item.reason, 'original');
  assert.equal(items().length, 1);
});

test('validates song IDs and rejects empty recommendations', () => {
  const { queue } = fixture();
  for (const value of [
    'javascript:alert(1)',
    '123/456',
    '-1',
    '0',
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(recommend(queue, { id: value }).status, 400);
  }
  for (const title of ['', '   ', 123, [], null])
    assert.equal(recommend(queue, { title }).status, 400);
  assert.equal(songId('000123'), '123');
  assert.equal(songId('18446744073709551615'), '18446744073709551615');
});

test('feedback persists, can be edited, and can restore a song to pending', () => {
  const { queue } = fixture();
  const { id } = recommend(queue).payload.item;
  assert.equal(
    queue.feedback(id, { status: 'skipped', note: '不太喜欢这个编曲' }).payload
      .item.feedback,
    '不太喜欢这个编曲',
  );
  assert.equal(
    queue.feedback(id, { status: 'listened' }).payload.item.feedback,
    '不太喜欢这个编曲',
  );
  const restored = queue.feedback(id, { status: 'pending', note: '' }).payload
    .item;
  assert.equal(restored.feedback, '');
  assert.equal(restored.listenedAt, undefined);
  assert.equal(queue.feedback(id, { status: 'unknown' }).status, 400);
  assert.equal(queue.feedback(id, { status: 'skipped', note: {} }).status, 400);
  assert.equal(queue.feedback('missing', { status: 'skipped' }).status, 404);
});

test('skipped songs retain feedback when the watcher later sees them playing', () => {
  const { queue } = fixture();
  const { id } = recommend(queue).payload.item;
  queue.feedback(id, { status: 'skipped', note: '暂时不想听' });
  queue.markListened(
    { id: '12345', title: '春日影', artists: ['MyGO!!!!!'] },
    'netease',
  );
  const item = queue.list().payload.items[0];
  assert.equal(item.status, 'skipped');
  assert.equal(item.feedback, '暂时不想听');
});

test('automatic feedback uses exact IDs when available', () => {
  const { queue } = fixture();
  recommend(queue);
  queue.markListened(
    { id: '67890', title: '春日影', artists: ['MyGO!!!!!'] },
    'netease',
  );
  assert.equal(queue.list().payload.items[0].status, 'pending');
  queue.markListened(
    { id: '12345', title: 'alias', artists: ['alias'] },
    'netease',
  );
  assert.equal(queue.list().payload.items[0].status, 'listened');
});

test('fallback matching requires the full title and an exact artist name', () => {
  const { queue } = fixture();
  recommend(queue, { id: null });
  for (const track of [
    { title: '春日影 Live', artists: ['MyGO!!!!!'] },
    { title: '春日影', artists: ['MyGO!!!!! cover band'] },
    { title: '春日影', artists: [] },
  ])
    queue.markListened(track, 'spotify');
  assert.equal(queue.list().payload.items[0].status, 'pending');
  queue.markListened(
    { title: '春 日影', artists: ['Guest / MyGO!!!!!'] },
    'spotify',
  );
  assert.equal(queue.list().payload.items[0].status, 'listened');
});

test('filtering, newest-first limits, counts and feedback search work together', () => {
  const { queue } = fixture();
  const first = recommend(queue).payload.item;
  recommend(queue, { id: '67890', title: '影色舞' });
  queue.feedback(first.id, { status: 'skipped', note: '想要更轻快的歌' });
  const pending = queue.list(
    new URLSearchParams({ status: 'pending', order: 'newest', limit: '1' }),
  ).payload;
  assert.equal(pending.items[0].title, '影色舞');
  assert.deepEqual(pending.counts, { pending: 1, listened: 0, skipped: 1 });
  assert.equal(
    queue.list(new URLSearchParams({ q: '更轻快' })).payload.items[0].id,
    first.id,
  );
  assert.equal(
    queue.list().payload.items[0].id,
    first.id,
    'legacy GET order stays oldest-first',
  );
  for (const params of [
    { status: 'bad' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: 'NaN' },
    { order: 'bad' },
  ]) {
    assert.equal(queue.list(new URLSearchParams(params)).status, 400);
  }
});

test('retains the existing 200 recommendation storage bound', () => {
  const { queue, items } = fixture();
  for (let index = 1; index <= 201; index += 1)
    recommend(queue, { id: String(index) });
  assert.equal(items().length, 200);
  assert.equal(items()[0].songId, '2');
});
