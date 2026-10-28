/**
 * DSH host 插件入口。
 *
 * 一个插件做完四件事：
 *   1. 起一个本地 hub（收/存/给），除非 config.json 里的 hub.url 指向了远端
 *   2. 每 20 秒读一次系统媒体会话（SMTC），把变化推给 hub
 *   3. 向宿主注册音乐状态、推荐收件箱与口味工具
 *   4. 用 ctx.effect 管生命周期：插件卸载 / 桌面端退出时自动停掉定时器与 http server
 *
 * 逻辑全在 `lib/` 下，CLI 入口（`watcher.mjs`）也复用同一套。
 *
 * 诊断说明：宿主进程的 console.log 不会进 DSH 的日志文件，所以这里把关键
 * 节点额外写到 `%TEMP%\music-watcher-boot.log`。插件"装了但没动静"时先看它。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, pick, pickNumber, describeConfig } from './lib/config.mjs';
import { createTicker } from './lib/ticker.mjs';
import { createHub } from './lib/hub.mjs';
import { createMusicTools } from './lib/tools.mjs';

const stamp = () => new Date().toTimeString().slice(0, 8);
const BOOT_LOG = path.join(os.tmpdir(), 'music-watcher-boot.log');

/** 写一行诊断；写不进去就算了，绝不因为日志把插件搞挂。 */
function trace(...args) {
  const text = args
    .map((a) => (a instanceof Error ? a.stack || a.message : String(a)))
    .join(' ');
  try {
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${text}\n`);
  } catch {
    /* ignore */
  }
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

export const inject = ['tools'];
export const name = 'music-watcher';

export function apply(ctx, config = {}) {
  trace('apply() 被调用，config =', JSON.stringify(config));

  const cfg = loadConfig();

  const hubUrlRaw = String(pick('MUSIC_HUB_URL', cfg.hub?.url, '')).replace(/\/+$/, '');
  const hubToken = String(pick('MUSIC_HUB_TOKEN', cfg.hub?.token, '')).trim();
  const pollSeconds = pickNumber('MUSIC_POLL_SECONDS', cfg.watcher?.pollSeconds, 20, {
    min: 5,
  });

  // 有远端 hub 就用远端；没配或者配的本来就是本机，就自己起一个
  const useEmbedded = cfg.hub?.embedded !== false && (!hubUrlRaw || LOOPBACK.test(hubUrlRaw));

  const log = (...args) => {
    console.log(`[music-watcher ${stamp()}]`, ...args);
    trace(...args);
  };

  log(describeConfig());

  /** 1. hub */
  let localHub = null;
  let effectiveHubUrl = hubUrlRaw;
  let effectiveToken = hubToken;

  if (useEmbedded) {
    const port = Number(new URL(hubUrlRaw || 'http://127.0.0.1:8787').port) || 8787;
    const embeddedToken = String(cfg.hub?.embeddedToken || 'local-dev');
    localHub = createHub({
      port,
      host: '127.0.0.1',
      token: embeddedToken,
      dataDir: path.join(os.homedir(), '.dsh-music-companion', 'data'),
      staleMs: (Number(cfg.hub?.staleSeconds) || 600) * 1000,
      behavior: cfg.behavior || {},
      log,
    });
    effectiveHubUrl = localHub.url;
    effectiveToken = embeddedToken;
    trace(`本地 hub 准备启动：${localHub.url}`);
  } else {
    trace(`使用远端 hub：${hubUrlRaw}`);
  }

  /** 2. 音乐工具（失败也不该拦住上报） */
  let registered = 0;
  try {
    const defs = createMusicTools({ hubUrl: effectiveHubUrl, token: effectiveToken });
    for (const def of defs) {
      ctx.tools.register(def);
      registered += 1;
    }
    trace(`工具注册成功：${registered} 个`);
  } catch (err) {
    trace('工具注册失败：', err);
    log('工具注册失败：', err && err.message ? err.message : err);
  }

  /** 3. hub 与 ticker 都挂在 effect 上，卸载时一起收 */
  try {
    ctx.effect(() => {
      trace('effect 回调执行，启动 hub 与 ticker');

      if (localHub) {
        localHub.start().catch((err) => {
          trace('本地 hub 启动失败：', err);
          log('本地 hub 起不来（', err && err.message ? err.message : err, '），工具会连不上');
        });
      }

      const ticker = createTicker({
        hubUrl: effectiveHubUrl,
        token: effectiveToken,
        pollSeconds,
        device: cfg.watcher?.device,
      });
      ticker.start(log);
      trace(`ticker 已启动：${ticker.describe()}`);

      return () => {
        trace('effect cleanup：停 ticker 与 hub');
        try {
          ticker.stop();
        } catch {
          /* ignore */
        }
        if (localHub) localHub.stop();
      };
    }, 'music-watcher');
    trace(`ctx.effect 注册成功（工具 ${registered} 个）`);
  } catch (err) {
    trace('ctx.effect 注册失败：', err);
    log('ctx.effect 注册失败：', err && err.message ? err.message : err);
  }
}
