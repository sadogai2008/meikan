/* Meishi — 名刺管理フロントエンド */

const state = {
  q: '',
  tag: '',
  company: '',
  department: '',
  favorite: false,
  sort: 'updated',
  cards: [],
  meta: { total: 0, favorites: 0, companies: [], departments: [], tags: [] },
  editingId: null,
  drawerId: null,
  aiOpen: false,
  aiBusy: false,
  importRows: [],
  // 適用待ちの編集提案。DOM の data 属性に変更内容を持たせず、
  // ここに退避しておく（画面側の改変で書き込み内容が変わらないようにする）。
  pendingEdits: {},
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  grid: () => $('#card-grid'),
  count: () => $('#result-count'),
  title: () => $('#result-title'),
  empty: () => $('#empty-state'),
  tagFilters: () => $('#tag-filters'),
  deptFilters: () => $('#dept-filters'),
  companyFilters: () => $('#company-filters'),
  search: () => $('#search-input'),
  sort: () => $('#sort-select'),
  drawer: () => $('#detail-drawer'),
  drawerOverlay: () => $('#drawer-overlay'),
  modal: () => $('#modal-backdrop'),
  form: () => $('#card-form'),
  toast: () => $('#toast'),
};

/* ---------------------------------------------------------------- */
/* utilities                                                        */
/* ---------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function initials(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '?';
  const parts = clean.split(' ');
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2);
}

const AVATAR_TONES = ['sand', 'sage', 'clay', 'sky', 'lilac', 'blush', 'stone'];

function toneFor(seed) {
  let hash = 0;
  const str = String(seed ?? '');
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) % 9973;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + (value.length <= 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function relativeDate(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return formatDate(value);
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < 60000) return 'たった今';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < day) return `${Math.floor(diff / 3600000)}時間前`;
  if (diff < day * 30) return `${Math.floor(diff / day)}日前`;
  return formatDate(value);
}

let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = els.toast();
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error((payload && payload.error) || `リクエストに失敗しました (${res.status})`);
  }
  return payload;
}

function debounce(fn, wait = 260) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ---------------------------------------------------------------- */
/* data loading                                                     */
/* ---------------------------------------------------------------- */

function queryString() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.tag) params.set('tag', state.tag);
  if (state.company) params.set('company', state.company);
  if (state.department) params.set('department', state.department);
  if (state.favorite) params.set('favorite', '1');
  params.set('sort', state.sort);
  return params.toString();
}

async function loadMeta() {
  try {
    state.meta = await api('/api/meta');
    renderSidebar();
  } catch (err) {
    console.error(err);
  }
}

async function loadCards() {
  els.count().textContent = '読み込み中…';
  try {
    const data = await api(`/api/cards?${queryString()}`);
    state.cards = data.cards;
    renderGrid();
    renderHeadline();
  } catch (err) {
    els.count().textContent = '読み込みに失敗しました';
    toast(err.message, 'error');
  }
}

/* ---------------------------------------------------------------- */
/* sidebar                                                          */
/* ---------------------------------------------------------------- */

function renderSidebar() {
  $('#count-all').textContent = String(state.meta.total);
  $('#count-fav').textContent = String(state.meta.favorites);

  const tagWrap = els.tagFilters();
  if (!state.meta.tags.length) {
    tagWrap.innerHTML = '<p class="side-empty">タグはまだありません</p>';
  } else {
    tagWrap.innerHTML = state.meta.tags
      .map(
        (tag) => `<button class="chip${state.tag === tag ? ' is-active' : ''}" data-tag="${escapeHtml(tag)}" type="button">#${escapeHtml(tag)}</button>`
      )
      .join('');
  }

  const deptWrap = els.deptFilters();
  if (!state.meta.departments || !state.meta.departments.length) {
    deptWrap.innerHTML = '<p class="side-empty">部署はまだありません</p>';
  } else {
    deptWrap.innerHTML = state.meta.departments
      .map(
        (dept) => `<button class="company-item${state.department === dept ? ' is-active' : ''}" data-dept="${escapeHtml(dept)}" type="button" title="${escapeHtml(dept)}">${escapeHtml(dept)}</button>`
      )
      .join('');
  }

  const companyWrap = els.companyFilters();
  if (!state.meta.companies.length) {
    companyWrap.innerHTML = '<p class="side-empty">会社はまだありません</p>';
  } else {
    companyWrap.innerHTML = state.meta.companies
      .map(
        (company) => `<button class="company-item${state.company === company ? ' is-active' : ''}" data-company="${escapeHtml(company)}" type="button" title="${escapeHtml(company)}">${escapeHtml(company)}</button>`
      )
      .join('');
  }

  $$('.side-item').forEach((btn) => {
    const filter = btn.dataset.filter;
    btn.classList.toggle('is-active', filter === 'favorite' ? state.favorite : !state.favorite);
  });
}

/* ---------------------------------------------------------------- */
/* grid                                                             */
/* ---------------------------------------------------------------- */

function statusLabel() {
  if (state.favorite) return 'お気に入り';
  if (state.company) return state.company;
  if (state.department) return `${state.department} の名刺`;
  if (state.tag) return `#${state.tag}`;
  if (state.q) return `「${state.q}」の検索結果`;
  return 'すべての名刺';
}

