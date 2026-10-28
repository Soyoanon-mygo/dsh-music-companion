const $ = (selector) => document.querySelector(selector);
const LABELS = {
  pending: '待听',
  listened: '已听过',
  skipped: '已跳过',
  all: '全部推荐',
};
const TITLES = {
  pending: '待听清单',
  listened: '听过，也留下回音',
  skipped: '不合口味的，就跳过',
  all: '每一次，新的发现',
};
let token = '';
try {
  token = sessionStorage.getItem('music-hub-token') || '';
} catch {
  /* Storage may be disabled. */
}
let status = 'pending';
let generation = 0;
let connectionGeneration = 0;
let loading = false;
let saving = 0;
let searchTimer;

function message(text = '', error = false) {
  $('#message').textContent = text;
  $('#message').hidden = !text;
  $('#message').classList.toggle('error', error);
}

function remember(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem('music-hub-token', value);
    else sessionStorage.removeItem('music-hub-token');
  } catch {
    /* The inbox also works without storage. */
  }
}

function connected(value) {
  $('#login').hidden = value;
  $('#collection').hidden = !value;
  $('#disconnect').hidden = !value;
  $('#connection-state').textContent = value ? '已连接收件箱' : '尚未连接';
  $('.connection').classList.toggle('connected', value);
}

function disconnect() {
  generation += 1;
  connectionGeneration += 1;
  loading = false;
  $('#refresh').disabled = false;
  remember('');
  $('#token').value = '';
  $('#cards').replaceChildren();
  for (const element of document.querySelectorAll('[data-count]'))
    element.textContent = '0';
  connected(false);
  message();
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401)
    throw new Error('令牌不正确或已失效，请重新连接。');
  if (!response.ok)
    throw new Error(`暂时无法更新收件箱（${response.status}），请稍后重试。`);
  return response.json();
}

function render(data) {
  const fragment = document.createDocumentFragment();
  data.items.forEach((item, index) => {
    const card = $('#card-template').content.firstElementChild.cloneNode(true);
    const coverHash = Array.from(`${item.title}|${item.artist || ''}`).reduce(
      (hash, char) => (hash * 31 + char.codePointAt(0)) >>> 0,
      0,
    );
    card.querySelector('.track-cover').dataset.palette = String(coverHash % 6);
    card.querySelector('.cover-word').textContent = Array.from(
      item.title || '♫',
    )[0];
    card.querySelector('.track-number').textContent = String(
      index + 1,
    ).padStart(2, '0');
    const tag = card.querySelector('.status-tag');
    tag.textContent = LABELS[item.status] || item.status;
    tag.dataset.status = item.status;
    const date = new Date(item.at);
    const time = card.querySelector('time');
    if (Number.isFinite(date.getTime())) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
      });
    }
    card.querySelector('.track-title').textContent = item.title;
    card.querySelector('.track-artist').textContent = item.artist || '未知歌手';
    card.querySelector('.reason').textContent =
      item.reason || '有些歌，听见了就想分享给你。';
    const note = card.querySelector('textarea');
    note.value = item.feedback || '';
    if (item.feedback) {
      const feedback = card.querySelector('.existing-feedback');
      feedback.hidden = false;
      feedback.textContent = `你的反馈：${item.feedback}`;
    }
    const link = card.querySelector('.song-link');
    // Accept validated NetEase song URLs; otherwise build a search link from text.
    if (
      typeof item.songUrl === 'string' &&
      /^https:\/\/music\.163\.com\/song\?id=[1-9]\d{0,19}$/.test(item.songUrl)
    ) {
      link.href = item.songUrl;
    } else {
      const query = encodeURIComponent(
        `${item.title} ${item.artist || ''} 歌曲`,
      );
      link.href = `https://www.bing.com/search?q=${query}`;
      link.textContent = '搜索这首 ↗';
    }
    const actions = card.querySelector('.status-actions');
    const saveNote = card.querySelector('.save-note');
    function saveFeedback(next) {
      return async () => {
        const version = connectionGeneration;
        saving += 1;
        for (const control of card.querySelectorAll('button'))
          control.disabled = true;
        try {
          await api(
            `/v1/recommendations/${encodeURIComponent(item.id)}/feedback`,
            { status: next, note: note.value },
          );
          if (version !== connectionGeneration) return;
          message(
            `《${item.title}》已更新：${LABELS[next]}${note.value.trim() ? '，反馈已保存' : ''}。`,
          );
          await refresh();
        } catch (error) {
          if (version === connectionGeneration) message(error.message, true);
        } finally {
          saving -= 1;
          for (const control of card.querySelectorAll('button'))
            control.disabled = false;
        }
      };
    }
    saveNote.addEventListener('click', saveFeedback(item.status));
    for (const next of ['listened', 'skipped', 'pending']) {
      if (next === item.status) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent =
        next === 'listened'
          ? '听过了'
          : next === 'skipped'
            ? '跳过'
            : '放回待听';
      button.addEventListener('click', saveFeedback(next));
      actions.append(button);
    }
    fragment.append(card);
  });
  $('#cards').replaceChildren(fragment);
  for (const element of document.querySelectorAll('[data-count]')) {
    const key = element.dataset.count;
    element.textContent =
      key === 'all'
        ? Object.values(data.counts).reduce((a, b) => a + b, 0)
        : data.counts[key];
  }
  $('#empty').hidden = data.items.length > 0;
  const searching = $('#search').value.trim();
  $('#empty-title').textContent = searching
    ? '还没找到这首歌'
    : status === 'pending'
      ? '待听清单，暂时留白'
      : '这里还没有推荐';
  $('#empty-copy').textContent = searching
    ? '换个歌名、歌手或关键词试试看。'
    : status === 'pending'
      ? '和她说“给我推荐一首歌”，下一次心动就会出现在这里。'
      : '听一听，或者留下反馈，这里就会慢慢丰富起来。';
  $('#result-count').textContent = `${data.total} 首推荐`;
  $('#collection-title').textContent = TITLES[status];
  $('#current-filter').textContent = LABELS[status];
  $('#collection-caption').textContent = searching
    ? `关于“${searching}”的推荐`
    : '新的声音，等你发现。';
}

