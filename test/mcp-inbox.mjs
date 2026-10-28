import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { inboxFixture } from './inbox-fixture.mjs';

// Use the MCP package's existing dependencies; the root test suite stays zero-dependency.
const require = createRequire(
  new URL('../packages/mcp-music/package.json', import.meta.url),
);
const { Client } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
    .href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
    .href
);

for (const kind of ['embedded', 'standalone']) {
  test(`${kind}: MCP client can recommend, read the inbox and record user feedback`, async (t) => {
    const hub = await inboxFixture(t, kind);
    const client = new Client({ name: 'inbox-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL('../packages/mcp-music/src/server.mjs', import.meta.url),
        ),
      ],
      env: {
        ...process.env,
        MUSIC_CONFIG: hub.config,
        MUSIC_HUB_URL: hub.base,
        MUSIC_HUB_TOKEN: hub.token,
      },
      stderr: 'pipe',
    });
    t.after(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'music_history',
      'music_now_playing',
      'music_recommend',
      'music_recommendation_feedback',
      'music_recommendations',
      'music_taste',
    ]);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: args });
    const recommendation = await call('music_recommend', {
      title: '春日影',
      artist: 'MyGO!!!!!',
      reason: '乐队推荐',
      id: '12345',
    });
    assert.equal(recommendation.isError, undefined);
    assert.match(recommendation.content[0].text, /推荐 ID/);
    const inbox = await call('music_recommendations');
    assert.match(inbox.content[0].text, /春日影/);
    assert.match(
      inbox.content[0].text,
      /https:\/\/music\.163\.com\/song\?id=12345/,
    );
    const { id } = (await hub.request('/v1/recommendations')).items[0];
    const saved = await call('music_recommendation_feedback', {
      recommendationId: id,
      status: 'skipped',
      note: '想听轻快一点的',
    });
    assert.equal(saved.isError, undefined);
    assert.match(saved.content[0].text, /已跳过/);
    const skipped = await call('music_recommendations', { status: 'skipped' });
    assert.match(skipped.content[0].text, /想听轻快一点的/);
    assert.match(
      (await call('music_recommendations')).content[0].text,
      /还没有推荐/,
    );
    const invalid = await call('music_recommendation_feedback', {
      recommendationId: 'missing',
      status: 'listened',
    });
    assert.equal(invalid.isError, true);
    assert.equal(
      (await hub.request('/v1/recommendations')).items[0].status,
      'skipped',
    );
  });
}