function isFiltered() {
  return Boolean(state.q || state.tag || state.company || state.department || state.favorite);
}

function renderHeadline() {
  els.title().textContent = statusLabel();
  const n = state.cards.length;
  els.count().textContent = n === 0 ? '0件' : `${n}件${isFiltered() ? ` / 全${state.meta.total}件` : ''}`;
}

function contactLine(card) {
  return card.position || card.department || '';
}

function renderGrid() {
  const grid = els.grid();
  const empty = els.empty();

  if (!state.cards.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  grid.innerHTML = state.cards
    .map((card) => {
      const tone = toneFor(card.name + card.company);
      const tags = card.tags
        .slice(0, 3)
        .map((t) => `<span class="tag">#${escapeHtml(t)}</span>`)
        .join('');
      const extra = card.tags.length > 3 ? `<span class="tag tag-more">+${card.tags.length - 3}</span>` : '';
      return `
      <article class="card" data-id="${card.id}" tabindex="0" role="button" aria-label="${escapeHtml(card.name)} の名刺を開く">
        <div class="card-top">
          <div class="avatar tone-${tone}" aria-hidden="true">${escapeHtml(initials(card.name))}</div>
          <div class="card-ident">
            <h3 class="card-name">${escapeHtml(card.name)}${card.favorite ? '<span class="fav-flag" title="お気に入り">★</span>' : ''}</h3>
            <p class="card-kana">${escapeHtml(card.nameKana || '')}</p>
            <p class="card-company">${escapeHtml(card.company || '会社名未登録')}</p>
            ${contactLine(card) ? `<p class="card-role">${escapeHtml(contactLine(card))}</p>` : ''}
          </div>
          <button class="star-btn${card.favorite ? ' is-on' : ''}" data-star="${card.id}" type="button" aria-label="お気に入り切替" aria-pressed="${card.favorite}">★</button>
        </div>
        <div class="card-tags">${tags}${extra}</div>
        <div class="card-foot">
          <span class="card-contact">${escapeHtml(card.email || card.mobile || card.phone || '連絡先未登録')}</span>
          <span class="card-meta">${escapeHtml(relativeDate(card.updatedAt))}</span>
        </div>
      </article>`
    })
    .join('');
}

/* ---------------------------------------------------------------- */
/* detail drawer                                                    */
/* ---------------------------------------------------------------- */

function detailRow(label, value, href, copy) {
  if (!value) return '';
  const content = href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(value)}</a>`
    : `<span>${escapeHtml(value)}</span>`;
  return `
    <div class="detail-row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${content}${copy ? `<button class="copy-btn" data-copy="${escapeHtml(copy)}" type="button">コピー</button>` : ''}</dd>
    </div>`;
}

function openDetail(id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return;
  state.drawerId = id;

  const tone = toneFor(card.name + card.company);
  const tags = card.tags.map((t) => `<button class="tag tag-btn" data-filter-tag="${escapeHtml(t)}" type="button">#${escapeHtml(t)}</button>`).join('');

  $('#detail-content').innerHTML = `
    <header class="drawer-head">
      <button class="icon-btn" id="drawer-close" type="button" aria-label="閉じる">✕</button>
    </header>
    <div class="drawer-profile">
      <div class="avatar avatar-lg tone-${tone}" aria-hidden="true">${escapeHtml(initials(card.name))}</div>
      <h2>${escapeHtml(card.name)}</h2>
      <p class="drawer-kana">${escapeHtml(card.nameKana || '')}</p>
      <p class="drawer-company">${escapeHtml(card.company || '')}</p>
      <p class="drawer-role">${escapeHtml([card.department, card.position].filter(Boolean).join(' / '))}</p>
      <div class="drawer-quick">
        ${card.email ? `<a class="quick-btn" href="mailto:${escapeHtml(card.email)}" title="メールを送る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></a>` : ''}
        ${card.phone ? `<a class="quick-btn" href="tel:${escapeHtml(card.phone.replace(/[^0-9+]/g, ''))}" title="電話をかける"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 5 5L14 12l5 2v3a2 2 0 0 1-2.2 2A16 16 0 0 1 3 5.2 2 2 0 0 1 5 3Z"/></svg></a>` : ''}
        ${card.website ? `<a class="quick-btn" href="${escapeHtml(card.website)}" target="_blank" rel="noopener" title="Webサイトを開く"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg></a>` : ''}
      </div>
    </div>

    <div class="drawer-tags">${tags || '<span class="muted">タグなし</span>'}</div>

    <dl class="detail-list">
      ${detailRow('メール', card.email, card.email ? `mailto:${card.email}` : '', card.email)}
      ${detailRow('電話', card.phone, card.phone ? `tel:${card.phone.replace(/[^0-9+]/g, '')}` : '', card.phone)}
      ${detailRow('携帯', card.mobile, card.mobile ? `tel:${card.mobile.replace(/[^0-9+]/g, '')}` : '', card.mobile)}
      ${detailRow('Webサイト', card.website, card.website, card.website)}
      ${detailRow('住所', card.address, '', card.address)}
      ${detailRow('名刺交換日', card.metAt ? formatDate(card.metAt) : '', '', '')}
      ${detailRow('登録日', formatDate(card.createdAt), '', '')}
      ${detailRow('更新日', formatDate(card.updatedAt), '', '')}
    </dl>

    ${card.memo ? `<section class="drawer-memo"><h3>メモ</h3><p>${escapeHtml(card.memo)}</p></section>` : ''}

    <footer class="drawer-foot">
      <button class="btn btn-ghost" id="drawer-delete" type="button">削除</button>
      <button class="btn btn-primary" id="drawer-edit" type="button">編集する</button>
    </footer>
  `;

  els.drawerOverlay().hidden = false;
  els.drawer().classList.add('is-open');
  els.drawer().setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');
}

function closeDetail() {
  state.drawerId = null;
  els.drawer().classList.remove('is-open');
  els.drawer().setAttribute('aria-hidden', 'true');
  els.drawerOverlay().hidden = true;
  document.body.classList.remove('no-scroll');
}

/* ---------------------------------------------------------------- */
/* form modal                                                       */
/* ---------------------------------------------------------------- */

const FORM_FIELDS = ['name', 'nameKana', 'company', 'department', 'position', 'metAt', 'email', 'phone', 'mobile', 'website', 'address', 'tags', 'memo'];

function setFormValue(name, value) {
  const el = $(`#field-${name}`);
  if (el) el.value = value ?? '';
}

