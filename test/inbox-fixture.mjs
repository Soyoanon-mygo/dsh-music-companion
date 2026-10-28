import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function inboxFixture(t, kind = 'embedded') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-inbox-test-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({ behavior: { onSongChange: 'silent' } }),
  );
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const token = 'inbox-test-token';
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  async function start() {
    let log = '';
    child = fork(new URL('./fixtures/inbox-hub.mjs', import.meta.url), [kind], {
      env: {
        ...process.env,
        MUSIC_CONFIG: config,
        MUSIC_HUB_HOST: '127.0.0.1',
        MUSIC_HUB_PORT: String(port),
        MUSIC_HUB_TOKEN: token,
        MUSIC_HUB_DATA: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', (chunk) => {
      log += chunk;
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        if (
          (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }))
            .ok
        )
          return;
      } catch {
        /* Waiting for the test server. */
      }
      await sleep(25);
    }
    throw new Error(`hub failed to start: ${log}`);
  }
  t.after(async () => {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  return {
    base,
    token,
    config,
    async request(route, body, expected = 200, authenticated = true) {
      const response = await fetch(`${base}${route}`, {
        method: body !== undefined ? 'POST' : 'GET',
        headers: {
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, expected);
      return response.json();
    },
    async restart() {
      await stop();
      await start();
    },
  };
}
