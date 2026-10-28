import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMusicTools } from '../packages/watcher/lib/tools.mjs';
import { inboxFixture } from './inbox-fixture.mjs';

for (const kind of ['embedded', 'standalone']) {
  test(`${kind}: recommend → inbox → feedback → restart`, async (t) => {
    const hub = await inboxFixture(t, kind);
    const { item } = await hub.request('/v1/recommend', {
      title: '春日影',
      artist: 'MyGO!!!!!',
      id: '12345',
      reason: '乐队推荐',
    });
    assert.equal(item.songId, '12345');
    const route = `/v1/recommendations/${item.id}/feedback`;
    await hub.request('/v1/recommendations', undefined, 401, false);
    await hub.request(route, { status: 'skipped' }, 401, false);
    await hub.request(route, { status: 'skipped', note: '想听轻快一点的' });
    await hub.restart();
    const skipped = await hub.request(
      '/v1/recommendations?status=skipped&q=轻快&order=newest',
    );
    assert.equal(skipped.items.length, 1);
    assert.equal(skipped.items[0].feedback, '想听轻快一点的');
    assert.equal(skipped.counts.skipped, 1);
    await hub.request(route, { status: 'pending', note: '' });
    assert.equal(
      (await hub.request('/v1/recommendations?status=pending')).items.length,
      1,
    );
    await hub.request(route, { status: 'invalid' }, 400);
    await hub.request(
      '/v1/recommendations/missing/feedback',
      { status: 'skipped' },
      404,
    );
    const malformed = await fetch(`${hub.base}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hub.token}` },
      body: '{',
    });
    assert.equal(malformed.status, 400);
  });

  test(`${kind}: the next playing heartbeat acknowledges a newly recommended current song`, async (t) => {
    const hub = await inboxFixture(t, kind);
    const state = {
      track: { title: '春日影', artists: ['MyGO!!!!!'], id: '12345' },
      playing: true,
      source: 'netease',
    };
    await hub.request('/v1/now-playing', state);
    await hub.request('/v1/recommend', {
      title: '春日影',
      artist: 'MyGO!!!!!',
      id: '12345',
    });
    const heartbeat = await hub.request('/v1/now-playing', state);
    assert.equal(heartbeat.changed, false);
    assert.equal(
      (await hub.request('/v1/recommendations?status=listened')).items.length,
      1,
    );
    assert.equal((await hub.request('/v1/history')).items.length, 1);
  });

  test(`${kind}: static shell contains no recommendation data or token`, async (t) => {
    const hub = await inboxFixture(t, kind);
    await hub.request('/v1/recommend', {
      title: 'PRIVATE-RECOMMENDATION',
      artist: '<script>alert(1)</script>',
    });
    for (const [route, type] of [
      ['/recommendations', 'text/html'],
      ['/recommendations/inbox.js', 'text/javascript'],
      ['/recommendations/inbox.css', 'text/css'],
    ]) {
      const response = await fetch(`${hub.base}${route}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
      assert.match(
        response.headers.get('content-security-policy'),
        /script-src 'self'/,
      );
      const content = await response.text();
      assert.ok(!content.includes('PRIVATE-RECOMMENDATION'));
      assert.ok(!content.includes(hub.token));
    }
    assert.equal(
      (await fetch(`${hub.base}/recommendations/not-an-asset`)).status,
      404,
    );
  });

  test(`${kind}: host tools can discover recommendations and save feedback`, async (t) => {
    const hub = await inboxFixture(t, kind);
    const tools = createMusicTools({ hubUrl: hub.base, token: hub.token });
    const recommend = tools.find((tool) => tool.name === 'music_recommend');
    const list = tools.find((tool) => tool.name === 'music_recommendations');
    const feedback = tools.find(
      (tool) => tool.name === 'music_recommendation_feedback',
    );
    const result = await recommend.execute({
      title: '春日影',
      artist: 'MyGO!!!!!',
      reason: '乐队推荐',
      id: '12345',
    });
    assert.ok(result.includes(`${hub.base}/recommendations`));
    assert.match(
      await recommend.execute({
        title: '春日影',
        artist: 'MyGO!!!!!',
        reason: '乐队推荐',
        id: '12345',
      }),
      /已在待听队列/,
    );
    assert.match(await list.execute(), /春日影/);
    const { id } = (await hub.request('/v1/recommendations')).items[0];
    assert.match(
      await feedback.execute({
        recommendationId: id,
        status: 'skipped',
        note: '暂时不想听',
      }),
      /已跳过/,
    );
    assert.match(
      await list.execute({ status: 'skipped', query: '暂时' }),
      /暂时不想听/,
    );
    assert.match(await list.execute(), /还没有推荐/);
    assert.deepEqual(list.output.render({}, 'text'), [
      { type: 'text', text: 'text' },
    ]);
  });
}
