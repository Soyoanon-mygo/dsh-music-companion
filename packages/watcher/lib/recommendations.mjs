/** 推荐队列的存取与反馈；插件和独立 hub 共用，不需要数据库。 */
import { randomUUID } from 'node:crypto';

const STATUSES = new Set(['pending', 'listened', 'skipped']);
const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '');
const artistsOf = (value) =>
  String(value || '')
    .split(/[\/、,，;&]/u)
    .map(norm)
    .filter(Boolean);
const result = (status, payload) => ({ status, payload });
const invalid = (error) => result(400, { ok: false, error });

export function songId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value).trim().replace(/^0+/, '');
  return /^[1-9]\d{0,19}$/.test(id) ? id : null;
}

function present(item) {
  const id = songId(item.songId);
  return {
    ...item,
    status: item.status || 'pending',
    songId: id,
    songUrl: id ? `https://music.163.com/song?id=${id}` : null,
  };
}

function sameRecommendation(a, b) {
  if (songId(a.songId) && songId(b.songId))
    return songId(a.songId) === songId(b.songId);
  return norm(a.title) === norm(b.title) && norm(a.artist) === norm(b.artist);
}

function matchesTrack(item, track, source) {
  const recommendedId = songId(item.songId);
  const playingId = songId(track.id);
  if (source === 'netease' && recommendedId && playingId)
    return recommendedId === playingId;
  if (norm(item.title) !== norm(track.title)) return false;
  const wanted = artistsOf(item.artist);
  const actual = (track.artists || []).flatMap(artistsOf);
  return (
    wanted.length === 0 || wanted.some((artist) => actual.includes(artist))
  );
}

export function createRecommendationQueue({ read, write, log = () => {} }) {
  function load() {
    const items = read();
    if (!Array.isArray(items))
      throw new Error('recommendations.json must contain an array');
    return items;
  }

  return {
    list(params = new URLSearchParams()) {
      const status = params.get('status') || 'all';
      if (status !== 'all' && !STATUSES.has(status))
        return invalid('invalid status');
      const limit = params.has('limit') ? Number(params.get('limit')) : 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return invalid('limit must be 1..200');
      const order = params.get('order') || 'oldest';
      if (!['oldest', 'newest'].includes(order))
        return invalid('invalid order');
      const items = load().map(present);
      const counts = { pending: 0, listened: 0, skipped: 0 };
      for (const item of items)
        if (STATUSES.has(item.status)) counts[item.status] += 1;
      const query = norm(params.get('q'));
      let filtered = items.filter(
        (item) =>
          (status === 'all' || item.status === status) &&
          (!query ||
            norm(
              `${item.title} ${item.artist} ${item.reason} ${item.feedback || ''}`,
            ).includes(query)),
      );
      if (order === 'newest') filtered = filtered.reverse();
      return result(200, {
        ok: true,
        items: filtered.slice(0, limit),
        total: filtered.length,
        counts,
      });
    },

    recommend(body) {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        typeof body.title !== 'string' ||
        !body.title.trim()
      )
        return invalid('title is required');
      const rawId = body.songId ?? body.id;
      const id = songId(rawId);
      if (rawId != null && rawId !== '' && !id)
        return invalid('song id must be a positive decimal string');
      const item = {
        id: `r${randomUUID()}`,
        title: body.title.trim().slice(0, 200),
        artist: String(body.artist || '')
          .trim()
          .slice(0, 100),
        reason: String(body.reason || '')
          .trim()
          .slice(0, 500),
        songId: id,
        status: 'pending',
        at: new Date().toISOString(),
      };
      const items = load();
      const duplicate = items.find(
        (existing) =>
          (!existing.status || existing.status === 'pending') &&
          sameRecommendation(existing, item),
      );
      if (duplicate) {
        if (!songId(duplicate.songId) && id) {
          duplicate.songId = id;
          write(items);
        }
        return result(200, {
          ok: true,
          item: present(duplicate),
          duplicate: true,
        });
      }
      items.push(item);
      write(items.slice(-200));
      log(
        `recommend += ${item.title}${item.artist ? ` — ${item.artist}` : ''}`,
      );
      return result(200, { ok: true, item: present(item), duplicate: false });
    },

    feedback(id, body) {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !STATUSES.has(body.status)
      ) {
        return invalid('status must be pending, listened or skipped');
      }
      if (body.note !== undefined && typeof body.note !== 'string')
        return invalid('note must be a string');
      const items = load();
      const item = items.find((item) => item.id === id);
      if (!item)
        return result(404, { ok: false, error: 'recommendation not found' });
      item.status = body.status;
      item.feedbackAt = new Date().toISOString();
      if (body.note !== undefined)
        item.feedback = body.note.trim().slice(0, 500);
      if (body.status === 'listened') item.listenedAt ||= item.feedbackAt;
      if (body.status === 'pending') {
        delete item.listenedAt;
        delete item.listenedTrack;
      }
      write(items);
      return result(200, { ok: true, item: present(item) });
    },

    markListened(track, source) {
      const items = load();
      let changed = false;
      for (const item of items) {
        if (item.status && item.status !== 'pending') continue;
        if (!matchesTrack(item, track, source)) continue;
        item.status = 'listened';
        item.listenedAt = new Date().toISOString();
        item.listenedTrack = { title: track.title, artists: track.artists };
        changed = true;
        log(`recommend hit: 《${item.title}》 被听到了`);
      }
      if (changed) write(items);
    },
  };
}
