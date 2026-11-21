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
    ]},
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

  const state = { view: 'home', t: '', year: '', pg: 1, pagesize: 40, q: '', total: 0, pageCount: 1, list: [], loading: false, error: '' };
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
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

  async function api(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function spinner() { return el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('div', { style: 'margin-top:12px' }, '加载中…')]); }

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
    const poster = el('div', { class: 'poster' });
    if (pic) {
      poster.style.backgroundImage = `url("${pic.replace(/"/g, '%22')}")`;
      const img = new Image();
      img.onerror = () => { poster.style.backgroundImage = ''; poster.appendChild(el('div', { class: 'placeholder' }, '暂无海报')); };
      img.src = pic;
    } else {
      poster.appendChild(el('div', { class: 'placeholder' }, '暂无海报'));
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
    return el('div', { class: 'pager' }, [
      el('button', { class: 'btn ghost', disabled: state.pg <= 1 || state.loading, onclick: () => changePage(state.pg - 1) }, '上一页'),
      el('span', { class: 'page-info' }, `${state.pg} / ${state.pageCount}`),
      el('button', { class: 'btn ghost', disabled: state.pg >= state.pageCount || state.loading, onclick: () => changePage(state.pg + 1) }, '下一页'),
    ]);
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
    }
    const hint = document.getElementById('filterHint');
    if (hint) hint.textContent = filterSummary();
    loadList();
  }

  function categoryLabel(t) {
    const s = String(t || '');
    if (!s) return '全部';
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

  // ---- 顶部导航广告 ----
  async function loadNavAd() {
    const bar = document.getElementById('navAdBar');
    if (!bar || !site.adsEnabled) return;
    try {
      const data = await api('/api/ads?slot=nav');
      const ad = (data.list || [])[0];
      if (!ad) return;
      bar.classList.remove('hidden');
      clear(bar);
      bar.appendChild(el('a', {
        class: 'nav-ad',
        href: ad.link || '#',
        target: ad.link && !ad.link.startsWith('/') ? '_blank' : '_self',
        rel: 'noopener',
        onclick: (e) => { if (!ad.link) e.preventDefault(); },
      }, [
        ad.image ? el('img', { src: ad.image, alt: ad.title || '推广' }) : null,
        el('span', { class: 'nav-ad-text' }, ad.title || '推广位'),
        el('span', { class: 'nav-ad-badge' }, 'AD'),
      ].filter(Boolean)));
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

  function setYear(y) {
    state.year = y;
    state.pg = 1;
    document.querySelectorAll('.pill[data-year]').forEach((b) => b.classList.toggle('active', b.dataset.year === y));
    const hint = document.getElementById('filterHint');
    if (hint) hint.textContent = filterSummary();
    const wrap = document.getElementById('listWrap');
    if (wrap) loadListInto(wrap);
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
        el('span', { class: 'cat-panel-title' }, '片库'),
        el('span', { class: 'filter-hint', id: 'filterHint' }, filterSummary()),
      ]),
      el('div', { id: 'catNavHost' }, [categoryNav(), yearPills()]),
    ]));

    const listWrap = el('div', { id: 'listWrap' });
    app.appendChild(listWrap);
    app.appendChild(el('div', { id: 'pagerHost' }));
    loadListInto(listWrap);
  }

  async function loadListInto(wrap) {
    clear(wrap);
    wrap.appendChild(spinner());
    try {
      const yearParam = /^\d{4}$/.test(state.year) ? `&year=${state.year}` : '';
      const data = await api(`/api/vod/list?pg=${state.pg}${state.t ? '&t=' + encodeURIComponent(state.t) : ''}${yearParam}`);
      state.list = Array.isArray(data.list) ? data.list : [];
      state.total = Number(data.total) || 0;
      state.pageCount = Number(data.pagecount) || 1;
      state.error = '';
      clear(wrap);
      wrap.appendChild(renderGrid());
      const pagerHost = document.getElementById('pagerHost');
      if (pagerHost) {
        clear(pagerHost);
        const pager = renderPager();
        if (pager) pagerHost.appendChild(pager);
      }
    } catch (e) {
      state.list = [];
      state.error = e.message;
      clear(wrap);
      wrap.appendChild(banner('warn', `列表加载失败：${e.message}（上游接口可能暂不可用，稍后再试）`));
      const pagerHost = document.getElementById('pagerHost');
      if (pagerHost) clear(pagerHost);
    }
  }

  function loadList() {
    const wrap = document.getElementById('listWrap');
    if (wrap) loadListInto(wrap);
    else renderHome();
  }

  function changePage(p) {
    if (p < 1 || p > state.pageCount) return;
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
    clear(wrap);
    wrap.appendChild(spinner());
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
      wrap.appendChild(banner('warn', `搜索失败：${e.message}`));
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
    const row = el('div', { class: 'copy-row' });
    const cfgUrl = `${location.origin}/api/vod/tvbox`;
    row.appendChild(el('code', {}, cfgUrl));
    const copyBtn = el('button', { class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(cfgUrl); copyBtn.textContent = '已复制 ✓'; setTimeout(() => copyBtn.textContent = '复制', 1500); }
      catch { copyBtn.textContent = '复制失败'; }
    } }, '复制');
    row.appendChild(copyBtn);
    panel.appendChild(row);

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
      ['GET', '/api/vod/search', '搜索', 'wd（关键词）'],
      ['GET', '/api/vod/detail', '影片详情', 'ids（影片 ID）'],
    ];
    const table = el('table', { class: 'docs' }, [
      el('thead', {}, [el('tr', {}, ['方法', '路径', '说明', '参数'].map((h) => el('th', {}, h)))]),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', {}, i === 1 ? el('code', {}, c) : c))))),
    ]);
    const panel1 = el('div', { class: 'panel' }, [el('h3', {}, '接口列表'), table]);
    app.appendChild(panel1);

    const catRows = [];
    CATEGORIES.forEach((grp) => grp.items.forEach((c) => catRows.push([grp.group, c.name, c.t || '（空）'])));
    const catTable = el('table', { class: 'docs' }, [
      el('thead', {}, [el('tr', {}, ['分组', '名称', 't 值'].map((h) => el('th', {}, h)))]),
      el('tbody', {}, catRows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))),
    ]);
    app.appendChild(el('div', { class: 'panel' }, [el('h3', {}, '分类参数 t'), catTable]));

    app.appendChild(el('div', { class: 'panel' }, [
      el('h3', {}, '说明'),
      el('p', { style: 'font-size:13px;color:var(--text-dim);line-height:1.8' },
        '数据来自公开影视元数据接口，本站不存储影片文件。播放地址为短时有效的 m3u8，访问 /play.m3u8 时实时解析。'),
    ]));
  }

  // ---- router ----
  function setView(v) {
    state.view = v;
    document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    if (v === 'home') renderHome();
    else if (v === 'search') renderSearch();
    else if (v === 'tvbox') renderTvbox();
    else if (v === 'docs') renderDocs();
  }

  document.querySelectorAll('.nav-link').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); });
  });

  // ---- boot ----
  async function boot() {
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
