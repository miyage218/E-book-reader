'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =========================================================
   Depolama (IndexedDB)
   books : kitap bilgisi + okuma konumu
   files : PDF dosyasının kendisi
   texts : PDF'ten çıkarılmış metin (bir kez hesaplanır)
   ========================================================= */
let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('kindle-reader', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['books', 'files', 'texts']) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    const req = fn(t.objectStore(store));
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idb = {
  get: (s, k) => tx(s, 'readonly', (st) => st.get(k)),
  all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
  del: (s, k) => tx(s, 'readwrite', (st) => st.delete(k)),
};

/* =========================================================
   Ayarlar
   ========================================================= */
const DEFAULTS = { font: 'literata', size: 19, lh: '1.6', margin: 'md', theme: 'paper', justify: 'true' };
const FONTS = {
  literata: "'Literata', Georgia, serif",
  georgia: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};
const MARGINS = { sm: 16, md: 28, lg: 44 };
const THEME_COLORS = { white: '#ffffff', paper: '#f4f1ea', sepia: '#f2e8d3', dark: '#121212' };

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('reader-settings') || '{}')); } catch (e) { /* yok say */ }
function saveSettings() {
  try { localStorage.setItem('reader-settings', JSON.stringify(settings)); } catch (e) { /* yok say */ }
}
function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--rfont', FONTS[settings.font] || FONTS.literata);
  root.style.setProperty('--rsize', settings.size + 'px');
  root.style.setProperty('--rlh', settings.lh);
  root.style.setProperty('--m', MARGINS[settings.margin] + 'px');
  $('#flow').classList.toggle('justify', settings.justify === 'true');
  $('meta[name=theme-color]').setAttribute('content', THEME_COLORS[settings.theme]);
}