function openForm(card) {
  state.editingId = card ? card.id : null;
  $('#modal-title').textContent = card ? '名刺を編集' : '名刺を追加';
  $('#form-submit').textContent = card ? '更新する' : '保存する';
  $('#form-error').hidden = true;

  FORM_FIELDS.forEach((field) => setFormValue(field, card ? card[field] ?? '' : ''));
  if (!card) setFormValue('metAt', new Date().toISOString().slice(0, 10));
  setFormValue('tags', card ? card.tags.join(', ') : '');
  $('#field-favorite').checked = card ? Boolean(card.favorite) : false;

  els.modal().hidden = false;
  document.body.classList.add('no-scroll');
  setTimeout(() => $('#field-name').focus(), 60);
}

function closeForm() {
  state.editingId = null;
  els.modal().hidden = true;
  document.body.classList.remove('no-scroll');
}

async function submitForm(event) {
  event.preventDefault();
  const errorEl = $('#form-error');
  const submit = $('#form-submit');

  const payload = {
    name: $('#field-name').value.trim(),
    nameKana: $('#field-nameKana').value.trim(),
    company: $('#field-company').value.trim(),
    department: $('#field-department').value.trim(),
    position: $('#field-position').value.trim(),
    metAt: $('#field-metAt').value,
    email: $('#field-email').value.trim(),
    phone: $('#field-phone').value.trim(),
    mobile: $('#field-mobile').value.trim(),
    website: $('#field-website').value.trim(),
    address: $('#field-address').value.trim(),
    tags: $('#field-tags').value.split(/[,、]/).map((t) => t.trim()).filter(Boolean),
    memo: $('#field-memo').value.trim(),
    favorite: $('#field-favorite').checked,
  };

  if (!payload.name) {
    errorEl.textContent = '氏名は必須です';
    errorEl.hidden = false;
    $('#field-name').focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = '保存中…';
  try {
    if (state.editingId) {
      await api(`/api/cards/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('名刺を更新しました');
    } else {
      await api('/api/cards', { method: 'POST', body: JSON.stringify(payload) });
      toast('名刺を追加しました');
    }
    closeForm();
    await Promise.all([loadMeta(), loadCards()]);
    if (state.drawerId && state.editingId) openDetail(state.editingId);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = state.editingId ? '更新する' : '保存する';
  }
}

/* ---------------------------------------------------------------- */
/* actions                                                          */
/* ---------------------------------------------------------------- */

async function toggleFavorite(id, event) {
  event.stopPropagation();
  try {
    const res = await api(`/api/cards/${id}/favorite`, { method: 'PATCH' });
    const card = state.cards.find((c) => c.id === id);
    if (card) card.favorite = res.favorite;
    await Promise.all([loadMeta(), loadCards()]);
    toast(res.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCard(id) {
  if (!window.confirm('この名刺を削除します。よろしいですか？')) return;
  try {
    await api(`/api/cards/${id}`, { method: 'DELETE' });
    closeDetail();
    await Promise.all([loadMeta(), loadCards()]);
    toast('名刺を削除しました');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function resetFilters() {
  state.q = '';
  state.tag = '';
  state.company = '';
  state.favorite = false;
  els.search().value = '';
  renderSidebar();
  loadCards();
}

/* ---------------------------------------------------------------- */
/* AI assistant                                                     */
/* ---------------------------------------------------------------- */

function aiLog() {
  return $('#ai-log');
}

function appendMessage(role, html) {
  const log = aiLog();
  const div = document.createElement('div');
  div.className = `ai-msg ai-msg-${role}`;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function appendTyping() {
  return appendMessage(
    'bot',
    '<span class="ai-typing" aria-label="考え中"></span>'
  );
}

function openAi() {
  state.aiOpen = true;
  $('#ai-panel').classList.add('is-open');
  $('#ai-panel').setAttribute('aria-hidden', 'false');
  $('#ai-fab').setAttribute('aria-expanded', 'true');
  $('#ai-fab').classList.add('is-hidden');
  if (!aiLog().childElementCount) {
    appendMessage(
      'bot',
      'こんにちは。名刺の絞り込みをお手伝いします。<br>「広報部署だけまとめて」のように話しかけてください。'
    );
  }
  setTimeout(() => $('#ai-input')?.focus(), 120);
}

function closeAi() {
  state.aiOpen = false;
  $('#ai-panel').classList.remove('is-open');
  $('#ai-panel').setAttribute('aria-hidden', 'true');
  $('#ai-fab').setAttribute('aria-expanded', 'false');
  $('#ai-fab').classList.remove('is-hidden');
}

/** AI が返した filters を画面の状態に反映する */
function applyAiFilters(filters) {
  state.q = filters.q || '';
  state.tag = filters.tag || '';
  state.company = filters.company || '';
  state.department = filters.department || '';
  state.favorite = Boolean(filters.favorite);
  state.sort = filters.sort || 'updated';

  els.search().value = state.q;
  els.sort().value = state.sort;
  $('#sidebar').classList.remove('is-open');
  renderSidebar();
}

function describeFilters(f) {
  const parts = [];
  if (f.department) parts.push(`部署: ${escapeHtml(f.department)}`);
  if (f.company) parts.push(`会社: ${escapeHtml(f.company)}`);
  if (f.tag) parts.push(`タグ: #${escapeHtml(f.tag)}`);
  if (f.favorite) parts.push('お気に入りのみ');
  if (f.q) parts.push(`キーワード: ${escapeHtml(f.q)}`);
  if (f.sort === 'name') parts.push('あいうえお順');
  if (f.sort === 'company') parts.push('会社順');
  if (f.sort === 'met') parts.push('交換日の新しい順');
  return parts;
}

/* ---------------------------------------------------------------- */
/* AI assistant — 編集提案                                          */
/*                                                                  */
/* AI は「変更案」を返すだけ。ここでは差分を表示するだけで、実際の   */
/* 書き込みはユーザーが「適用する」を押したときだけ行う。            */
/* ---------------------------------------------------------------- */

let editSeq = 0;

/** 提案を state に退避し、DOM からはキーだけ参照させる */
function rememberProposal(kind, payload) {
  const key = `edit-${++editSeq}`;
  state.pendingEdits[key] = { kind, payload };
  return key;
}

function forgetProposal(key) {
  delete state.pendingEdits[key];
}

/** 長い値（メモなど）は差分表示用に詰める */
function clip(value, max = 120) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function diffRow(label, before, after) {
  return `<div class="ai-diff-row">
      <span class="ai-diff-label">${escapeHtml(label)}</span>
      <span class="ai-diff-before">${before ? escapeHtml(clip(before)) : '<em>（未設定）</em>'}</span>
      <span class="ai-diff-arrow" aria-hidden="true">→</span>
      <span class="ai-diff-after">${escapeHtml(clip(after))}</span>
    </div>`;
}

function renderFieldDiff(d) {
  return diffRow(d.label, d.before, d.after);
}

function renderPreviewBody(preview) {
  const rows = [];

  for (const d of preview.fieldDiffs || []) rows.push(renderFieldDiff(d));

  for (const tag of preview.tagsAdd || []) {
    rows.push(diffRow('タグ', '', `#${tag} を追加`));
  }
  for (const tag of preview.tagsRemove || []) {
    rows.push(diffRow('タグ', `#${tag}`, '削除'));
  }

  if (preview.favorite) {
    rows.push(
      diffRow(
        'お気に入り',
        preview.favorite.before ? 'オン' : 'オフ',
        preview.favorite.after ? 'オン' : 'オフ'
      )
    );
  }

  return rows.join('');
}

/** 適用 / キャンセル付きの提案カードを1件分描画する */
function appendProposal(preview, opts = {}) {
  const card = preview.card;
  const key = rememberProposal('update', { cardId: card.id, changes: opts.changes || {} });

  const html = `
    <div class="ai-proposal" data-proposal="${key}">
      <div class="ai-proposal-head">
        <span class="ai-proposal-badge">編集案</span>
        <span class="ai-proposal-target">${escapeHtml(card.name)}${
          card.company ? ` <small>${escapeHtml(card.company)}</small>` : ''
        }</span>
      </div>
      <div class="ai-diff">${renderPreviewBody(preview)}</div>
      <div class="ai-proposal-actions">
        <button class="btn btn-primary btn-sm" type="button" data-apply="${key}">適用する</button>
        <button class="btn btn-ghost btn-sm" type="button" data-cancel="${key}">キャンセル</button>
      </div>
      <p class="ai-note">適用するまで内容は保存されません。</p>
    </div>`;

  return appendMessage('bot', html);
}

/** 一括タグ操作の提案カード */
function appendBulkProposal(edit, opts = {}) {
  const bulk = edit.bulk;
  const key = rememberProposal('bulk_tag', {
    tagOp: { tag: bulk.tag, op: bulk.op },
    cardIds: opts.cardIds || bulk.affectedIds || [],
  });

  const verb = bulk.op === 'add' ? '付与' : '解除';
  const targets = (opts.cards || []).slice(0, 6).map(
    (c) => `<li><span>${escapeHtml(c.name)}</span><small>${escapeHtml(c.company || '')}</small></li>`
  ).join('');

  const html = `
    <div class="ai-proposal" data-proposal="${key}">
      <div class="ai-proposal-head">
        <span class="ai-proposal-badge">一括変更案</span>
        <span class="ai-proposal-target">#${escapeHtml(bulk.tag)} を${verb}</span>
      </div>
      <ul class="ai-target-list">${targets}</ul>
      <p class="ai-note">${
        (opts.cards || []).length > 6 ? `ほか ${(opts.cards || []).length - 6}件 / ` : ''
      }合計 <b>${(opts.cards || []).length}</b>件が対象です。</p>
      <div class="ai-proposal-actions">
        <button class="btn btn-primary btn-sm" type="button" data-apply="${key}">適用する</button>
        <button class="btn btn-ghost btn-sm" type="button" data-cancel="${key}">キャンセル</button>
      </div>
      <p class="ai-note">適用するまで内容は保存されません。</p>
    </div>`;

  return appendMessage('bot', html);
}

/** 対象が複数あったときの候補選択 UI */
function appendCandidatePicker(target, candidates, changes) {
  const key = rememberProposal('update', { cardId: null, changes });
  const items = candidates
    .map(
      (c) => `<button class="ai-candidate" type="button" data-pick="${key}" data-card="${c.id}">
        <span class="ai-candidate-name">${escapeHtml(c.name)}</span>
        <span class="ai-candidate-meta">${escapeHtml(c.company || '—')}${c.department ? ` / ${escapeHtml(c.department)}` : ''}</span>
      </button>`
    )
    .join('');

  const who = [target.name, target.company].filter(Boolean).map(escapeHtml).join(' / ');
  const el = appendMessage(
    'bot',
    `<p>「${who}」に該当する名刺が複数あります。どの名刺を編集しますか？</p>
     <div class="ai-candidates">${items}</div>`
  );
  // 選択後に picker 自体を片付けられるよう、キーを親にも持たせる
  el.dataset.proposal = key;
  return el;
}

/** 提案を閉じて「適用済み」の見た目にする */
function markProposalDone(el, message) {
  if (!el) return;
  el.classList.add('is-done');
  const actions = el.querySelector('.ai-proposal-actions');
  if (actions) actions.remove();
  const note = el.querySelector('.ai-note');
  if (note) note.textContent = message;
}

async function applyProposal(key) {
  const pending = state.pendingEdits[key];
  if (!pending) return;

  const el = document.querySelector(`[data-proposal="${key}"]`);
  const buttons = el ? Array.from(el.querySelectorAll('button')) : [];
  buttons.forEach((b) => { b.disabled = true; });

  try {
    const res = await api('/api/assistant/apply', {
      method: 'POST',
      body: JSON.stringify(
        pending.kind === 'bulk_tag'
          ? { mode: 'bulk_tag', tagOp: pending.payload.tagOp, cardIds: pending.payload.cardIds }
          : { mode: 'update', cardId: pending.payload.cardId, changes: pending.payload.changes }
      ),
    });

    if (pending.kind === 'bulk_tag') {
      toast(`#${res.tag} を${res.op === 'add' ? '付与' : '解除'}しました（${res.updated}件）`);
      if (el) {
        el.classList.add('is-done');
        const actions = el.querySelector('.ai-proposal-actions');
        if (actions) actions.remove();
        const note = el.querySelector('.ai-note');
        if (note) note.textContent = `適用しました（${res.updated}件）。`;
      }
    } else if (res.changed) {
      toast('名刺を更新しました');
      markProposalDone(el, '適用しました。');
      if (state.drawerId === res.card.id) openDetail(res.card.id);
    } else {
      toast('変更はありませんでした', 'error');
      markProposalDone(el, '変更はありませんでした。');
    }

    forgetProposal(key);
    await Promise.all([loadMeta(), loadCards()]);
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    appendMessage('bot', `<p class="ai-error">${escapeHtml(err.message)}</p>`);
  }
}

async function cancelProposal(key) {
  const pending = state.pendingEdits[key];
  const el = document.querySelector(`[data-proposal="${key}"]`);
  forgetProposal(key);
  if (el) {
    el.classList.add('is-cancelled');
    const actions = el.querySelector('.ai-proposal-actions');
    if (actions) actions.remove();
    const note = el.querySelector('.ai-note');
    if (note) note.textContent = 'キャンセルしました。内容は変更していません。';
  }
  if (pending) toast('キャンセルしました');
}

/** 候補を選んだら、その名刺で差分を作り直す */
async function pickCandidate(key, cardId) {
  const pending = state.pendingEdits[key];
  if (!pending) return;

  try {
    const res = await api('/api/assistant/apply', {
      method: 'POST',
      body: JSON.stringify({ mode: 'update', cardId, changes: pending.payload.changes, dryRun: true }),
    });

    const picker = document.querySelector(`[data-proposal="${key}"]`);
    if (picker) picker.classList.add('is-done');
    forgetProposal(key);

    if (!res.preview.hasChange) {
      appendMessage('bot', '<p>この名刺には変更点がありませんでした。</p>');
      return;
    }
    // appendProposal が新しいキーで提案を作り直す
    appendProposal(res.preview, { changes: pending.payload.changes });
  } catch (err) {
    appendMessage('bot', `<p class="ai-error">${escapeHtml(err.message)}</p>`);
  }
}

async function askAssistant(text) {
  if (state.aiBusy || !text.trim()) return;
  state.aiBusy = true;
  $('#ai-send').disabled = true;

  appendMessage('user', escapeHtml(text));
  const typing = appendTyping();

  try {
    const res = await api('/api/assistant', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    typing.remove();

    if (res.intent === 'answer' && res.answer) {
      const depts = (res.answer.departments || [])
        .map((d) => `<li><span>${escapeHtml(d.department)}</span><b>${d.n}件</b></li>`)
        .join('');
      appendMessage(
        'bot',
        `<p>名刺は全部で <b>${res.answer.total}件</b>、お気に入りは <b>${res.answer.favorites}件</b>です。</p>` +
          (depts ? `<ul class="ai-stats">${depts}</ul>` : '')
      );
      return;
    }

    if (res.intent === 'export') {
      appendMessage(
        'bot',
        `<p>${escapeHtml(res.message || 'CSVを出力します。')}</p><p class="ai-note">全${res.total}件を書き出します。</p>`
      );
      window.location.href = res.exportUrl || '/api/export.csv';
      return;
    }

    if (res.intent === 'help') {
      const items = (res.help || []).map((h) => `<li>${escapeHtml(h)}</li>`).join('');
      appendMessage('bot', `<p>${escapeHtml(res.message || 'こんなことができます。')}</p><ul class="ai-stats">${items}</ul>`);
      return;
    }

    /* --- 1件の編集提案 --- */
    if (res.intent === 'update') {
      const edit = res.edit || {};

      if (edit.status === 'no-target') {
        appendMessage(
          'bot',
          '<p>どの名刺を編集するか特定できませんでした。「鈴木さんの部署を営業本部に変えて」のように、氏名や会社名を入れてください。</p>'
        );
        return;
      }

      if (edit.status === 'not-found') {
        const who = [res.target?.name, res.target?.company].filter(Boolean).map(escapeHtml).join(' / ');
        appendMessage('bot', `<p>「${who}」に一致する名刺が見つかりませんでした。</p>`);
        return;
      }

      if (edit.status === 'ambiguous') {
        appendCandidatePicker(res.target || {}, edit.candidates || res.cards || [], res.changes || {});
        return;
      }

      if (edit.status === 'no-change') {
        appendMessage('bot', `<p>${escapeHtml(res.message || '変更点はありませんでした。')}</p><p class="ai-note">すでに同じ内容になっています。</p>`);
        return;
      }

      appendMessage('bot', `<p>${escapeHtml(res.message || 'この内容で書き換えます。')}</p>`);
      appendProposal(edit.preview, { changes: res.changes || {} });
      return;
    }

    /* --- 複数件へのタグ一括操作 --- */
    if (res.intent === 'bulk_tag') {
      const edit = res.edit || {};

      if (edit.status === 'no-tag') {
        appendMessage('bot', '<p>付けるタグが特定できませんでした。「広報の人に『展示会』タグを付けて」のように指定してください。</p>');
        return;
      }

      if (edit.status !== 'ready') {
        appendMessage('bot', '<p>条件に合う名刺がないか、すでにすべて同じ状態でした。</p>');
        return;
      }

      appendMessage('bot', `<p>${escapeHtml(res.message || 'まとめて変更します。')}</p>`);
      appendBulkProposal(edit, { cards: res.cards || [] });
      return;
    }

    // filter
    applyAiFilters(res.filters);
    await Promise.all([loadMeta(), loadCards()]);

    const chips = describeFilters(res.filters)
      .map((p) => `<span class="ai-chip">${p}</span>`)
      .join('');

    appendMessage(
      'bot',
      `<p>${escapeHtml(res.message || '条件に合う名刺を表示します。')}</p>` +
        (chips ? `<div class="ai-chips">${chips}</div>` : '') +
        `<p class="ai-note">${res.total}件 見つかりました${res.source === 'fallback' ? '（簡易判定）' : ''}</p>`
    );

    // モバイルではパネルを閉じて結果を見せる
    if (window.innerWidth < 720) closeAi();
  } catch (err) {
    typing.remove();
    appendMessage('bot', `<p class="ai-error">${escapeHtml(err.message)}</p>`);
  } finally {
    state.aiBusy = false;
    $('#ai-send').disabled = false;
  }
}

/* ---------------------------------------------------------------- */
/* CSV import                                                       */
/* ---------------------------------------------------------------- */

/**
 * CSV の文字コードを判定して読む。
 * 日本語版 Excel の「CSV保存」は Shift_JIS が既定なので、
 * UTF-8 として読んで壊れていたら Shift_JIS で読み直す。
 */
function decodeCsv(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const broken = (utf8.match(/\uFFFD/g) || []).length;
  if (broken === 0) return { text: utf8, encoding: 'UTF-8' };

  try {
    const sjis = new TextDecoder('shift_jis').decode(buffer);
    const brokenSjis = (sjis.match(/\uFFFD/g) || []).length;
    if (brokenSjis < broken) return { text: sjis, encoding: 'Shift_JIS' };
  } catch {
    /* TextDecoder が shift_jis 非対応の環境ではUTF-8のまま */
  }
  return { text: utf8, encoding: 'UTF-8' };
}

function openImport() {
  $('#import-backdrop').hidden = false;
  state.importRows = [];
  $('#import-result').hidden = true;
  $('#import-error').hidden = true;
  $('#import-commit').disabled = true;
  $('#file-input').value = '';
  document.body.classList.add('no-scroll');
}

function closeImport() {
  $('#import-backdrop').hidden = true;
  document.body.classList.remove('no-scroll');
}

function renderImportPreview(data, fileName) {
  const stats = data.stats || {};
  const rows = data.rows || [];

  $('#import-stats').innerHTML = `
    <div class="stat"><span>ファイル</span><b>${escapeHtml(fileName)}</b></div>
    <div class="stat"><span>読み取り</span><b>${stats.total || 0}件</b></div>
    <div class="stat stat-new"><span>新規</span><b>${stats.newCount || 0}件</b></div>
    <div class="stat stat-dup"><span>重複</span><b>${stats.duplicateCount || 0}件</b></div>
    ${stats.errorCount ? `<div class="stat stat-err"><span>スキップ</span><b>${stats.errorCount}件</b></div>` : ''}
  `;

  // どの列をどう解釈したかを可視化する（取り込み前の確認になる）
  const mapped = Object.entries(data.mapping || {})
    .map(([field, header]) => `<span class="map-chip">${escapeHtml(header)} → ${escapeHtml(field)}</span>`)
    .join('');

  const preview = rows.slice(0, 30);
  const body = preview
    .map(
      (r) => `<tr class="${r.duplicate ? 'is-dup' : ''}">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.company || '—')}</td>
        <td>${escapeHtml(r.department || '—')}</td>
        <td>${escapeHtml(r.email || '—')}</td>
        <td>${r.duplicate ? '<span class="badge badge-dup">重複</span>' : '<span class="badge badge-new">新規</span>'}</td>
      </tr>`
    )
    .join('');

  $('#import-table').innerHTML = `
    <thead><tr><th>氏名</th><th>会社</th><th>部署</th><th>メール</th><th>判定</th></tr></thead>
    <tbody>${body}</tbody>
  `;

  $('#import-result').hidden = false;
  if (mapped) {
    $('#import-result').insertAdjacentHTML(
      'afterbegin',
      `<div class="map-list"><p class="map-title">列の対応</p>${mapped}</div>`
    );
  }

  state.importRows = rows;
  $('#import-commit').disabled = rows.length === 0;
}

async function handleImportFile(file) {
  if (!file) return;
  const errEl = $('#import-error');
  errEl.hidden = true;

  if (file.size > 2 * 1024 * 1024) {
    errEl.textContent = 'ファイルが大きすぎます（2MBまで）';
    errEl.hidden = false;
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const { text, encoding } = decodeCsv(buffer);

    const res = await fetch('/api/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: text,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'プレビューの作成に失敗しました');

    if (!data.rows.length) {
      errEl.textContent = data.error || '取り込める行がありませんでした';
      errEl.hidden = false;
      return;
    }

    renderImportPreview(data, `${file.name}（${encoding}）`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

async function commitImport() {
  const btn = $('#import-commit');
  const errEl = $('#import-error');
  btn.disabled = true;
  btn.textContent = '取り込み中…';

  try {
    const res = await api('/api/import/commit', {
      method: 'POST',
      body: JSON.stringify({
        rows: state.importRows,
        skipDuplicates: $('#skip-duplicates').checked,
      }),
    });
    closeImport();
    await Promise.all([loadMeta(), loadCards()]);
    toast(`${res.inserted}件を取り込みました${res.skipped ? `（${res.skipped}件スキップ）` : ''}`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '取り込む';
  }
}

/* ---------------------------------------------------------------- */
/* events                                                           */
/* ---------------------------------------------------------------- */

function bindEvents() {
  els.search().addEventListener(
    'input',
    debounce((event) => {
      state.q = event.target.value.trim();
      loadCards();
    })
  );

  els.sort().addEventListener('change', (event) => {
    state.sort = event.target.value;
    loadCards();
  });

  // 絞り込み条件は排他。同時に有効にすると「何で絞られているか」が見出しと
  // 一致しなくなるため、切り替え時は他の条件を必ず解除する。
  $$('.side-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.filter === 'favorite') {
        state.favorite = !state.favorite;
      } else {
        state.favorite = false;
      }
      state.tag = '';
      state.company = '';
      renderSidebar();
      loadCards();
    });
  });

  els.tagFilters().addEventListener('click', (event) => {
    const btn = event.target.closest('[data-tag]');
    if (!btn) return;
    state.tag = state.tag === btn.dataset.tag ? '' : btn.dataset.tag;
    state.company = '';
    state.department = '';
    state.favorite = false;
    renderSidebar();
    loadCards();
  });

  els.companyFilters().addEventListener('click', (event) => {
    const btn = event.target.closest('[data-company]');
    if (!btn) return;
    state.company = state.company === btn.dataset.company ? '' : btn.dataset.company;
    state.tag = '';
    state.department = '';
    state.favorite = false;
    renderSidebar();
    loadCards();
  });

  els.deptFilters().addEventListener('click', (event) => {
    const btn = event.target.closest('[data-dept]');
    if (!btn) return;
    state.department = state.department === btn.dataset.dept ? '' : btn.dataset.dept;
    state.tag = '';
    state.company = '';
    state.favorite = false;
    renderSidebar();
    loadCards();
  });

  els.grid().addEventListener('click', (event) => {
    const star = event.target.closest('[data-star]');
    if (star) {
      toggleFavorite(Number(star.dataset.star), event);
      return;
    }
    const card = event.target.closest('.card');
    if (card) openDetail(Number(card.dataset.id));
  });

  els.grid().addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.card');
    if (!card) return;
    event.preventDefault();
    openDetail(Number(card.dataset.id));
  });

  $('#new-card-btn').addEventListener('click', () => openForm(null));
  $('#empty-add-btn').addEventListener('click', () => openForm(null));
  $('#export-btn').addEventListener('click', () => {
    window.location.href = '/api/export.csv';
  });

  $('#modal-close').addEventListener('click', closeForm);
  $('#modal-cancel').addEventListener('click', closeForm);
  els.modal().addEventListener('click', (event) => {
    if (event.target === els.modal()) closeForm();
  });
  els.form().addEventListener('submit', submitForm);

  els.drawerOverlay().addEventListener('click', closeDetail);

  $('#detail-drawer').addEventListener('click', (event) => {
    const close = event.target.closest('#drawer-close');
    if (close) { closeDetail(); return; }

    const edit = event.target.closest('#drawer-edit');
    if (edit && state.drawerId) {
      const card = state.cards.find((c) => c.id === state.drawerId);
      if (card) openForm(card);
      return;
    }

    const del = event.target.closest('#drawer-delete');
    if (del && state.drawerId) { deleteCard(state.drawerId); return; }

    const tagBtn = event.target.closest('[data-filter-tag]');
    if (tagBtn) {
      state.tag = tagBtn.dataset.filterTag;
      state.company = '';
      state.favorite = false;
      closeDetail();
      renderSidebar();
      loadCards();
      return;
    }

    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.dataset.copy).then(
        () => toast('コピーしました'),
        () => toast('コピーできませんでした', 'error')
      );
    }
  });

  $('#filter-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('is-open');
  });

  /* ---- AI assistant ---- */
  $('#ai-fab').addEventListener('click', () => {
    if (state.aiOpen) closeAi();
    else openAi();
  });
  $('#ai-close').addEventListener('click', closeAi);

  $('#ai-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#ai-input');
    const text = input.value.trim();
    input.value = '';
    askAssistant(text);
  });

  $('#ai-suggest').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-suggest]');
    if (!btn) return;
    askAssistant(btn.dataset.suggest);
  });

  // 編集提案の操作は動的に増えるので、ログ全体で委譲して受ける
  $('#ai-log').addEventListener('click', (event) => {
    const applyBtn = event.target.closest('[data-apply]');
    if (applyBtn) {
      applyProposal(applyBtn.dataset.apply);
      return;
    }
    const cancelBtn = event.target.closest('[data-cancel]');
    if (cancelBtn) {
      cancelProposal(cancelBtn.dataset.cancel);
      return;
    }
    const pickBtn = event.target.closest('[data-pick]');
    if (pickBtn) {
      pickCandidate(pickBtn.dataset.pick, Number(pickBtn.dataset.card));
    }
  });

  /* ---- CSV import ---- */
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');

  $('#import-btn').addEventListener('click', openImport);
  $('#import-close').addEventListener('click', closeImport);
  $('#import-cancel').addEventListener('click', closeImport);
  $('#import-backdrop').addEventListener('click', (event) => {
    if (event.target === $('#import-backdrop')) closeImport();
  });
  $('#import-commit').addEventListener('click', commitImport);

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    handleImportFile(file);
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-drag');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-drag');
    });
  });
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleImportFile(file);
  });

  document.addEventListener('keydown', (event) => {
    const tag = (event.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

    if (event.key === 'Escape') {
      if (!els.modal().hidden) { closeForm(); return; }
      if (els.drawer().classList.contains('is-open')) { closeDetail(); return; }
      if ($('#sidebar').classList.contains('is-open')) $('#sidebar').classList.remove('is-open');
      return;
    }
    if (typing) return;
    if (event.key === '/') {
      event.preventDefault();
      els.search().focus();
    } else if (event.key === 'n') {
      event.preventDefault();
      openForm(null);
    }
  });
}

/* ---------------------------------------------------------------- */
/* boot                                                             */
/* ---------------------------------------------------------------- */

async function boot() {
  bindEvents();
  await loadMeta();
  await loadCards();
}

boot();
