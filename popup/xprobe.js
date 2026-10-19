/**
 * xprobe.js — 直连读页面
 *
 * 关注数 / 粉丝数就在你自己的主页上，直接读 DOM 就行，**不调用任何 X 接口**。
 * 用 chrome.scripting.executeScript 在 x.com 页面里执行代码，绕开
 * content script ↔ bridge ↔ background 那条消息链路，结果按返回值直接拿。
 *
 * 你不在主页也没关系：会在后台新开一个标签页打开你的主页，读到数字后立刻关掉。
 *
 * 注意：注入到页面的函数会被序列化成字符串执行，函数体内**不能引用外部变量**，
 * 需要的参数只能通过 args 传入。
 */
(function (root) {
  'use strict';

  const X_URL_PATTERNS = ['https://x.com/*', 'https://twitter.com/*'];

  async function getXTab() {
    const tabs = await chrome.tabs.query({ url: X_URL_PATTERNS });
    if (!tabs || tabs.length === 0) return null;
    return tabs.find((t) => t.active) || tabs[0];
  }

  // ── 注入到页面的函数（必须自包含）───────────────────────────────────────

  function pageLoginProbe() {
    const c = document.cookie || '';
    const csrf = (/(?:^|;\s*)ct0=([^;]+)/.exec(c) || [])[1] || null;
    const uid = (/(?:^|;\s*)twid=u%3D(\d+)/.exec(c) || [])[1] || null;
    return { loggedIn: !!csrf && !!uid, userId: uid, origin: location.origin };
  }

  /** 从左侧导航认出「我」的用户名 */
  function pageFindHandle() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = link ? (link.getAttribute('href') || '') : '';
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (m) return m[1];

    const sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (sw) {
      const mm = (sw.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
      if (mm) return mm[1];
    }
    return null;
  }

  /** 读取主页上的「正在关注 / 关注者」两个数字 */
  function pageReadProfileCounts(handle) {
    const parseNum = (txt) => {
      if (txt === null || txt === undefined) return null;
      const s = String(txt).replace(/[,\s\u00a0]/g, '');
      if (!s) return null;
      const m = s.match(/([\d.]+)([KkMmBb千万元亿]?)/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      if (!isFinite(n)) return null;
      const mult = { K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 }[m[2]] || 1;
      return Math.round(n * mult);
    };

    const followingLink = document.querySelector('a[href="/' + handle + '/following"]');
    const followersLink =
      document.querySelector('a[href="/' + handle + '/verified_followers"]') ||
      document.querySelector('a[href="/' + handle + '/followers"]');
    // 两个链接必须同时存在 —— 否则说明当前页不是这个人的主页，直接放弃
    if (!followingLink || !followersLink) return null;

    const readCount = (el) => {
      for (const sp of el.querySelectorAll('span')) {
        const v = parseNum(sp.textContent);
        if (v !== null) return v;
      }
      return parseNum(el.textContent);
    };

    const following = readCount(followingLink);
    const followers = readCount(followersLink);
    if (following === null || followers === null) return null;
    return { following: following, followers: followers };
  }

  // ── 对外接口 ────────────────────────────────────────────────────────────

  async function inject(tabId, func, args) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args,
    });
    return res ? res.result : null;
  }

  async function readHandle(tabId) {
    // 刚打开的页面左侧导航可能还没渲染，重试几次
    for (let i = 0; i < 3; i++) {
      try {
        const h = await inject(tabId, pageFindHandle);
        if (h) return h;
      } catch (_) { /* 忽略，重试 */ }
      await sleep(300);
    }
    return null;
  }

  async function readCounts(tabId, handle) {
    try { return await inject(tabId, pageReadProfileCounts, [handle]); } catch (_) { return null; }
  }

  function domResult(handle, counts, via) {
    return {
      ok: true,
      source: 'dom',
      via: via || 'current',
      user: {
        id: '',
        name: '',
        screenName: handle,
        followersCount: counts.followers,
        friendsCount: counts.following,
        statusesCount: 0,
        profileImageUrl: '',
      },
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 在后台标签页打开自己的主页，读 DOM 数字，读完立刻关掉。
   * 用户停在任何页面都能用，全程不发一个 API 请求。
   */
  async function meViaProfileTab(handle) {
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: 'https://x.com/' + handle, active: false });
      // 页面还在加载时注入也没关系，拿不到就等下一轮（总共约 16 秒）
      for (let i = 0; i < 40; i++) {
        await sleep(i === 0 ? 600 : 400);
        const c = await readCounts(tab.id, handle);
        if (c) return domResult(handle, c, 'tab');
      }
      return { ok: false, stage: 'dom-timeout', error: '打开主页后没读到数字' };
    } catch (e) {
      return { ok: false, stage: 'dom-tab', error: e && e.message ? e.message : String(e) };
    } finally {
      if (tab && tab.id) {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
      }
    }
  }

  async function me() {
    const tab = await getXTab();
    if (!tab) return { ok: false, stage: 'no-tab', error: '未检测到打开的 x.com 标签页' };

    const handle = await readHandle(tab.id);

    // ① 当前页就是自己的主页 —— 零请求，瞬时出结果
    if (handle) {
      const counts = await readCounts(tab.id, handle);
      if (counts) return domResult(handle, counts, 'current');
    }

    // ② 不在主页 → 后台开一个标签页打开自己的主页，读完就关
    if (!handle) {
      return {
        ok: false,
        stage: 'no-handle',
        error: '认不出你的用户名 —— 请打开 x.com 后重试，或点左侧「个人资料」进一下自己的主页',
      };
    }

    const viaTab = await meViaProfileTab(handle);
    if (viaTab.ok) return viaTab;
    return {
      ok: false,
      stage: 'dom',
      error: viaTab.error,
      tried: ['主页 DOM（@' + handle + '）→ ' + viaTab.error],
    };
  }

  async function login() {
    const tab = await getXTab();
    if (!tab) return { tab: false, loggedIn: false, error: '未检测到打开的 x.com 标签页' };
    try {
      const r = await inject(tab.id, pageLoginProbe);
      if (!r) return { tab: true, loggedIn: false, error: '页面未返回登录状态' };
      return { tab: true, loggedIn: r.loggedIn, userId: r.userId, tabId: tab.id };
    } catch (e) {
      return { tab: true, loggedIn: false, error: e && e.message ? e.message : String(e) };
    }
  }

  root.XProbe = {
    login, me, getXTab, readHandle,
    _page: { login: pageLoginProbe, handle: pageFindHandle, counts: pageReadProfileCounts },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.XProbe;
})(typeof globalThis !== 'undefined' ? globalThis : this);