/* =========================================================
   Yardımcılar
   ========================================================= */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function fmtMinutes(min) {
  min = Math.max(1, Math.round(min));
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}
function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} saat önce`;
  if (s < 86400 * 2) return 'dün';
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} gün önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}
function fmtBytes(b) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const CHARS_PER_MIN = 1100; // ortalama okuma hızı (~220 kelime/dk)

/* =========================================================
   Kitaplık
   ========================================================= */
function bookStats(b) {
  const pct = Math.round((b.progress || 0) * 100);
  const cur = b.pdfPage || 1;
  const left = Math.max(0, (b.numPages || 0) - cur);
  const done = (b.progress || 0) >= 0.995;
  return { pct, left, done, started: !!b.lastReadAt };
}

function coverHtml(b) {
  return `<div class="cover">${b.cover ? `<img src="${b.cover}" alt="">` : `<span class="ph">${esc((b.title || '?')[0])}</span>`}</div>`;
}

async function renderLibrary() {
  const books = (await idb.all('books')).sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  const list = $('#bookList');
  $('#empty').hidden = books.length > 0;
  $('#libSub').textContent = books.length ? `Tüm kitaplar · ${books.length}` : '';

  const last = books.find((b) => b.lastReadAt && !bookStats(b).done);
  const cont = $('#continue');
  if (last) {
    const st = bookStats(last);
    cont.innerHTML = `
      <div class="continue-card" data-id="${esc(last.id)}">
        ${coverHtml(last)}
        <div class="info">
          <div class="eyebrow">Okumaya devam et</div>
          <h2>${esc(last.title)}</h2>
          <div class="pbar"><i style="width:${st.pct}%"></i></div>
          <div class="meta"><b>%${st.pct}</b> · ${st.left} sayfa kaldı</div>
          <span class="go">Devam et</span>
        </div>
      </div>`;
  } else {
    cont.innerHTML = '';
  }

  list.innerHTML = books.map((b) => {
    const st = bookStats(b);
    let meta;
    if (st.done) meta = `<span class="badge">Okundu</span> · ${b.numPages} sayfa`;
    else if (!st.started) meta = `<span class="badge">Yeni</span> · ${b.numPages} sayfa`;
    else meta = `<b>%${st.pct}</b> okundu · <b>${st.left}</b> sayfa kaldı`;
    return `
      <li class="book" data-id="${esc(b.id)}">
        ${coverHtml(b)}
        <div class="info">
          <h3>${esc(b.title)}</h3>
          <div class="pbar"><i style="width:${st.pct}%"></i></div>
          <div class="meta">${meta}</div>
          ${b.lastReadAt ? `<div class="meta">Son okuma: ${timeAgo(b.lastReadAt)}</div>` : ''}
        </div>
        <button class="icon-btn more" data-more="${esc(b.id)}" aria-label="Seçenekler">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </li>`;
  }).join('');

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      $('#storageInfo').textContent = books.length ? `Kullanılan alan: ${fmtBytes(est.usage || 0)}` : '';
    }
  } catch (e) { /* yok say */ }
}

async function renderCover(doc) {
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 220 / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c.toDataURL('image/jpeg', 0.72);
  } catch (e) {
    return null;
  }
}

async function importFiles(files) {
  const pdfs = [...files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Lütfen PDF dosyası seçin'); return; }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* yok say */ }

  const existing = await idb.all('books');
  let added = 0;
  for (const f of pdfs) {
    const id = `${f.name}::${f.size}`;
    if (existing.some((b) => b.id === id)) { toast(`“${f.name}” zaten kitaplıkta`); continue; }
    toast(`Ekleniyor: ${f.name}`, 60000);
    try {
      const buf = await f.arrayBuffer();
      const blob = new Blob([buf], { type: 'application/pdf' });
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      const cover = await renderCover(doc);
      const title = f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
      await idb.put('files', { id, blob });
      await idb.put('books', {
        id, title, fileName: f.name, size: f.size, numPages: doc.numPages, cover,
        addedAt: Date.now(), lastReadAt: 0, progress: 0, pdfPage: 1, pos: null, mode: null,
      });
      doc.destroy();
      added++;
    } catch (e) {
      console.error(e);
      toast(`“${f.name}” açılamadı (bozuk ya da şifreli olabilir)`, 4000);
    }
  }
  if (added) toast(added === 1 ? 'Kitap eklendi' : `${added} kitap eklendi`);
  renderLibrary();
}

/* ---- Kitap işlemleri (sil, yeniden adlandır, sıfırla) ---- */
let actionBookId = null;
async function openActions(id) {
  const b = await idb.get('books', id);
  if (!b) return;
  actionBookId = id;
  $('#asTitle').textContent = b.title;
  openSheet('#actionSheet');
}
async function runAction(act) {
  const id = actionBookId;
  closeSheets();
  const b = id && await idb.get('books', id);
  if (!b || act === 'cancel') return;
  if (act === 'rename') {
    const name = prompt('Kitabın adı', b.title);
    if (name && name.trim()) { b.title = name.trim(); await idb.put('books', b); }
  } else if (act === 'reset') {
    Object.assign(b, { progress: 0, pdfPage: 1, pos: null, lastReadAt: 0 });
    await idb.put('books', b);
  } else if (act === 'delete') {
    if (!confirm(`“${b.title}” kitaplıktan silinsin mi?`)) return;
    await idb.del('books', id);
    await idb.del('files', id);
    await idb.del('texts', id);
    toast('Kitap silindi');
  }
  renderLibrary();
}

/* =========================================================
   PDF'ten metin çıkarma (Kindle benzeri yeniden akış için)
   ========================================================= */
const END_RE = /[.!?:;…]["'”’»)\]]*$/;
const UPPER_START = /^[A-ZÇĞİÖŞÜÂÎÛ0-9"“«'‘(\[—–-]/;
const LOWER_START = /^[a-zçğıöşüâîû]/;
const PAGE_NO_RE = /^[-–—\s]*(sayfa|page|s\.)?\s*[0-9ivxlc]{1,5}[-–—\s]*$/i;

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

async function extractPage(page) {
  const tc = await page.getTextContent();
  const lines = [];
  let cur = null;
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4], y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    const s = it.str;
    if (cur && Math.abs(y - cur.y) > Math.max(h, cur.h) * 0.6) { lines.push(cur); cur = null; }
    if (!cur) {
      if (!s.trim()) continue;
      cur = { t: '', x, y, h, end: x };
    }
    if (s) {
      if (cur.t && x - cur.end > h * 0.18 && !/\s$/.test(cur.t) && !/^\s/.test(s)) cur.t += ' ';
      cur.t += s;
      cur.end = Math.max(cur.end, x + (it.width || 0));
      cur.h = Math.max(cur.h, h);
    }
    if (it.hasEOL) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);

  let ls = lines
    .map((l) => ({ ...l, t: l.t.replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.t);
  // sayfa numaralarını at
  if (ls.length && PAGE_NO_RE.test(ls[0].t)) ls.shift();
  if (ls.length && PAGE_NO_RE.test(ls[ls.length - 1].t)) ls.pop();
  if (!ls.length) return [];

  const gaps = [];
  for (let i = 1; i < ls.length; i++) {
    const g = ls[i - 1].y - ls[i].y;
    if (g > 0) gaps.push(g);
  }
  const med = median(gaps) || ls[0].h * 1.2;
  const baseX = quantile(ls.map((l) => l.x), 0.2);
  const fullW = quantile(ls.map((l) => l.end - l.x), 0.85);
  const bodyH = median(ls.map((l) => l.h));

  const paras = [];
  let p = null;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (!p) { p = { t: l.t, h: l.h }; continue; }
    const prev = ls[i - 1];
    const g = prev.y - l.y;
    const prevShort = prev.end - prev.x < fullW * 0.8;
    const ends = END_RE.test(prev.t);
    const indented = l.x > baseX + l.h * 0.8;
    const sizeChange = Math.abs(l.h - prev.h) > bodyH * 0.25;
    const brk =
      g > med * 1.45 ||
      sizeChange ||
      (ends && prevShort) ||
      (ends && indented) ||
      (prevShort && UPPER_START.test(l.t) && g > 0);
    if (brk) {
      paras.push(p);
      p = { t: l.t, h: l.h };
    } else if (/[A-Za-zçğıöşüÇĞİÖŞÜ]-$/.test(p.t) && LOWER_START.test(l.t)) {
      p.t = p.t.slice(0, -1) + l.t; // satır sonu tirelemesini birleştir
    } else {
      p.t += ' ' + l.t;
    }
  }
  if (p) paras.push(p);

  return paras.map((q) => {
    const head = q.t.length < 80 && !END_RE.test(q.t) &&
      (q.h > bodyH * 1.2 || /^(bölüm|kısım|chapter|part|önsöz|giriş|sonsöz)\b/i.test(q.t) ||
        (q.t === q.t.toLocaleUpperCase('tr') && /[A-ZÇĞİÖŞÜ]/.test(q.t) && q.t.length > 2));
    return head ? '#' + q.t : q.t; // '#' ile başlayan = başlık
  });
}

async function extractText(doc, onProgress) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      pages.push(await extractPage(page));
      page.cleanup();
    } catch (e) {
      pages.push([]);
    }
    if (i % 3 === 0 || i === doc.numPages) onProgress(i / doc.numPages);
  }
  return pages;
}

function buildParas(pages) {
  const paras = [];
  let o = 0;
  pages.forEach((list, pi) => {
    list.forEach((raw, k) => {
      const head = raw[0] === '#';
      const t = head ? raw.slice(1) : raw;
      const prev = paras[paras.length - 1];
      // sayfa sınırında bölünmüş paragrafı birleştir
      if (k === 0 && prev && !prev.h && !head && !END_RE.test(prev.t) && LOWER_START.test(t)) {
        const joined = /[A-Za-zçğıöşü]-$/.test(prev.t) ? prev.t.slice(0, -1) + t : prev.t + ' ' + t;
        o += joined.length - prev.t.length;
        prev.t = joined;
        return;
      }
      paras.push({ t, p: pi + 1, o, h: head });
      o += t.length;
    });
  });
  return { paras, total: Math.max(1, o) };
}

function buildSections(paras) {
  const secs = [];
  let start = 0, chars = 0;
  for (let i = 0; i < paras.length; i++) {
    chars += paras[i].t.length;
    const nextIsHead = paras[i + 1] && paras[i + 1].h;
    if (chars > 24000 || (chars > 9000 && nextIsHead)) {
      secs.push({ start, end: i + 1 });
      start = i + 1;
      chars = 0;
    }
  }
  if (start < paras.length || !secs.length) secs.push({ start, end: paras.length });
  return secs;
}

/* =========================================================
   Okuyucu
   ========================================================= */
const R = {
  book: null, doc: null, mode: 'text',
  paras: [], total: 1, secs: [], sec: -1, page: 0, pages: 1, step: 1,
  pdfPage: 1, renderTask: null, outline: null, menu: false,
};

const flow = $('#flow');
const pageview = $('#pageview');

function showLoading(text, frac) {
  $('#loading').hidden = false;
  $('#loadingText').textContent = text;
  $('#loadingBar').style.width = frac == null ? '0' : `${Math.round(frac * 100)}%`;
  $('.lbar').style.visibility = frac == null ? 'hidden' : 'visible';
}
const hideLoading = () => { $('#loading').hidden = true; };

async function openBook(id, push = true) {
  const book = await idb.get('books', id);
  const file = await idb.get('files', id);
  if (!book || !file) { toast('Kitap bulunamadı'); return; }

  $('#library').hidden = true;
  $('#reader').hidden = false;
  if (push) history.pushState({ reader: id }, '', '#oku');
  hideMenu();
  showLoading('Açılıyor…');

  try {
    const buf = await file.blob.arrayBuffer();
    R.doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch (e) {
    console.error(e);
    hideLoading();
    toast('PDF açılamadı');
    closeReader();
    return;
  }
  R.book = book;
  R.outline = null;
  R.paras = [];
  R.sec = -1;
  book.lastReadAt = Date.now();
  $('#mTitle').textContent = book.title;
  $('#slider').max = book.numPages;

  let mode = book.mode || 'text';
  if (mode === 'text') {
    const ok = await loadText();
    if (!ok) {
      mode = 'page';
      if (!book.mode) toast('Bu PDF taranmış görünüyor; orijinal sayfa görünümünde açıldı', 4500);
    }
  }
  await setMode(mode, book.pos != null && mode === 'text' ? { o: book.pos } : { page: book.pdfPage || 1 });
  hideLoading();
  saveNow();
}

async function loadText() {
  if (R.paras.length) return true;
  const id = R.book.id;
  let rec = await idb.get('texts', id);
  if (!rec) {
    showLoading('Kitap hazırlanıyor…', 0);
    const pages = await extractText(R.doc, (f) => showLoading('Kitap hazırlanıyor…', f));
    rec = { id, pages };
    try { await idb.put('texts', rec); } catch (e) { /* yer yoksa önemli değil */ }
  }
  const { paras, total } = buildParas(rec.pages);
  // neredeyse hiç metin yoksa taranmış PDF'tir
  if (total < R.book.numPages * 25 || !paras.length) return false;
  R.paras = paras;
  R.total = total;
  R.secs = buildSections(paras);
  return true;
}

async function setMode(mode, target) {
  R.mode = mode;
  document.body.classList.toggle('page-mode', mode === 'page');
  $('#pageview').hidden = mode !== 'text';
  $('#rfoot').style.left = $('#rfoot').style.right = mode === 'page' ? '16px' : '';
  $('#pdfview').hidden = mode !== 'page';
  syncSettingsUi();
  if (mode === 'text') {
    try { await Promise.all(['400', '600', 'italic 400'].map((w) => document.fonts.load(`${w} 16px Literata`))); } catch (e) { /* yok say */ }
    await document.fonts.ready;
    const o = target.o != null ? target.o : offsetForPdfPage(target.page || 1);
    gotoOffset(o);
  } else {
    await renderPdfPage(target.page || 1);
  }
}

/* ---------- Metin görünümü ---------- */
function paraIndexForOffset(o) {
  const ps = R.paras;
  let lo = 0, hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid].o <= o) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function offsetForPdfPage(n) {
  const i = R.paras.findIndex((p) => p.p >= n);
  return i < 0 ? R.paras[R.paras.length - 1].o : R.paras[i].o;
}
function secForPara(i) {
  return R.secs.findIndex((s) => i >= s.start && i < s.end);
}

function layoutSection(si) {
  const s = R.secs[si];
  const frag = document.createDocumentFragment();
  let afterHead = true;
  for (let i = s.start; i < s.end; i++) {
    const pr = R.paras[i];
    const el = document.createElement('p');
    el.dataset.i = i;
    el.textContent = pr.t;
    if (pr.h) el.className = 'head';
    else if (afterHead) el.className = 'first';
    afterHead = pr.h;
    frag.appendChild(el);
  }
  if (si === R.secs.length - 1) {
    const end = document.createElement('p');
    end.className = 'book-end';
    end.textContent = '— Son —';
    frag.appendChild(end);
  }
  const last = frag.lastChild;
  const sentinel = document.createElement('span');
  sentinel.className = 'end';
  last.appendChild(sentinel);

  flow.innerHTML = '';
  flow.style.transform = 'translateX(0)';
  const W = pageview.clientWidth;
  const gap = MARGINS[settings.margin] * 2;
  flow.style.columnWidth = W + 'px';
  flow.style.columnGap = gap + 'px';
  flow.appendChild(frag);
  R.step = W + gap;
  R.sec = si;
  const fr = flow.getBoundingClientRect();
  const sr = sentinel.getBoundingClientRect();
  R.pages = Math.max(1, Math.floor((sr.left - fr.left + 1) / R.step) + 1);
}

function pageOfRect(rect) {
  const fr = flow.getBoundingClientRect();
  return Math.floor((rect.left - fr.left + 2) / R.step);
}

function gotoOffset(o) {
  if (!R.paras.length) return;
  o = Math.max(0, Math.min(o, R.total - 1));
  const pi = paraIndexForOffset(o);
  const si = secForPara(pi);
  if (si !== R.sec) layoutSection(si);
  else showPage(0, false); // dönüşümü sıfırla, ölçüm doğru olsun
  const el = flow.querySelector(`p[data-i="${pi}"]`);
  let page = 0;
  if (el) {
    const node = el.firstChild;
    const k = o - R.paras[pi].o;
    let rect = null;
    if (k > 0 && node && node.nodeType === 3) {
      const r = document.createRange();
      let kk = Math.min(k, node.length - 1);
      // satır sonundaki boşluk önceki sayfada kalır; ilk harfi ölç
      while (kk < node.length - 1 && /\s/.test(node.data[kk])) kk++;
      r.setStart(node, kk);
      r.setEnd(node, kk + 1);
      rect = r.getClientRects()[0];
    }
    if (!rect) rect = el.getClientRects()[0];
    if (rect) page = pageOfRect(rect);
  }
  showPage(Math.max(0, Math.min(page, R.pages - 1)));
  R.anchor = o; // yeniden düzenlemelerde kaymayı önlemek için hedefi koru
}

function showPage(n, update = true) {
  R.page = n;
  flow.style.transform = `translateX(${-n * R.step}px)`;
  if (update) { updateFooter(); R.anchor = R.offset; saveSoon(); }
}

function caretAt(x, y) {
  const tzone = $('#tapzone');
  tzone.style.pointerEvents = 'none'; // dokunma katmanı metnin üstünde
  try {
    if (document.caretPositionFromPoint) {
      const c = document.caretPositionFromPoint(x, y);
      return c && { node: c.offsetNode, off: c.offset };
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r && { node: r.startContainer, off: r.startOffset };
    }
  } catch (e) { /* yok say */ } finally {
    tzone.style.pointerEvents = '';
  }
  return null;
}

/* Ekranın sol üstündeki karakterin kitap içindeki konumu */
function currentOffset() {
  if (!R.paras.length || R.sec < 0) return 0;
  const pv = pageview.getBoundingClientRect();
  const els = flow.children;
  for (const el of els) {
    if (el.dataset.i == null) continue;
    const rects = el.getClientRects();
    for (let r = 0; r < rects.length; r++) {
      const rc = rects[r];
      if (rc.left >= pv.left - 2 && rc.left < pv.right && rc.width > 0) {
        const pr = R.paras[+el.dataset.i];
        if (r === 0) return pr.o; // paragraf bu sayfada başlıyor
        // paragraf önceki sayfadan devam ediyor: ilk satırdaki karakteri bul
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
        const c = caretAt(rc.left + 2, rc.top + Math.min(lh / 2, rc.height / 2));
        if (c && c.node && c.node.parentNode === el) return pr.o + Math.min(c.off, pr.t.length - 1);
        return pr.o;
      }
    }
  }
  return R.paras[R.secs[R.sec].start].o;
}

function nextPage() {
  if (R.mode === 'page') {
    if (R.pdfPage < R.doc.numPages) renderPdfPage(R.pdfPage + 1);
    else toast('Kitabın sonuna geldiniz');
    return;
  }
  if (R.page < R.pages - 1) showPage(R.page + 1);
  else if (R.sec < R.secs.length - 1) { layoutSection(R.sec + 1); showPage(0); }
  else toast('Kitabın sonuna geldiniz');
}
function prevPage() {
  if (R.mode === 'page') {
    if (R.pdfPage > 1) renderPdfPage(R.pdfPage - 1);
    return;
  }
  if (R.page > 0) showPage(R.page - 1);
  else if (R.sec > 0) { layoutSection(R.sec - 1); showPage(R.pages - 1); }
}

function atBookEnd() {
  return R.mode === 'text'
    ? R.sec === R.secs.length - 1 && R.page === R.pages - 1
    : R.pdfPage === R.doc.numPages;
}

function updateFooter() {
  let pct, page, left;
  const N = R.doc.numPages;
  if (R.mode === 'text') {
    const o = currentOffset();
    R.offset = o;
    pct = atBookEnd() ? 1 : o / R.total;
    page = R.paras[paraIndexForOffset(o)].p;
    left = fmtMinutes((R.total - o) / CHARS_PER_MIN);
    left = atBookEnd() ? 'Bitti' : `${left} kaldı`;
  } else {
    page = R.pdfPage;
    pct = page / N;
    left = page >= N ? 'Bitti' : `${N - page} sayfa kaldı`;
  }
  R.pct = pct;
  R.curPdfPage = page;
  $('#fPct').textContent = `%${Math.floor(pct * 100)}`;
  $('#fPage').textContent = `Sayfa ${page} / ${N}`;
  $('#fLeft').textContent = left;
  $('#fBar i').style.width = `${pct * 100}%`;
  if (!R.sliding) {
    $('#slider').value = page;
    $('#sliderLabel').textContent = `Sayfa ${page} / ${N} · %${Math.floor(pct * 100)}`;
  }
}

/* ---------- Orijinal sayfa görünümü ---------- */
let pageToken = 0;
async function renderPdfPage(n) {
  const token = ++pageToken;
  n = Math.max(1, Math.min(n, R.doc.numPages));
  R.pdfPage = n;
  updateFooter();
  saveSoon();
  const page = await R.doc.getPage(n);
  if (token !== pageToken) return;
  const box = $('#pdfview').getBoundingClientRect();
  const vp1 = page.getViewport({ scale: 1 });
  const fit = Math.min(box.width / vp1.width, box.height / vp1.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const vp = page.getViewport({ scale: fit * dpr });
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, off.width, off.height);
  if (R.renderTask) { try { R.renderTask.cancel(); } catch (e) { /* yok say */ } }
  R.renderTask = page.render({ canvasContext: ctx, viewport: vp });
  try { await R.renderTask.promise; } catch (e) { return; }
  if (token !== pageToken) return;
  const c = $('#pdfCanvas');
  c.width = off.width;
  c.height = off.height;
  c.getContext('2d').drawImage(off, 0, 0);
  c.style.width = `${Math.floor(vp1.width * fit)}px`;
  c.style.height = `${Math.floor(vp1.height * fit)}px`;
}

/* ---------- Konum kaydetme ---------- */
async function saveNow() {
  const b = R.book;
  if (!b || !R.doc) return;
  if (R.mode === 'text' && R.paras.length) {
    b.pos = R.anchor != null ? R.anchor : currentOffset();
    b.pdfPage = R.paras[paraIndexForOffset(b.pos)].p;
    b.progress = atBookEnd() ? 1 : b.pos / R.total;
  } else {
    b.pos = null;
    b.pdfPage = R.pdfPage;
    b.progress = R.pdfPage / R.doc.numPages;
  }
  b.mode = R.mode;
  b.lastReadAt = Date.now();
  try { await idb.put('books', { ...b }); } catch (e) { console.error(e); }
}
const saveSoon = debounce(saveNow, 400);

async function closeReader() {
  if (R.book) await saveNow();
  closeSheets();
  hideMenu();
  if (R.doc) { try { R.doc.destroy(); } catch (e) { /* yok say */ } }
  Object.assign(R, { book: null, doc: null, paras: [], secs: [], sec: -1, anchor: null });
  flow.innerHTML = '';
  $('#reader').hidden = true;
  $('#library').hidden = false;
  renderLibrary();
}

/* ---------- Menü, içindekiler, kaydırıcı ---------- */
function showMenu() {
  R.menu = true;
  $('#menuTop').hidden = false;
  $('#menuBottom').hidden = false;
  updateFooter();
}
function hideMenu() {
  R.menu = false;
  $('#menuTop').hidden = true;
  $('#menuBottom').hidden = true;
}

function openSheet(sel) {
  closeSheets();
  $(sel).hidden = false;
  $('#scrim').hidden = false;
}
function closeSheets() {
  $$('.sheet').forEach((s) => { s.hidden = true; });
  $('#scrim').hidden = true;
}

async function jumpToPdfPage(n) {
  if (R.mode === 'text') { gotoOffset(offsetForPdfPage(n)); }
  else await renderPdfPage(n);
}

async function loadOutline() {
  if (R.outline) return R.outline;
  const out = [];
  try {
    const ol = await R.doc.getOutline();
    const walk = async (items, depth) => {
      for (const it of items || []) {
        let page = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await R.doc.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            page = typeof dest[0] === 'number' ? dest[0] + 1 : (await R.doc.getPageIndex(dest[0])) + 1;
          }
        } catch (e) { /* yok say */ }
        out.push({ title: it.title, page, depth });
        if (depth < 2) await walk(it.items, depth + 1);
      }
    };
    await walk(ol, 0);
  } catch (e) { /* yok say */ }
  R.outline = out;
  return out;
}

async function openToc() {
  hideMenu();
  openSheet('#sheetToc');
  const list = $('#tocList');
  list.innerHTML = '<li class="none">Yükleniyor…</li>';
  let items = await loadOutline();
  if (!items.length && R.paras.length) {
    // PDF'te içindekiler yoksa algılanan başlıkları kullan
    items = R.paras.filter((p) => p.h).slice(0, 300).map((p) => ({ title: p.t, page: p.p, depth: 0 }));
  }
  if (!items.length) {
    list.innerHTML = '<li class="none">Bu PDF\'te içindekiler bilgisi yok. Menüdeki kaydırıcıyla istediğiniz sayfaya gidebilirsiniz.</li>';
    return;
  }
  const cur = R.curPdfPage || 1;
  let curIdx = -1;
  items.forEach((it, i) => { if (it.page && it.page <= cur) curIdx = i; });
  list.innerHTML = items.map((it, i) => `
    <li data-page="${it.page || ''}" class="${i === curIdx ? 'cur' : ''}" style="padding-left:${it.depth * 16}px">
      <span>${esc(it.title)}</span><span class="pg">${it.page || ''}</span>
    </li>`).join('');
  const curEl = list.querySelector('.cur');
  if (curEl) curEl.scrollIntoView({ block: 'center' });
}

/* ---------- Ayarlar paneli ---------- */
function syncSettingsUi() {
  $$('#sheetAa [data-key]').forEach((grp) => {
    const key = grp.dataset.key;
    const val = key === 'mode' ? R.mode : String(settings[key]);
    grp.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === val));
  });
  $('#fsVal').textContent = settings.size;
}

async function changeSetting(key, val) {
  if (key === 'mode') {
    if (val === R.mode) return;
    const page = R.curPdfPage || 1;
    if (val === 'text') {
      showLoading('Açılıyor…');
      const ok = await loadText();
      hideLoading();
      if (!ok) { toast('Bu PDF\'te okunabilir metin yok (taranmış belge)'); return; }
    }
    await setMode(val, { page });
    saveNow();
    return;
  }
  const o = R.mode === 'text' ? R.anchor : null;
  settings[key] = val;
  saveSettings();
  applySettings();
  syncSettingsUi();
  if (R.mode === 'text' && R.paras.length) relayout(o);
  else if (R.mode === 'page' && key === 'theme') { /* yalnızca CSS */ }
}

function relayout(o) {
  if (R.mode === 'text' && R.paras.length) {
    if (o == null) o = R.anchor != null ? R.anchor : currentOffset();
    R.sec = -1;
    gotoOffset(o);
  } else if (R.mode === 'page' && R.doc) {
    renderPdfPage(R.pdfPage);
  }
}

/* =========================================================
   Olaylar
   ========================================================= */
// Kitaplık
$('#fileInput').addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = '';
});
$('#library').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) { e.stopPropagation(); openActions(more.dataset.more); return; }
  const item = e.target.closest('[data-id]');
  if (item) openBook(item.dataset.id);
});
$('#libTheme').addEventListener('click', () => {
  const order = ['paper', 'white', 'sepia', 'dark'];
  settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
  saveSettings();
  applySettings();
});
$('#actionSheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) runAction(b.dataset.act);
});
$('#scrim').addEventListener('click', closeSheets);

// Okuyucu: dokunma bölgeleri ve kaydırma
let touch = null;
const tz = $('#tapzone');
tz.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY, time: Date.now() };
}, { passive: true });
tz.addEventListener('touchend', (e) => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
    e.preventDefault();
    if (R.menu) hideMenu();
    if (dx < 0) nextPage(); else prevPage();
  }
});
tz.addEventListener('click', (e) => {
  const w = window.innerWidth;
  const x = e.clientX;
  if (R.menu) { hideMenu(); return; }
  if (x < w * 0.3) prevPage();
  else if (x > w * 0.7) nextPage();
  else showMenu();
});
document.addEventListener('keydown', (e) => {
  if ($('#reader').hidden) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); nextPage(); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prevPage(); }
  else if (e.key === 'Escape') { if (!$('#scrim').hidden) closeSheets(); else history.back(); }
});

$('#btnBack').addEventListener('click', () => history.back());
$('#btnToc').addEventListener('click', openToc);
$('#btnAa').addEventListener('click', () => { hideMenu(); syncSettingsUi(); openSheet('#sheetAa'); });
$('#tocList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-page]');
  if (!li || !li.dataset.page) return;
  closeSheets();
  jumpToPdfPage(+li.dataset.page);
});

const slider = $('#slider');
slider.addEventListener('input', () => {
  R.sliding = true;
  $('#sliderLabel').textContent = `Sayfa ${slider.value} / ${R.doc.numPages}'e git`;
});
slider.addEventListener('change', async () => {
  R.sliding = false;
  await jumpToPdfPage(+slider.value);
});