async function refresh() {
  if (!token) return;
  // A filter/search change may supersede an in-flight read; only the latest read renders.
  const version = ++generation;
  loading = true;
  $('#refresh').disabled = true;
  try {
    const params = new URLSearchParams({
      status,
      limit: '200',
      order: 'newest',
    });
    if ($('#search').value.trim()) params.set('q', $('#search').value.trim());
    const data = await api(`/v1/recommendations?${params}`);
    if (version !== generation) return;
    connected(true);
    render(data);
  } catch (error) {
    if (version === generation) message(error.message, true);
    throw error;
  } finally {
    if (version === generation) {
      loading = false;
      $('#refresh').disabled = false;
    }
  }
}

$('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (!$('#token').value.trim()) {
    message('请输入访问令牌。', true);
    return;
  }
  button.disabled = true;
  connectionGeneration += 1;
  remember($('#token').value.trim());
  message();
  try {
    await refresh();
    $('#token').value = '';
  } catch {
    remember('');
    connected(false);
  } finally {
    button.disabled = false;
  }
});
$('#disconnect').addEventListener('click', disconnect);
$('#refresh').addEventListener('click', () => {
  message();
  void refresh().catch(() => {});
});
for (const button of document.querySelectorAll('[data-status]')) {
  button.addEventListener('click', () => {
    status = button.dataset.status;
    for (const tab of document.querySelectorAll('[data-status]'))
      tab.setAttribute('aria-pressed', String(tab === button));
    message();
    void refresh().catch(() => {});
  });
}
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void refresh().catch(() => {});
  }, 200);
});
setInterval(() => {
  if (
    !token ||
    loading ||
    saving ||
    document.hidden ||
    document.activeElement?.matches('textarea, input')
  )
    return;
  void refresh().catch(() => {});
}, 30_000);
if (token)
  void refresh().catch(() => {
    remember('');
    connected(false);
  });
