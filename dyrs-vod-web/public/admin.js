// 趣影后台前端：登录、概览、广告位、卡密、站点设置
(() => {
  'use strict';

  const loginView = document.getElementById('loginView');
  const adminView = document.getElementById('adminView');
  const panel = document.getElementById('panel');
  const pageTitle = document.getElementById('pageTitle');
  const pageSub = document.getElementById('pageSub');
  const toastEl = document.getElementById('toast');
  const loginForm = document.getElementById('loginForm');
  const loginErr = document.getElementById('loginErr');

  let tab = 'overview';
  let editingAdId = null;
  let cardStatus = '';
  let cardQuery = '';
  let cardPage = 1;

  // ---- 基础工具 ----
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const key in attrs) {
      const value = attrs[key];
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value != null && value !== false) node.setAttribute(key, value);
    }
    (Array.isArray(children) ? children : [children]).forEach((child) => {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  let toastTimer = null;
  function toast(message, type = 'ok') {
    toastEl.textContent = message;
    toastEl.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }

  async function api(path, options = {}) {
    const init = { credentials: 'same-origin', method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON */ }
    if (!res.ok || (data && data.ok === false)) {
      const error = new Error((data && data.error) || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function statCard(label, value, sub) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, String(value)),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ].filter(Boolean));
  }

  function setHead(title, sub) {
    pageTitle.textContent = title;
    pageSub.textContent = sub;
  }

  // ---- 登录 ----
  async function checkSession() {
    try {
      const data = await api('/api/admin/session');
      if (data.authed) showAdmin();
      else showLogin();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginView.classList.remove('hidden');
    adminView.classList.add('hidden');
    document.getElementById('loginPassword').focus();
  }

  function showAdmin() {
    loginView.classList.add('hidden');
    adminView.classList.remove('hidden');
    renderTab(tab);
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('loginPassword');
    const button = loginForm.querySelector('button[type="submit"]');
    loginErr.textContent = '';
    button.disabled = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: input.value } });
      input.value = '';
      showAdmin();
      toast('登录成功');
    } catch (error) {
      loginErr.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* 忽略 */ }
    showLogin();
  });

  // ---- 导航 ----
  document.querySelectorAll('.side-link[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.side-link[data-tab]').forEach((b) => b.classList.toggle('active', b === button));
      tab = button.dataset.tab;
      editingAdId = null;
      renderTab(tab);
    });
  });

  async function renderTab(name) {
    clear(panel);
    try {
      if (name === 'overview') await renderOverview();
      else if (name === 'ads') await renderAds();
      else if (name === 'cards') await renderCards();
      else if (name === 'settings') await renderSettings();
    } catch (error) {
      if (error.status === 401) { showLogin(); return; }
      clear(panel);
      panel.appendChild(el('div', { class: 'panel-card' }, [
        el('h3', {}, '加载失败'),
        el('p', { class: 'desc' }, error.message),
      ]));
    }
  }

  // ---- 概览 ----
  async function renderOverview() {
    setHead('概览', '站点运行状态一览');
    const { data } = await api('/api/admin/overview');
    panel.appendChild(el('div', { class: 'stat-grid' }, [
      statCard('影片缓存', data.vods, 'SQLite 已入库影片'),
      statCard('查询快照', data.queries, '列表 / 搜索 / 详情缓存'),
      statCard('轮播广告', `${data.carousel} / 5`, '首页顶部轮播位'),
      statCard('导航广告', data.navAds, '顶部导航广告条'),
      statCard('卡密总数', data.cardsTotal, `未用 ${data.cards.unused} · 已用 ${data.cards.used}`),
    ]));
    panel.appendChild(el('div', { class: 'panel-card' }, [
      el('h3', {}, '常用操作'),
      el('p', { class: 'desc' }, '广告位影响前台首屏展示；卡密可用于后续会员/授权分发；站点设置会即时同步到前台。'),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn small', onclick: () => { tab = 'ads'; document.querySelector('.side-link[data-tab="ads"]').click(); } }, '管理广告位'),
        el('button', { class: 'btn small ghost', onclick: () => { tab = 'cards'; document.querySelector('.side-link[data-tab="cards"]').click(); } }, '生成卡密'),
        el('button', { class: 'btn small ghost', onclick: () => { tab = 'settings'; document.querySelector('.side-link[data-tab="settings"]').click(); } }, '修改站点信息'),
      ]),
    ]));
  }

  // ---- 广告位 ----
  function adForm() {
    const form = el('form', { class: 'panel-card' }, [
      el('h3', {}, editingAdId ? `编辑广告 #${editingAdId}` : '新增广告'),
      el('p', { class: 'desc' }, '轮播位最多 5 条，建议使用 16:9 高清图；导航位建议使用精简标题 + 小图标。'),
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [
          el('label', {}, '广告位'),
          el('select', { id: 'adSlot' }, [
            el('option', { value: 'carousel' }, '首页轮播（5 图）'),
            el('option', { value: 'nav' }, '顶部导航条'),
          ]),
        ]),
        el('div', { class: 'field' }, [
          el('label', {}, '排序（越小越靠前）'),
          el('input', { id: 'adSort', type: 'number', value: '0' }),
        ]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, '标题'), el('input', { id: 'adTitle', placeholder: '例如：年度科幻巨制《奥德赛》' })]),
      el('div', { class: 'field' }, [el('label', {}, '图片地址（http/https）'), el('input', { id: 'adImage', placeholder: 'https://…/banner.jpg' })]),
      el('div', { class: 'field' }, [el('label', {}, '跳转链接（可选，站内用 / 开头）'), el('input', { id: 'adLink', placeholder: 'https://… 或 /' })]),
      el('div', { class: 'field' }, [
        el('label', {}, '状态'),
        el('div', { class: 'check' }, [el('input', { id: 'adEnabled', type: 'checkbox', checked: 'checked' }), el('span', {}, '启用')]),
      ]),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn', type: 'submit' }, editingAdId ? '保存修改' : '新增广告'),
        editingAdId ? el('button', { class: 'btn ghost', type: 'button', onclick: () => { editingAdId = null; renderTab('ads'); } }, '取消编辑') : null,
      ].filter(Boolean)),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = {
        slot: document.getElementById('adSlot').value,
        title: document.getElementById('adTitle').value.trim(),
        image: document.getElementById('adImage').value.trim(),
        link: document.getElementById('adLink').value.trim(),
        sort: Number(document.getElementById('adSort').value) || 0,
        enabled: document.getElementById('adEnabled').checked,
      };
      try {
        if (editingAdId) await api(`/api/admin/ads/${editingAdId}`, { method: 'PUT', body });
        else await api('/api/admin/ads', { method: 'POST', body });
        editingAdId = null;
        toast('广告已保存');
        renderTab('ads');
      } catch (error) {
        toast(error.message, 'err');
      }
    });
    return form;
  }

  async function renderAds() {
    setHead('广告位', '首页轮播与顶部导航广告');
    const { list } = await api('/api/admin/ads');
    const form = adForm();
    panel.appendChild(form);

    if (editingAdId) {
      const ad = list.find((item) => item.id === editingAdId);
      if (ad) {
        document.getElementById('adSlot').value = ad.slot;
        document.getElementById('adTitle').value = ad.title;
        document.getElementById('adImage').value = ad.image;
        document.getElementById('adLink').value = ad.link;
        document.getElementById('adSort').value = String(ad.sort);
        document.getElementById('adEnabled').checked = ad.enabled;
      }
    }

    const rows = list.map((ad) => el('tr', {}, [
      el('td', {}, ad.slot === 'carousel' ? '轮播' : '导航'),
      el('td', {}, ad.image ? el('img', { class: 'thumb', src: ad.image, alt: ad.title || '广告' }) : '—'),
      el('td', {}, ad.title || '—'),
      el('td', {}, ad.link ? el('span', { class: 'muted' }, ad.link) : '—'),
      el('td', {}, String(ad.sort)),
      el('td', {}, el('span', { class: `badge ${ad.enabled ? 'on' : 'off'}` }, ad.enabled ? '启用' : '停用')),
      el('td', {}, el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn small ghost',
          onclick: () => { editingAdId = ad.id; renderTab('ads'); },
        }, '编辑'),
        el('button', {
          class: 'btn small ghost',
          onclick: async () => {
            try {
              await api(`/api/admin/ads/${ad.id}`, { method: 'PUT', body: { enabled: !ad.enabled } });
              toast(ad.enabled ? '已停用' : '已启用');
              renderTab('ads');
            } catch (error) { toast(error.message, 'err'); }
          },
        }, ad.enabled ? '停用' : '启用'),
        el('button', {
          class: 'btn small danger',
          onclick: async () => {
            if (!confirm(`确定删除广告「${ad.title || ad.id}」？`)) return;
            try {
              await api(`/api/admin/ads/${ad.id}`, { method: 'DELETE' });
              toast('已删除');
              if (editingAdId === ad.id) editingAdId = null;
              renderTab('ads');
            } catch (error) { toast(error.message, 'err'); }
          },
        }, '删除'),
      ])),
    ]));

    panel.appendChild(el('div', { class: 'panel-card' }, [
      el('h3', {}, `现有广告（${list.length}）`),
      list.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, ['位置', '图片', '标题', '链接', '排序', '状态', '操作'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      ])) : el('div', { class: 'empty' }, '还没有广告，添加后前台会立即生效'),
    ]));
  }

  // ---- 卡密 ----
  function cardFilterBar() {
    const statusSelect = el('select', {
      onchange: (event) => { cardStatus = event.target.value; cardPage = 1; renderTab('cards'); },
    }, [
      el('option', { value: '' }, '全部状态'),
      el('option', { value: 'unused' }, '未使用'),
      el('option', { value: 'used' }, '已使用'),
      el('option', { value: 'disabled' }, '已停用'),
    ]);
    statusSelect.value = cardStatus;
    const search = el('input', {
      placeholder: '搜索卡密…',
      value: cardQuery,
      onkeydown: (event) => { if (event.key === 'Enter') { cardQuery = event.target.value.trim(); cardPage = 1; renderTab('cards'); } },
    });
    return el('div', { class: 'toolbar' }, [
      el('div', { class: 'field' }, [el('label', {}, '状态'), statusSelect]),
      el('div', { class: 'field grow' }, [el('label', {}, '搜索'), search]),
      el('button', {
        class: 'btn small ghost',
        onclick: () => { cardQuery = search.value.trim(); cardPage = 1; renderTab('cards'); },
      }, '查询'),
      el('a', { class: 'btn small ghost', href: '/api/admin/cards/export', target: '_blank', rel: 'noopener' }, '导出 CSV'),
    ]);
  }

  function generateForm() {
    const form = el('form', { class: 'panel-card' }, [
      el('h3', {}, '批量生成卡密'),
      el('p', { class: 'desc' }, '卡密可用于会员开通、TVBox 授权或活动分发；生成后可复制或导出 CSV。'),
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [el('label', {}, '数量（1-500）'), el('input', { id: 'cardCount', type: 'number', value: '10', min: '1', max: '500' })]),
        el('div', { class: 'field' }, [el('label', {}, '有效天数'), el('input', { id: 'cardDays', type: 'number', value: '30', min: '1', max: '3650' })]),
        el('div', { class: 'field' }, [el('label', {}, '前缀'), el('input', { id: 'cardPrefix', value: 'QY', maxlength: '8' })]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, '备注（可选）'), el('input', { id: 'cardNote', placeholder: '例如：双十一活动' })]),
      el('div', { class: 'actions' }, [el('button', { class: 'btn', type: 'submit' }, '生成卡密')]),
      el('div', { id: 'genResult', class: 'codes hidden' }),
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = {
        count: Number(document.getElementById('cardCount').value) || 1,
        days: Number(document.getElementById('cardDays').value) || 30,
        prefix: document.getElementById('cardPrefix').value.trim() || 'QY',
        note: document.getElementById('cardNote').value.trim(),
      };
      try {
        const data = await api('/api/admin/cards/generate', { method: 'POST', body });
        const result = document.getElementById('genResult');
        result.classList.remove('hidden');
        result.textContent = data.codes.join('\n');
        toast(`已生成 ${data.codes.length} 个卡密`);
        renderCardsTable(document.getElementById('cardsTableHost'));
      } catch (error) {
        toast(error.message, 'err');
      }
    });
    return form;
  }

  async function renderCards() {
    setHead('卡密', '生成、查询与停用授权卡密');
    panel.appendChild(generateForm());
    panel.appendChild(cardFilterBar());
    const host = el('div', { id: 'cardsTableHost', class: 'panel-card' });
    panel.appendChild(host);
    await renderCardsTable(host);
  }

  async function renderCardsTable(host) {
    if (!host) return;
    clear(host);
    const params = new URLSearchParams();
    if (cardStatus) params.set('status', cardStatus);
    if (cardQuery) params.set('q', cardQuery);
    params.set('page', String(cardPage));
    try {
      const { data } = await api(`/api/admin/cards?${params.toString()}`);
      const rows = data.list.map((card) => el('tr', {}, [
        el('td', {}, el('span', { class: 'code' }, card.code)),
        el('td', {}, `${card.days} 天`),
        el('td', {}, el('span', {
          class: `badge ${card.status === 'unused' ? 'on' : card.status === 'used' ? 'used' : 'disabled'}`,
        }, card.status === 'unused' ? '未使用' : card.status === 'used' ? '已使用' : '已停用')),
        el('td', {}, card.note || '—'),
        el('td', {}, fmtTime(card.createdAt)),
        el('td', {}, el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn small ghost',
            onclick: async () => {
              try {
                await api(`/api/admin/cards/${card.id}`, { method: 'PATCH', body: { status: card.status === 'disabled' ? 'unused' : 'disabled' } });
                toast(card.status === 'disabled' ? '已恢复' : '已停用');
                renderCardsTable(host);
              } catch (error) { toast(error.message, 'err'); }
            },
          }, card.status === 'disabled' ? '恢复' : '停用'),
          el('button', {
            class: 'btn small danger',
            onclick: async () => {
              if (!confirm(`确定删除卡密 ${card.code}？`)) return;
              try {
                await api(`/api/admin/cards/${card.id}`, { method: 'DELETE' });
                toast('已删除');
                renderCardsTable(host);
              } catch (error) { toast(error.message, 'err'); }
            },
          }, '删除'),
        ])),
      ]));

      host.appendChild(el('h3', {}, `卡密列表（${data.total}）`));
      host.appendChild(data.list.length
        ? el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, [
            el('thead', {}, el('tr', {}, ['卡密', '天数', '状态', '备注', '创建时间', '操作'].map((h) => el('th', {}, h)))),
            el('tbody', {}, rows),
          ]))
        : el('div', { class: 'empty' }, '暂无卡密'));

      if (data.pagecount > 1) {
        host.appendChild(el('div', { class: 'actions', style: 'margin-top:14px' }, [
          el('button', {
            class: 'btn small ghost',
            disabled: data.page <= 1 ? 'disabled' : null,
            onclick: () => { cardPage = Math.max(1, data.page - 1); renderCardsTable(host); },
          }, '上一页'),
          el('span', { class: 'muted', style: 'align-self:center' }, `${data.page} / ${data.pagecount}`),
          el('button', {
            class: 'btn small ghost',
            disabled: data.page >= data.pagecount ? 'disabled' : null,
            onclick: () => { cardPage = Math.min(data.pagecount, data.page + 1); renderCardsTable(host); },
          }, '下一页'),
        ]));
      }
    } catch (error) {
      if (error.status === 401) { showLogin(); return; }
      host.appendChild(el('div', { class: 'empty' }, `加载失败：${error.message}`));
    }
  }

  // ---- 站点设置与授权 ----
  async function renderSettings() {
    setHead('站点与授权', '站点文案、广告开关与管理员密码');
    const { data } = await api('/api/admin/settings');

    const settingsForm = el('form', { class: 'panel-card' }, [
      el('h3', {}, '站点设置'),
      el('p', { class: 'desc' }, '保存后前台会自动读取最新配置。'),
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [el('label', {}, '站点名称'), el('input', { id: 'siteName', value: data.site_name || '' })]),
        el('div', { class: 'field' }, [el('label', {}, '副标题'), el('input', { id: 'siteSubtitle', value: data.site_subtitle || '' })]),
      ]),
      el('div', { class: 'field' }, [el('label', {}, '首页公告（留空不显示）'), el('textarea', { id: 'siteNotice', rows: '2' }, data.site_notice || '')]),
      el('div', { class: 'field' }, [el('label', {}, '页脚文案'), el('textarea', { id: 'footerText', rows: '2' }, data.footer_text || '')]),
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [
          el('label', {}, '轮播间隔（毫秒）'),
          el('input', { id: 'carouselInterval', type: 'number', min: '2000', max: '15000', step: '500', value: data.carousel_interval || '5000' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', {}, '广告开关'),
          el('div', { class: 'check' }, [
            el('input', { id: 'adsEnabled', type: 'checkbox', checked: String(data.ads_enabled) === '1' ? 'checked' : null }),
            el('span', {}, '展示首页轮播与导航广告'),
          ]),
        ]),
      ]),
      el('div', { class: 'actions' }, [el('button', { class: 'btn', type: 'submit' }, '保存设置')]),
    ]);
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/admin/settings', {
          method: 'PUT',
          body: {
            site_name: document.getElementById('siteName').value.trim(),
            site_subtitle: document.getElementById('siteSubtitle').value.trim(),
            site_notice: document.getElementById('siteNotice').value.trim(),
            footer_text: document.getElementById('footerText').value.trim(),
            carousel_interval: String(Number(document.getElementById('carouselInterval').value) || 5000),
            ads_enabled: document.getElementById('adsEnabled').checked ? '1' : '0',
          },
        });
        toast('设置已保存');
      } catch (error) {
        toast(error.message, 'err');
      }
    });

    const passwordForm = el('form', { class: 'panel-card' }, [
      el('h3', {}, '管理员授权'),
      el('p', { class: 'desc' }, '修改后当前登录会失效，需要使用新密码重新登录。默认密码为 admin123，请尽快修改。'),
      el('div', { class: 'row' }, [
        el('div', { class: 'field' }, [el('label', {}, '原密码'), el('input', { id: 'oldPassword', type: 'password', autocomplete: 'current-password' })]),
        el('div', { class: 'field' }, [el('label', {}, '新密码（至少 6 位）'), el('input', { id: 'newPassword', type: 'password', autocomplete: 'new-password' })]),
        el('div', { class: 'field' }, [el('label', {}, '确认新密码'), el('input', { id: 'confirmPassword', type: 'password', autocomplete: 'new-password' })]),
      ]),
      el('div', { class: 'actions' }, [el('button', { class: 'btn', type: 'submit' }, '修改密码')]),
    ]);
    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const next = document.getElementById('newPassword').value;
      if (next !== document.getElementById('confirmPassword').value) { toast('两次输入的新密码不一致', 'err'); return; }
      try {
        await api('/api/admin/password', {
          method: 'POST',
          body: {
            oldPassword: document.getElementById('oldPassword').value,
            newPassword: next,
          },
        });
        toast('密码已修改，请重新登录');
        setTimeout(showLogin, 700);
      } catch (error) {
        toast(error.message, 'err');
      }
    });

    panel.appendChild(settingsForm);
    panel.appendChild(passwordForm);
  }

  // ---- 启动 ----
  checkSession();
})();