$('#sheetAa').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  const key = b.parentElement.dataset.key;
  if (key) changeSetting(key, b.dataset.v);
});
$('#fsMinus').addEventListener('click', () => changeSetting('size', Math.max(13, settings.size - 1)));
$('#fsPlus').addEventListener('click', () => changeSetting('size', Math.min(34, settings.size + 1)));

// Geri tuşu (Android) / tarayıcı geri
window.addEventListener('popstate', () => {
  if (!$('#scrim').hidden) { closeSheets(); if (R.book) history.pushState({ reader: R.book.id }, '', '#oku'); return; }
  if (!$('#reader').hidden) closeReader();
});

// Ekran döndürme / boyut değişimi
let lastSize = `${window.innerWidth}x${window.innerHeight}`;
window.addEventListener('resize', debounce(() => {
  const size = `${window.innerWidth}x${window.innerHeight}`;
  if (size === lastSize || $('#reader').hidden || !R.doc) return;
  lastSize = size;
  relayout(R.mode === 'text' ? R.anchor : null);
}, 250));
// Yazı tipi geç yüklenirse sayfaları yeniden hesapla
if (document.fonts) {
  document.fonts.addEventListener('loadingdone', () => {
    if (!$('#reader').hidden && R.mode === 'text' && R.paras.length && R.book) relayout(R.anchor);
  });
}

// Uygulama arka plana geçerken konumu kaydet
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('pagehide', saveNow);

/* =========================================================
   Başlangıç
   ========================================================= */
applySettings();
syncSettingsUi();
if (location.hash === '#oku') history.replaceState(null, '', location.pathname);
renderLibrary();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
