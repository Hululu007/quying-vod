// 趣影 Web 前端 — 纯原生 JS，零依赖
(() => {
  'use strict';

  const app = document.getElementById('app');
  const statusPill = document.getElementById('statusPill');
  const modal = document.getElementById('modal');
  const modalCard = document.getElementById('modalCard');

  const CATEGORIES = [
    { group: '分类', items: [
      { t: '', name: '全部', color: 'var(--accent)' },
      { t: '1', name: '电影', color: '#4a9eff', subs: [
        { t: 21, name: '动作' }, { t: 22, name: '喜剧' }, { t: 23, name: '恐怖' },
        { t: 24, name: '科幻' }, { t: 25, name: '爱情' }, { t: 26, name: '剧情' },
        { t: 27, name: '战争' }, { t: 28, name: '纪录' }, { t: 50, name: '动画' },
      ]},
      { t: '2', name: '电视剧', color: '#a78bfa', subs: [
        { t: 31, name: '国产剧' }, { t: 32, name: '欧美剧' }, { t: 33, name: '港剧' },
        { t: 34, name: '韩剧' }, { t: 35, name: '台剧' }, { t: 36, name: '日剧' },
        { t: 37, name: '海外剧' }, { t: 38, name: '泰剧' },
      ]},
      { t: '3', name: '综艺', color: '#f59e0b', subs: [
        { t: 46, name: '大陆综艺' }, { t: 47, name: '港台综艺' },
        { t: 48, name: '日韩综艺' }, { t: 49, name: '欧美综艺' },
      ]},
      { t: '4', name: '动漫', color: '#10b981', subs: [
        { t: 40, name: '国产动漫' }, { t: 41, name: '日韩动漫' },
        { t: 42, name: '欧美动漫' }, { t: 43, name: '港台动漫' },
      ]},
      { t: '5', name: '短剧', color: '#ec4899', subs: [
        { t: 59, name: '重生民国' }, { t: 60, name: '穿越年代' },
        { t: 61, name: '现代言情' }, { t: 62, name: '反转爽文' },
        { t: 63, name: '女恋总裁' }, { t: 66, name: '古装仙侠' },
      ]},
      { t: '6', name: '预告片', color: '#38bdf8' },
      { t: '7', name: '体育', color: '#84cc16', subs: [
        { t: 54, name: '足球' }, { t: 55, name: '篮球' },
        { t: 56, name: '网球' }, { t: 57, name: '斯诺克' },
      ]},
    ]},
  ];

  // 榜单（排序）不是一级分类，单独展示在年份筛选下面。
  const RANKS = [
    { t: 'new', name: '最新' },
    { t: 'hot', name: '最热' },
    { t: 'score', name: '高分推荐' },
  ];


  const YEARS = [
    { y: '', name: '全部' },
    { y: '2026', name: '2026' },
    { y: '2025', name: '2025' },
    { y: '2024', name: '2024' },
    { y: '2023', name: '2023' },
    { y: '2022', name: '2022' },
    { y: '2021', name: '2021' },
    { y: '2020', name: '2020' },
    { y: 'older', name: '更早' },
  ];

  const state = { view: 'home', t: '', year: '', pg: 1, pagesize: 40, q: '', total: 0, pageCount: 1, list: [], loading: false, searching: false, error: '' };
  const bootParams = new URLSearchParams(location.search);
  const playbackFailed = bootParams.get('error') === 'playback';
  if (playbackFailed) {
    bootParams.delete('error');
    const query = bootParams.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }

  // ---- helpers ----
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

  // ---- 授权卡密：本地存储 + 所有本站 API 请求自动透传 ----
  const CARD_KEY = 'qy_card_code';
  function cardCode() {
    try { return (localStorage.getItem(CARD_KEY) || '').trim(); } catch { return ''; }
  }
  function withCode(path) {
    const c = cardCode();
    if (!c || !/^\//.test(path)) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}code=${encodeURIComponent(c)}`;
  }
  function showCardDialog(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1a1a1a;color:#eee;padding:22px;border-radius:12px;width:320px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,.5);';
      const title = document.createElement('div');
      title.textContent = '授权卡密';
      title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px;';
      const msg = document.createElement('div');
      msg.textContent = message || '请输入授权卡密以访问片库';
      msg.style.cssText = 'font-size:13px;color:#999;margin-bottom:12px;';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'QY-XXXX-XXXX-XXXX';
      input.value = cardCode();
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;border:1px solid #333;border-radius:8px;background:#111;color:#eee;font-size:14px;';
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'padding:8px 14px;border:1px solid #333;background:transparent;color:#ccc;border-radius:8px;cursor:pointer;';
      const ok = document.createElement('button');
      ok.textContent = '确定';
      ok.style.cssText = 'padding:8px 14px;border:none;background:#4a9eff;color:#fff;border-radius:8px;cursor:pointer;';
      const close = (val) => { overlay.remove(); resolve(val); };
      cancel.onclick = () => close(null);
      ok.onclick = () => close(input.value.trim());
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); if (e.key === 'Escape') close(null); });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(title); box.appendChild(msg); box.appendChild(input); box.appendChild(btns);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => input.focus(), 0);
    });
  }

  async function api(path, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 30000);
    try {
      const res = await fetch(withCode(path), {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-json */ }
      // 授权模式下接口返回 401：弹框让用户输入卡密后重试一次
      if (res.status === 401 && !opts._retried) {
        const c = await showCardDialog('访问需要授权卡密，请输入：');
        if (c) {
          try { localStorage.setItem(CARD_KEY, c); } catch {}
          clearTimeout(timer);
          return api(path, { ...opts, _retried: true });
        }
      }
      if (!res.ok || (data && data.ok === false)) {
        const msg = (data && data.error) || (data && data.msg) || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时，上游响应过慢，请稍后重试');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function spinner(text = '加载中…') { return el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('div', { style: 'margin-top:12px' }, text)]); }

  function banner(type, msg) { return el('div', { class: `banner ${type}` }, msg); }

  // ---- health ----
  async function refreshHealth() {
    try {
      const h = await api('/api/health');
      statusPill.textContent = '接口正常';
      statusPill.className = 'status-pill ok';
      return true;
    } catch {
      statusPill.textContent = '上游接口不可达';
      statusPill.className = 'status-pill bad';
      return false;
    }
  }

  // ---- grid ----
  function card(item) {
    const pic = item.vod_pic || '';
    const cardEl = el('div', { class: 'card', onclick: () => openDetail(item.vod_id) });
    const poster = el('div', { class: 'poster loading' });
    const showPlaceholder = () => {
      poster.classList.remove('loading');
      poster.style.backgroundImage = '';
      if (!poster.querySelector('.placeholder')) poster.appendChild(el('div', { class: 'placeholder' }, '暂无海报'));
    };
    if (pic) {
      const img = new Image();
      img.onload = () => {
        poster.style.backgroundImage = `url("${pic.replace(/"/g, '%22')}")`;
        poster.classList.remove('loading');
      };
      img.onerror = showPlaceholder;
      img.src = pic;
      // 海报长时间未返回时也要有可见反馈，避免出现空白卡片。
      setTimeout(() => { if (poster.classList.contains('loading')) poster.classList.add('slow'); }, 6000);
    } else {
      showPlaceholder();
    }
    if (item.vod_remarks) poster.appendChild(el('span', { class: 'badge' }, String(item.vod_remarks)));
    const meta = el('div', { class: 'meta' }, [
      el('p', { class: 'title', title: item.vod_name || '' }, item.vod_name || '未命名'),
      el('div', { class: 'sub' }, [
        item.type_name ? el('span', {}, item.type_name) : null,
        item.vod_year ? el('span', {}, item.vod_year) : null,
        item.vod_area ? el('span', {}, item.vod_area) : null,
      ].filter(Boolean)),
    ]);
    cardEl.appendChild(poster);
    cardEl.appendChild(meta);
    return cardEl;
  }

  function yearMatches(item) {
    if (!state.year) return true;
    const y = parseInt(item.vod_year, 10);
    if (!y) return false;
    if (state.year === 'older') return y < 2020;
    return String(y) === state.year;
  }

  function renderGrid() {
    const grid = el('div', { class: 'grid' });
    if (!state.list.length) {
      return el('div', { class: 'empty' }, '暂无数据');
    }
    const items = state.list.filter(yearMatches);
    if (!items.length) {
      return el('div', { class: 'empty' }, '当前页没有符合条件的影片，可翻页或切换筛选条件');
    }
    items.forEach((it) => grid.appendChild(card(it)));
    return grid;
  }

  function renderPager() {
    if (state.pageCount <= 1) return null;
    const prev = state.pg > 1
      ? el('button', { class: 'btn ghost', disabled: state.loading, onclick: () => changePage(state.pg - 1) }, '上一页')
      : null;
    const next = state.pg < state.pageCount
      ? el('button', { class: 'btn ghost', disabled: state.loading, onclick: () => changePage(state.pg + 1) }, '下一页')
      : null;
    return el('div', { class: 'pager' }, [
      prev,
      el('span', { class: 'page-info' }, `${state.pg} / ${state.pageCount}`),
      next,
    ].filter(Boolean));
  }

  // ---- 站点配置 / 分类导航 ----
  const PRIMARY = CATEGORIES[0].items;
  let site = {
    name: '趣影', subtitle: '高清影视 · 即搜即看', notice: '', footer: '',
    adsEnabled: true, carouselInterval: 5000,
  };

  function primaryOf(t) {
    const s = String(t || '');
    if (!s) return '';
    if (PRIMARY.some((c) => String(c.t) === s)) return s;
    if (!/^\d{1,3}$/.test(s)) return '';
    for (const c of PRIMARY) {
      if (c.subs && c.subs.some((x) => x.t === Number(s))) return c.t;
    }
    return '';
  }

  // 一级分类 + 二级分类（电影→动作/喜剧/科幻…），切换后始终保留分类条。
  function categoryNav() {
    const active = primaryOf(state.t);
    const wrap = el('div', { class: 'cat-nav' });
    const tabs = el('div', { class: 'cat-tabs' });
    PRIMARY.forEach((c) => {
      const isActive = String(state.t) === String(c.t) || (active === c.t && c.t !== '');
      tabs.appendChild(el('button', {
        class: 'cat-tab' + (isActive ? ' active' : ''),
        style: c.color ? `--cat-color:${c.color}` : '',
        onclick: () => selectCategory(String(c.t)),
      }, c.name));
    });
    wrap.appendChild(tabs);
    const def = PRIMARY.find((c) => c.t === active);
    if (def && def.subs && def.subs.length) {
      const subs = el('div', { class: 'sub-tabs', style: `--cat-color:${def.color}` });
      subs.appendChild(el('button', {
        class: 'sub-tab' + (String(state.t) === String(def.t) ? ' active' : ''),
        onclick: () => selectCategory(String(def.t)),
      }, '全部'));
      def.subs.forEach((s) => {
        subs.appendChild(el('button', {
          class: 'sub-tab' + (Number(state.t) === s.t ? ' active' : ''),
          onclick: () => selectCategory(String(s.t)),
        }, s.name));
      });
      wrap.appendChild(subs);
    }
    return wrap;
  }

  function selectCategory(t) {
    state.t = t;
    state.pg = 1;
    state.year = '';
    const host = document.getElementById('catNavHost');
    if (host) {
      clear(host);
      host.appendChild(categoryNav());
      host.appendChild(yearPills());
      host.appendChild(rankPills());
    }
    const hint = document.getElementById('filterHint');
    if (hint) hint.textContent = filterSummary();
    loadList();
  }

  function categoryLabel(t) {
    const s = String(t || '');
    if (!s) return '全部';
    const rank = RANKS.find((r) => r.t === s);
    if (rank) return rank.name;
    const top = PRIMARY.find((c) => String(c.t) === s);
    if (top) return top.name;
    for (const c of PRIMARY) {
      const sub = c.subs && c.subs.find((x) => x.t === Number(s));
      if (sub) return `${c.name} · ${sub.name}`;
    }
    return '全部';
  }

  function filterSummary() {
    const parts = [];
    if (state.t) parts.push(categoryLabel(state.t));
    if (state.year) parts.push(YEARS.find((c) => c.y === state.year)?.name || state.year);
    return parts.length ? parts.join(' · ') : '热门推荐';
  }

  // ---- 首页轮播 ----
  function renderCarousel(host, items) {
    clear(host);
    if (!items.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const wrap = el('section', { class: 'carousel', 'aria-roledescription': 'carousel' });
    const slides = [];
    const dots = el('div', { class: 'carousel-dots' });
    let current = 0;
    let timer = null;

    function show(i) {
      current = (i + items.length) % items.length;
      slides.forEach((s, idx) => s.classList.toggle('active', idx === current));
      [...dots.children].forEach((d, idx) => d.classList.toggle('active', idx === current));
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function start() {
      if (items.length < 2) return;
      stop();
      timer = setInterval(() => show(current + 1), Math.max(2000, Number(site.carouselInterval) || 5000));
    }

    items.forEach((item, i) => {
      const slide = el('div', { class: 'carousel-slide' + (i === 0 ? ' active' : '') });
      if (item.image) slide.style.backgroundImage = `url("${String(item.image).replace(/"/g, '%22')}")`;
      slide.appendChild(el('div', { class: 'carousel-shade' }));
      slide.appendChild(el('div', { class: 'carousel-body' }, [
        el('span', { class: 'carousel-tag' }, item.tag || '精选推荐'),
        el('h3', {}, item.title || ''),
        item.desc ? el('p', {}, item.desc) : null,
        (item.link || item.vodId) ? el('span', { class: 'carousel-more' }, item.link ? '查看详情 →' : '立即观看 →') : null,
      ].filter(Boolean)));
      slide.addEventListener('click', () => {
        if (item.vodId) openDetail(item.vodId);
        else if (item.link) {
          if (item.link.startsWith('/')) location.href = item.link;
          else window.open(item.link, '_blank', 'noopener');
        }
      });
      slides.push(slide);
      wrap.appendChild(slide);
      dots.appendChild(el('button', {
        class: 'carousel-dot' + (i === 0 ? ' active' : ''),
        'aria-label': `第 ${i + 1} 张`,
        onclick: (e) => { e.stopPropagation(); show(i); start(); },
      }));
    });

    wrap.appendChild(el('button', { class: 'carousel-arrow prev', 'aria-label': '上一张', onclick: (e) => { e.stopPropagation(); show(current - 1); start(); } }, '‹'));
    wrap.appendChild(el('button', { class: 'carousel-arrow next', 'aria-label': '下一张', onclick: (e) => { e.stopPropagation(); show(current + 1); start(); } }, '›'));
    dots.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(dots);
    wrap.addEventListener('mouseenter', stop);
    wrap.addEventListener('mouseleave', start);
    host.appendChild(wrap);
    start();
  }

  async function loadHero(host) {
    let items = [];
    if (site.adsEnabled) {
      try {
        const data = await api('/api/ads?slot=carousel');
        items = (data.list || []).slice(0, 5).map((ad) => ({
          title: ad.title, image: ad.image, link: ad.link, tag: '推广',
        }));
      } catch { /* 忽略广告失败 */ }
    }
    if (!items.length) {
      try {
        const data = await api('/api/vod/list?pg=1');
        items = (data.list || []).slice(0, 5).map((v) => ({
          title: v.vod_name,
          desc: [v.type_name, v.vod_year, v.vod_area].filter(Boolean).join(' · '),
          image: v.vod_pic,
          vodId: v.vod_id,
          tag: '热播推荐',
        }));
      } catch { /* 忽略 */ }
    }
    if (!host.isConnected) return;
    renderCarousel(host, items);
  }

  // ---- 顶部导航广告（最多 5 条文字链接） ----
  async function loadNavAd() {
    const bar = document.getElementById('navAdBar');
    if (!bar || !site.adsEnabled) return;
    try {
      const data = await api('/api/ads?slot=nav');
      const items = (data.list || []).slice(0, 5);
      if (!items.length) return;
      bar.classList.remove('hidden');
      clear(bar);
      items.forEach((ad) => {
        const href = ad.link || '';
        bar.appendChild(el('a', {
          class: 'nav-ad',
          href: href || '#',
          target: /^https?:\/\//i.test(href) ? '_blank' : '_self',
          rel: 'noopener',
          title: ad.title || '推广',
          onclick: (e) => { if (!href) e.preventDefault(); },
        }, ad.title || '推广'));
      });
    } catch { /* 忽略 */ }
  }

  function yearPills() {
    const row = el('div', { class: 'pills year-pills' });
    YEARS.forEach((c) => {
      row.appendChild(el('button', {
        class: 'pill' + (state.year === c.y ? ' active' : ''),
        'data-year': c.y,
        onclick: () => setYear(c.y),
      }, c.name));
    });
    return el('div', { class: 'year-row' }, [row]);
  }

  // 榜单行：位于年份筛选下方，不是一级分类；再点一次可取消榜单回到全部。
  function rankPills() {
    const row = el('div', { class: 'pills rank-pills' });
    RANKS.forEach((r) => {
      row.appendChild(el('button', {
        class: 'pill' + (state.t === r.t ? ' active' : ''),
        'data-rank': r.t,
        onclick: () => selectCategory(state.t === r.t ? '' : r.t),
      }, r.name));
    });
    return el('div', { class: 'year-row rank-row' }, [row]);
  }

  function setYear(y) {
    state.year = y;
    state.pg = 1;
    document.querySelectorAll('.pill[data-year]').forEach((b) => b.classList.toggle('active', b.dataset.year === y));
    const hint = document.getElementById('filterHint');
    if (hint) hint.textContent = filterSummary();
    const wrap = document.getElementById('listWrap');
    if (wrap) loadListInto(wrap);
  }

  function portalSection(title, desc, more) {
    const head = el('div', { class: 'section-title portal-title' }, [
      el('h3', {}, title),
      desc ? el('span', { class: 'hint' }, desc) : null,
      more ? el('button', { class: 'portal-more', onclick: more.onclick }, more.text) : null,
    ].filter(Boolean));
    const grid = el('div', { class: 'portal-grid' });
    const wrap = el('section', { class: 'portal-section' }, [head, grid]);
    return { wrap, grid };
  }

  async function loadPortalSection(title, desc, params, more) {
    const host = document.getElementById('portalHost');
    if (!host) return;
    const { wrap, grid } = portalSection(title, desc, more);
    host.appendChild(wrap);
    try {
      const path = params && params.section
        ? `/api/vod/kan?section=${encodeURIComponent(params.section)}&limit=${encodeURIComponent(params.limit || 12)}`
        : `/api/vod/list?${new URLSearchParams({ pg: '1', ...params }).toString()}`;
      const data = await api(path);
      const list = (Array.isArray(data.list) ? data.list : []).slice(0, 12);
      if (!list.length) { wrap.remove(); return; }
      clear(grid);
      list.forEach((it) => grid.appendChild(card(it)));
    } catch {
      wrap.remove();
    }
  }

  async function loadChannelPreview() {
    const host = document.getElementById('portalHost');
    if (!host) return;
    const wrap = el('section', { class: 'portal-section channel-preview' });
    host.appendChild(wrap);
    try {
      const data = await api('/api/vod/channels');
      const list = (Array.isArray(data.list) ? data.list : []).slice(0, 8);
      if (!list.length) { wrap.remove(); return; }
      clear(wrap);
      wrap.appendChild(el('div', { class: 'section-title portal-title' }, [
        el('h3', {}, '创意专题'),
        el('span', { class: 'hint' }, '按主题整理好的片单空间'),
        el('button', { class: 'portal-more', onclick: () => setView('channels') }, '全部频道'),
      ]));
      const grid = el('div', { class: 'portal-grid channel-preview-grid' });
      list.forEach((c) => {
        grid.appendChild(el('div', { class: 'channel-card channel-mini', onclick: () => openChannel(c) }, [
          el('div', { class: 'channel-icon' }, c.icon || '🎬'),
          el('div', { class: 'channel-name' }, c.name),
          el('div', { class: 'channel-desc' }, c.desc || ''),
          el('div', { class: 'channel-more' }, '进入专题 →'),
        ]));
      });
      wrap.appendChild(grid);
    } catch {
      wrap.remove();
    }
  }

  function renderHome() {
    clear(app);
    if (playbackFailed) app.appendChild(banner('err', '所有播放源暂不可用，已返回首页。'));
    if (site.notice) app.appendChild(banner('warn', site.notice));

    const heroHost = el('div', { id: 'heroCarousel', class: 'hero-carousel' });
    app.appendChild(heroHost);
    loadHero(heroHost);

    app.appendChild(el('div', { class: 'search-strip' }, [
      el('div', { class: 'search-box' }, [
        el('input', { type: 'text', placeholder: '搜索影片名称，回车搜索…', id: 'heroSearch', onkeydown: (e) => { if (e.key === 'Enter') { state.q = e.target.value.trim(); setView('search'); } } }),
        el('button', { class: 'btn', onclick: () => { state.q = document.getElementById('heroSearch').value.trim(); setView('search'); } }, '搜索'),
      ]),
    ]));

    app.appendChild(el('div', { class: 'cat-panel' }, [
      el('div', { class: 'cat-panel-head' }, [
        el('span', { class: 'cat-panel-title' }, '全部片库'),
        el('span', { class: 'filter-hint', id: 'filterHint' }, filterSummary()),
      ]),
      el('div', { id: 'catNavHost' }, [categoryNav(), yearPills(), rankPills()]),
    ]));

    const listWrap = el('div', { id: 'listWrap' });
    app.appendChild(listWrap);
    app.appendChild(el('div', { id: 'pagerHost' }));
    loadListInto(listWrap);

    const portalHost = el('div', { id: 'portalHost' });
    app.appendChild(portalHost);
    loadPortalSection('首页推荐', '同步更新的首页推荐片单', { section: 'home', limit: 12 });
    loadPortalSection('电视剧推荐', '热门电视剧推荐', { section: 'tv', limit: 12 });
    loadPortalSection('电影推荐', '热门电影推荐', { section: 'movie', limit: 12 });
    loadPortalSection('综艺推荐', '热门综艺推荐', { section: 'variety', limit: 12 });
    loadPortalSection('动漫推荐', '热门动漫推荐', { section: 'anime', limit: 12 });
    loadChannelPreview();
  }

  async function loadListInto(wrap) {
    if (state.loading) return;
    state.loading = true;
    clear(wrap);
    wrap.appendChild(spinner('加载中…（上游较慢时约 5–10 秒）'));
    try {
      const yearParam = /^\d{4}$/.test(state.year) ? `&year=${state.year}` : '';
      const data = await api(`/api/vod/list?pg=${state.pg}${state.t ? '&t=' + encodeURIComponent(state.t) : ''}${yearParam}`);
      state.list = Array.isArray(data.list) ? data.list : [];
      state.total = Number(data.total) || 0;
      state.pageCount = Number(data.pagecount) || 1;
      state.error = '';
      if (!state.list.length) {
        clear(wrap);
        wrap.appendChild(el('div', { class: 'empty' }, '该分类暂无内容，换个分类或年份试试'));
      } else {
        clear(wrap);
        wrap.appendChild(renderGrid());
      }
    } catch (e) {
      state.list = [];
      state.error = e.message;
      clear(wrap);
      const box = el('div', {}, [banner('warn', `列表加载失败：${e.message}`)]);
      box.appendChild(el('div', { class: 'empty' }, [
        el('button', { class: 'btn', onclick: () => loadList() }, '重试'),
      ]));
      wrap.appendChild(box);
    } finally {
      state.loading = false;
      const pagerHost = document.getElementById('pagerHost');
      if (pagerHost) {
        clear(pagerHost);
        const pager = state.list.length ? renderPager() : null;
        if (pager) pagerHost.appendChild(pager);
      }
    }
  }

  function loadList() {
    const wrap = document.getElementById('listWrap');
    if (wrap) loadListInto(wrap);
    else renderHome();
  }

  function changePage(p) {
    if (state.loading || p < 1 || p > state.pageCount) return;
    state.pg = p;
    loadList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderSearch() {
    clear(app);
    app.appendChild(el('section', { class: 'hero' }, [
      el('h2', {}, '搜索'),
      el('div', { class: 'search-box' }, [
        el('input', { type: 'text', id: 'searchInput', placeholder: '输入影片关键词…', value: state.q, onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
        el('button', { class: 'btn', onclick: doSearch }, '搜索'),
      ]),
    ]));
    const wrap = el('div', { id: 'searchWrap' });
    app.appendChild(wrap);
    if (state.q) doSearchInto(wrap);
    else wrap.appendChild(el('div', { class: 'empty' }, '输入关键词后回车或点击搜索'));
  }

  function doSearch() {
    state.q = document.getElementById('searchInput').value.trim();
    const wrap = document.getElementById('searchWrap');
    if (!wrap) return;
    if (!state.q) { clear(wrap); wrap.appendChild(el('div', { class: 'empty' }, '请输入关键词')); return; }
    doSearchInto(wrap);
  }

  async function doSearchInto(wrap) {
    if (state.searching) return;
    state.searching = true;
    clear(wrap);
    wrap.appendChild(spinner('搜索中…（上游较慢时约 5–10 秒）'));
    try {
      const data = await api(`/api/vod/search?wd=${encodeURIComponent(state.q)}`);
      const list = Array.isArray(data.list) ? data.list : [];
      clear(wrap);
      if (!list.length) { wrap.appendChild(el('div', { class: 'empty' }, `未找到与「${state.q}」相关的结果`)); return; }
      wrap.appendChild(el('div', { class: 'section-title' }, [el('h3', {}, `搜索结果（${list.length}）`)]));
      const grid = el('div', { class: 'grid' });
      list.forEach((it) => grid.appendChild(card(it)));
      wrap.appendChild(grid);
    } catch (e) {
      clear(wrap);
      const box = el('div', {}, [banner('warn', `搜索失败：${e.message}`)]);
      box.appendChild(el('div', { class: 'empty' }, [
        el('button', { class: 'btn', onclick: () => doSearch() }, '重试'),
      ]));
      wrap.appendChild(box);
    } finally {
      state.searching = false;
    }
  }

  // ---- 浏览历史（仅浏览器本地，供「猜你喜欢」使用） ----
  const HISTORY_KEY = 'qy_history';
  function historyIds(limit = 20) {
    try {
      const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(list) ? list.slice(0, limit) : [];
    } catch { return []; }
  }
  function rememberHistory(id) {
    const key = String(id || '');
    if (!/^(?:\d{1,10}|4kcz-\d{1,8})$/.test(key)) return;
    try {
      const list = historyIds(20).filter((x) => x !== key);
      list.unshift(key);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
    } catch { /* 隐私模式下写入失败可忽略 */ }
  }

  // ---- 创意频道 ----
  function renderChannels() {
    clear(app);
    app.appendChild(el('section', { class: 'hero' }, [
      el('h2', {}, '创意频道'),
      el('p', {}, '把好片整理成一个个可逛的主题空间：榜单、系列、演员与国漫，按规则精挑细选，点开就有方向。'),
    ]));
    const wrap = el('div', { id: 'channelWrap' });
    app.appendChild(wrap);
    wrap.appendChild(spinner());
    api('/api/vod/channels').then((data) => {
      clear(wrap);
      const grid = el('div', { class: 'channel-grid' });
      (Array.isArray(data.list) ? data.list : []).forEach((c) => {
        grid.appendChild(el('div', { class: 'channel-card', onclick: () => openChannel(c) }, [
          el('div', { class: 'channel-icon' }, c.icon || '🎬'),
          el('div', { class: 'channel-name' }, c.name),
          el('div', { class: 'channel-desc' }, c.desc || ''),
          el('div', { class: 'channel-more' }, '进入频道 →'),
        ]));
      });
      wrap.appendChild(grid);
    }).catch((e) => {
      clear(wrap);
      wrap.appendChild(banner('warn', `频道加载失败：${e.message}`));
    });
  }

  function openChannel(c, pg = 1) {
    clear(app);
    const hint = el('span', { class: 'filter-hint' });
    app.appendChild(el('div', { class: 'channel-detail-head' }, [
      el('button', { class: 'btn ghost', onclick: renderChannels }, '← 全部频道'),
      el('div', { class: 'channel-detail-title' }, [
        el('span', { class: 'channel-icon' }, c.icon || '🎬'),
        el('div', {}, [
          el('h2', {}, c.name),
          el('p', {}, c.desc || ''),
          hint,
        ]),
      ]),
    ]));
    const wrap = el('div', {});
    app.appendChild(wrap);
    loadChannelInto(c, pg, wrap, hint);
  }

  async function loadChannelInto(c, pg, wrap, hint) {
    clear(wrap);
    wrap.appendChild(spinner('频道片源加载中…（首次采集约 10–20 秒）'));
    try {
      const isGuess = c.id === 'guess';
      const opts = isGuess
        ? { method: 'POST', body: { seeds: historyIds(5), exclude: historyIds(20) } }
        : {};
      const data = await api(`/api/vod/channel?id=${encodeURIComponent(c.id)}&pg=${pg}`, opts);
      const list = Array.isArray(data.list) ? data.list : [];
      if (hint && isGuess) {
        hint.textContent = data.channel && data.channel.personalized
          ? '已根据你的浏览记录个性化推荐'
          : '暂无浏览记录，先为你推荐口碑榜；点开几部影片后再来看看';
      }
      clear(wrap);
      if (!list.length) {
        wrap.appendChild(el('div', { class: 'empty' }, '该频道暂无片源，稍后再来看看'));
        return;
      }
      const grid = el('div', { class: 'grid' });
      list.forEach((it) => grid.appendChild(card(it)));
      wrap.appendChild(grid);
      const page = Number(data.page) || 1;
      const pageCount = Number(data.pagecount) || 1;
      if (pageCount > 1) {
        wrap.appendChild(el('div', { class: 'pager' }, [
          page > 1 ? el('button', { class: 'btn ghost', onclick: () => openChannel(c, page - 1) }, '上一页') : null,
          el('span', { class: 'page-info' }, `${page} / ${pageCount}`),
          page < pageCount ? el('button', { class: 'btn ghost', onclick: () => openChannel(c, page + 1) }, '下一页') : null,
        ].filter(Boolean)));
      }
    } catch (e) {
      clear(wrap);
      wrap.appendChild(banner('warn', `频道加载失败：${e.message}`));
      wrap.appendChild(el('div', { class: 'empty' }, [
        el('button', { class: 'btn', onclick: () => openChannel(c, pg) }, '重试'),
      ]));
    }
  }

  // ---- detail modal ----
  function parsePlaySources(detail) {
    const from = String(detail.vod_play_from || '');
    const url = String(detail.vod_play_url || '');
    const sources = from.split(/\${3,}/).map((s) => s.trim()).filter(Boolean);
    const urls = url.split(/\${3,}/);
    return sources.map((name, i) => {
      const eps = (urls[i] || '').split('#').map((pair) => {
        const idx = pair.indexOf('$');
        if (idx < 0) return { name: pair || '播放', url: '' };
        return { name: pair.slice(0, idx) || '播放', url: pair.slice(idx + 1) };
      }).filter((ep) => ep.url);
      return { name: name || `趣影${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][i] || (i + 1)}线`, episodes: eps };
    }).filter((s) => s.episodes.length);
  }

  async function openDetail(vodId) {
    modal.classList.remove('hidden');
    clear(modalCard);
    modalCard.appendChild(spinner());
    try {
      const data = await api(`/api/vod/detail?ids=${encodeURIComponent(vodId)}`);
      const d = (Array.isArray(data.list) && data.list[0]) || data;
      renderModal(d);
      rememberHistory(vodId);
    } catch (e) {
      clear(modalCard);
      modalCard.appendChild(el('div', { style: 'padding:40px' }, [banner('err', `详情加载失败：${e.message}`)]));
    }
  }

  function renderModal(d) {
    clear(modalCard);
    const close = el('button', { class: 'modal-close', onclick: closeModal, 'aria-label': '关闭' }, '×');
    const head = el('div', { class: 'detail-head' });
    const poster = el('div', { class: 'detail-poster' });
    if (d.vod_pic) poster.style.backgroundImage = `url("${d.vod_pic}")`;
    const info = el('div', { class: 'detail-info' }, [
      el('h2', {}, d.vod_name || '未命名'),
      el('div', { class: 'detail-meta' }, [
        d.type_name ? el('span', {}, `类型：${d.type_name}`) : null,
        d.vod_year ? el('span', {}, String(d.vod_year)) : null,
        d.vod_area ? el('span', {}, `地区：${d.vod_area}`) : null,
        d.vod_remarks ? el('span', {}, `备注：${d.vod_remarks}`) : null,
      ].filter(Boolean)),
      el('div', { class: 'detail-desc' }, d.vod_content ? d.vod_content.replace(/<[^>]+>/g, '') : '暂无简介'),
    ]);
    head.appendChild(poster);
    head.appendChild(info);
    modalCard.appendChild(close);
    modalCard.appendChild(head);

    const sources = parsePlaySources(d);
    const playWrap = el('div', { class: 'play-sources' });
    if (!sources.length) {
      playWrap.appendChild(banner('warn', '暂无可解析的播放源'));
    } else {
      playWrap.appendChild(el('h4', {}, '播放源'));
      sources.forEach((s) => {
        const grp = el('div', { class: 'source-group' }, [el('div', { class: 'src-name' }, s.name)]);
        const eps = el('div', { class: 'episodes' });
        s.episodes.forEach((ep) => {
          eps.appendChild(el('span', { class: 'ep', title: ep.url, onclick: () => window.open(ep.url, '_blank', 'noopener') }, ep.name));
        });
        grp.appendChild(eps);
        playWrap.appendChild(grp);
      });
    }
    modalCard.appendChild(playWrap);
  }

  function closeModal() { modal.classList.add('hidden'); }
  modal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---- tvbox ----
  async function renderTvbox() {
    clear(app);
    app.appendChild(el('section', { class: 'hero' }, [
      el('h2', {}, 'TVBox 配置'),
      el('p', {}, '将下方配置地址填入 TVBox / 影视仓等播放器的「配置地址」，即可加载「趣影」点播源。'),
    ]));
    const panel = el('div', { class: 'panel' });
    app.appendChild(panel);
    panel.appendChild(el('h3', {}, '配置地址'));
    const card = cardCode();
    if (!card) {
      panel.appendChild(el('div', { class: 'banner warn', style: 'margin-bottom:10px' }, '未检测到授权卡密：请先点击右上角「授权」输入卡密，否则配置地址无法加载片库。'));
    }
    const row = el('div', { class: 'copy-row' });
    const cfgUrl = `${location.origin}/api/vod/tvbox${card ? '?code=' + encodeURIComponent(card) : ''}`;
    row.appendChild(el('code', {}, cfgUrl));
    const copyBtn = el('button', { class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(cfgUrl); copyBtn.textContent = '已复制 ✓'; setTimeout(() => copyBtn.textContent = '复制', 1500); }
      catch { copyBtn.textContent = '复制失败'; }
    } }, '复制');
    row.appendChild(copyBtn);
    panel.appendChild(row);

    panel.appendChild(el('h3', { style: 'margin-top:18px' }, '使用说明'));
    panel.appendChild(el('ul', { style: 'font-size:13px;color:var(--text-dim);line-height:1.9;padding-left:20px;margin:6px 0 0' }, [
      el('li', {}, '配置为 MacCMS 兼容源，接口为 '),
      el('li', {}, '支持分类筛选与二级分类、搜索、详情；播放地址由本站实时解析为短时有效的 m3u8。'),
      el('li', {}, '播放源：详情中「趣影一线」为暴风源，「趣影二线」为 4K 源；详情页也可在 Web 端直接播放。'),
      el('li', {}, '如播放器无法加载，请确认配置地址可公网访问，且当前部署域名与 PUBLIC_URL 一致。'),
    ]));
    const apiLi = panel.querySelector('ul li');
    if (apiLi) apiLi.appendChild(el('code', {}, '/api.php/provide/vod'));
    panel.appendChild(el('h3', { style: 'margin-top:18px' }, 'tvbox.json 内容'));
    const pre = el('pre', { class: 'json' }, '加载中…');
    panel.appendChild(pre);
    try {
      const data = await api('/api/vod/tvbox');
      pre.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      pre.textContent = `加载失败：${e.message}`;
    }
  }

  // ---- docs ----
  function renderDocs() {
    clear(app);
    app.appendChild(el('section', { class: 'hero' }, [el('h2', {}, 'API 文档'), el('p', {}, '趣影对外提供以下只读接口，均返回 JSON。')]));
    const rows = [
      ['GET', '/api/health', '本站健康检查', '—'],
      ['GET', '/api/vod/tvbox', 'TVBox 配置 JSON', '—'],
      ['GET', '/api/vod/list', '影片列表', 'pg（页码）、t（分类，见下方）、year（可选）'],
      ['GET', '/api/vod/kan', '首页/栏目推荐（匹配本站可播片源）', 'section（home/movie/tv/variety/anime）、limit（1–30，默认 12）'],
      ['GET', '/api/vod/search', '搜索', 'wd（关键词）'],
      ['GET', '/api/vod/detail', '影片详情', 'ids（影片 ID）'],
      ['GET', '/api/vod/channels', '创意频道清单', '—'],
      ['GET/POST', '/api/vod/channel', '频道片源（候选池快照分页）', 'id（频道 ID）、pg；id=guess 时 POST {seeds, exclude}'],
      ['GET', '/play.m3u8', '播放地址解析', 'id（影片 ID）、p（集序号，从 0 开始）'],
    ];
    const table = el('table', { class: 'docs' }, [
      el('thead', {}, [el('tr', {}, ['方法', '路径', '说明', '参数'].map((h) => el('th', {}, h)))]),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', {}, i === 1 ? el('code', {}, c) : c))))),
    ]);
    const panel1 = el('div', { class: 'panel' }, [el('h3', {}, '接口列表'), table]);
    app.appendChild(panel1);

    const catRows = [];
    CATEGORIES.forEach((grp) => grp.items.forEach((c) => {
      catRows.push([grp.group, c.name, c.t || '（空）']);
      (c.subs || []).forEach((s) => catRows.push([`${grp.group} · ${c.name}`, s.name, String(s.t)]));
    }));
    RANKS.forEach((r) => catRows.push(['榜单（排序，非一级分类）', r.name, r.t]));
    const catTable = el('table', { class: 'docs' }, [
      el('thead', {}, [el('tr', {}, ['分组', '名称', 't 值'].map((h) => el('th', {}, h)))]),
      el('tbody', {}, catRows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))),
    ]);
    app.appendChild(el('div', { class: 'panel' }, [el('h3', {}, '分类参数 t'), catTable]));

    app.appendChild(el('div', { class: 'panel' }, [
      el('h3', {}, '说明'),
      el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.8' },
        '数据来自公开影视元数据接口，本站不存储影片文件。播放地址为短时有效的 m3u8，访问 /play.m3u8 时实时解析。'),
      el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.8' },
        '榜单参数：t=new 最新（按更新时间）、t=hot 最热（按点击量）、t=score 高分推荐（按评分），均可与 year 组合使用；它们也出现在 TVBox 的分类（class）中。'),
      el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.8' },
        '播放源：详情 vod_play_from 中「趣影一线」为暴风源，「趣影二线」为 4K 源；4K 源可用时会自动按片名+年份匹配合并，vod_play_url 以 $$$ 与之一一对应。'),
      el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.8' },
        '创意频道：/api/vod/channels 返回频道清单（高分榜、口碑榜、猜你喜欢、影视系列、明星频道、国漫）。频道片源优先从本站数据库筛选，不足时自动采集并入库；高分榜/口碑榜评分来自采集站点，非豆瓣官方数据。id=guess 需 POST JSON：seeds（最近浏览的影片 ID，≤5 个）、exclude（需排除的 ID，≤20 个），无有效种子时回退口碑榜；该接口响应为 no-store，浏览记录不上共享缓存。'),
      el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.8' },
        '推荐片单：/api/vod/kan 采集公开首页与各栏目（section=home/movie/tv/variety/anime）的推荐标题，再用片名精确匹配本站已有 4K / 暴风片源，返回的 vod_id 均为本站可播放 ID；推荐来源仅作标题参考，不直接播放。全部匹配失败时回退为对应分类列表（source=fallback）。'),
    ]));
  }

  // ---- router ----
  function setView(v) {
    state.view = v;
    document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    if (v === 'home') renderHome();
    else if (v === 'search') renderSearch();
    else if (v === 'channels') renderChannels();
    else if (v === 'tvbox') renderTvbox();
    else if (v === 'docs') renderDocs();
  }

  document.querySelectorAll('.nav-link').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); });
  });

  // ---- boot ----
  function injectCardButton() {
    const nav = document.querySelector('nav.nav');
    if (!nav) return;
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'nav-link';
    a.id = 'cardNavBtn';
    a.textContent = cardCode() ? '授权 ✓' : '授权';
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const c = await showCardDialog(cardCode() ? '更新授权卡密（留空并确定可清除）：' : '请输入授权卡密以访问片库：');
      if (c != null) {
        if (c) { try { localStorage.setItem(CARD_KEY, c); } catch {} }
        else { try { localStorage.removeItem(CARD_KEY); } catch {} }
        a.textContent = cardCode() ? '授权 ✓' : '授权';
      }
    });
    nav.appendChild(a);
  }

  async function boot() {
    // URL 带 ?code= 时落地到本地，便于分享带授权的链接
    try {
      const urlCode = bootParams.get('code');
      if (urlCode) localStorage.setItem(CARD_KEY, urlCode.trim());
    } catch {}
    injectCardButton();
    try {
      const conf = await api('/api/site');
      site = { ...site, ...conf };
    } catch { /* 使用默认站点配置 */ }
    document.title = `${site.name} · 在线点播`;
    const nameEl = document.querySelector('.brand-text h1');
    const subEl = document.querySelector('.brand-text .subtitle');
    if (nameEl) nameEl.textContent = site.name;
    if (subEl) subEl.textContent = site.subtitle;
    const footEl = document.querySelector('.footer p');
    if (footEl && site.footer) footEl.textContent = site.footer;
    refreshHealth();
    loadNavAd();
    renderHome();
  }

  boot();
})();
