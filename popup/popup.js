/**
 * popup.js — Side panel UI.
 * Talks to background.js via chrome.runtime.sendMessage.
 */

document.addEventListener('DOMContentLoaded', () => {
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allUsers = [];
const selectedIds = new Set();  // 勾选集合 —— 跨标签页保留，供「按健康线自动勾选」使用
let meProfile = null;           // 自己的账号数据：{ followersCount, friendsCount }
let isEnriched = false;
let currentView = 'none';      // 'none' | 'inactive' | 'active'
let currentSort = 'inactive-first';
let isFetching = false;
let isEnriching = false;
let isUnfollowing = false;
let progressWatcher = null;
let rateLimitTimer = null;
let rateLimitUntil = null;

function startRateLimitCountdown(waitMs, labelPrefix) {
  if (rateLimitTimer) {
    clearInterval(rateLimitTimer);
    rateLimitTimer = null;
  }
  const now = Date.now();
  rateLimitUntil = now + (waitMs || 0);
  const update = () => {
    const remaining = Math.max(0, rateLimitUntil - Date.now());
    const secs = Math.ceil(remaining / 1000);
    if (secs <= 0) {
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
      return;
    }
    progressLabel.textContent = `${labelPrefix} —— 等待 ${secs} 秒…`;
  };
  if (!waitMs || waitMs <= 0) return;
  update();
  rateLimitTimer = setInterval(update, 1000);
}
let hasLoadedCache = false;
let hasOnboarded = false;
let currentTheme = 'light';
let healthCollapsed = false;
let directMode = false;   // true = 页面桥接失效，改用 popup 直接注入页面取数
let contextDeadFlag = false; // true = 扩展上下文已失效（重载/更新后必须重开侧边栏）

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const statusBar    = $('status-bar');
const statusText   = $('status-text');
const btnRefresh   = $('btn-refresh-status');
const btnTheme     = $('btn-theme-toggle');

const sectionNotLoggedIn = $('section-not-logged-in');
const sectionGuide       = $('section-guide');
const sectionApp         = $('section-app');

const btnGuideCheck = $('btn-guide-check');

const selectThreshold  = $('select-threshold');
const inputCustomDays  = $('input-custom-days');
const btnFetch         = $('btn-fetch');
const btnCancelFetch   = $('btn-cancel-fetch');

const progressArea    = $('progress-area');
const progressBarFill = $('progress-bar-fill');
const progressLabel   = $('progress-label');

const statsBar    = $('stats-bar');
const statTotal   = $('stat-total');
const statSelected= $('stat-selected');
const btnToggleAll = $('btn-toggle-all');
const viewTabs    = $('view-tabs');
const countNone     = $('count-none');
const countUnknown  = $('count-unknown');
const countInactive = $('count-inactive');
const countActive   = $('count-active');
const selectSort    = $('select-sort');

const listEmpty    = $('list-empty');
const listLoading  = $('list-loading');
const accountList  = $('account-list');

const unfollowFooter       = $('unfollow-footer');
const unfollowProgressArea = $('unfollow-progress-area');
const unfollowBarFill      = $('unfollow-bar-fill');
const unfollowLabel        = $('unfollow-label');
const btnUnfollow          = $('btn-unfollow');
const btnCancelUnfollow    = $('btn-cancel-unfollow');
const unfollowCount        = $('unfollow-count');

const toast = $('toast');

// 健康度
const healthCard       = $('health-card');
const healthBadge      = $('health-badge');
const healthRatio      = $('health-ratio');
const healthFollowing  = $('health-following');
const healthFollowers  = $('health-followers');
const healthWeight     = $('health-weight');
const healthDesc       = $('health-desc');
const healthRanges     = $('health-ranges');
const healthAction     = $('health-action');
const healthActionText = $('health-action-text');
const healthManual     = $('health-manual');
const manualFollowing  = $('manual-following');
const manualFollowers  = $('manual-followers');
const btnManualSave    = $('btn-manual-save');
const btnHealthRefresh = $('btn-health-refresh');
const btnHealthToggle  = $('btn-health-toggle');
const btnManualEdit    = $('btn-manual-edit');
const btnSelectHealthy = $('btn-select-healthy');

// ---------------------------------------------------------------------------
// Messaging — with automatic retry when the service worker was just woken up
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {number} [opts.retries=2] Retries when the service worker was just woken up.
 * @param {number} [opts.timeoutMs=8000] Max wait for sendResponse. Use 0 for no limit
 *   (required for FETCH_FOLLOWING / ENRICH_ACTIVITY / UNFOLLOW, which routinely exceed 8s).
 */
function send(type, payload = {}, opts = {}) {
  const _retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 8000;
  return new Promise((resolve) => {
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => resolve(null), timeoutMs)
        : null;
    function clearAndResolve(value) {
      if (timeout) clearTimeout(timeout);
      resolve(value);
    }
    function attempt(left) {
      try {
        chrome.runtime.sendMessage(
          { direction: 'FROM_POPUP', type, ...payload },
          (res) => {
            if (chrome.runtime.lastError) {
              const m = chrome.runtime.lastError.message || '';
              // 扩展上下文失效 —— 重试没有意义，直接判定，避免 8 秒空等
              if (/context invalidated|Extension context/i.test(m)) {
                contextDeadFlag = true;
                clearAndResolve(null);
                return;
              }
              if (left > 0) {
                setTimeout(() => attempt(left - 1), 350);
              } else {
                clearAndResolve(null);
              }
              return;
            }
            clearAndResolve(res);
          }
        );
      } catch (e) {
        if (/context invalidated|Extension context/i.test(e?.message || '')) contextDeadFlag = true;
        clearAndResolve(null);
      }
    }
    attempt(_retries);
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function setStatus(state, text) {
  statusBar.className = `status-bar status-${state}`;
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------
function getThresholdDays() {
  if (selectThreshold.value === 'custom') {
    return Math.max(1, parseInt(inputCustomDays.value, 10) || 90);
  }
  return Math.min(3650, Math.max(1, parseInt(selectThreshold.value, 10) || 90));
}

function isNoTweets(user) {
  return user.statusesCount === 0;
}

function isUnknown(user) {
  return !isNoTweets(user) && !user.lastTweetAt && !!user.activityChecked;
}

function isInactive(user) {
  if (user.statusesCount === 0) return false;
  if (user.lastTweetAt) {
    const diffMs = Date.now() - new Date(user.lastTweetAt).getTime();
    return Math.floor(diffMs / 86400000) > getThresholdDays();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function formatDate(isoStr) {
  if (!isoStr) return '—';
  const days = Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
  if (days < 1)   return '今天';
  if (days < 2)   return '昨天';
  if (days < 30)  return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderBadge(user, enriched) {
  if (!enriched) return `<span class="badge badge-loading">检查中…</span>`;
  if (user.statusesCount === 0) return `<span class="badge badge-never">无推文</span>`;
  if (user.lastTweetAt) {
    const days = Math.floor((Date.now() - new Date(user.lastTweetAt).getTime()) / 86400000);
    return days > getThresholdDays() ? `<span class="badge badge-inactive">不活跃</span>` : '';
  }
  // activityChecked=true but no date → restricted/suspended or all tweets deleted
  if (user.activityChecked && isUnknown(user)) return `<span class="badge badge-muted">无数据</span>`;
  return '';
}

function createAccountItem(user, enriched = false) {
  const inactive = enriched && isInactive(user);
  const li = document.createElement('li');
  li.className = `account-item${inactive ? ' is-inactive' : ''}`;
  li.dataset.userId = user.id;
  li.innerHTML = `
    <input type="checkbox" class="account-checkbox" data-user-id="${user.id}"${selectedIds.has(user.id) ? ' checked' : ''} />
    <img class="account-avatar" src="${escHtml(user.profileImageUrl)}" alt="" loading="lazy" />
    <div class="account-info">
      <span class="account-name">${escHtml(user.name)}</span>
      <a class="account-handle" href="https://x.com/${escHtml(user.screenName)}" target="_blank" rel="noopener noreferrer">@${escHtml(user.screenName)}</a>
    </div>
    <div class="account-meta">
      ${renderBadge(user, enriched)}
      <span class="account-last-tweet">${enriched ? formatDate(user.lastTweetAt) : ''}</span>
    </div>`;

  const avatar = li.querySelector('.account-avatar');
  avatar.addEventListener('error', () => { avatar.style.display = 'none'; });

  const cbEl = li.querySelector('.account-checkbox');
  cbEl.addEventListener('change', () => {
    if (cbEl.checked) selectedIds.add(user.id);
    else selectedIds.delete(user.id);
    updateStats();
  });
  li.addEventListener('click', (e) => {
    if (e.target.classList.contains('account-checkbox')) return;
    if (e.target.closest('a')) return; // let handle link open natively
    const cb = li.querySelector('.account-checkbox');
    cb.checked = !cb.checked;
    if (cb.checked) selectedIds.add(user.id);
    else selectedIds.delete(user.id);
    updateStats();
  });
  return li;
}

function updateAccountItem(user, enriched) {
  const li = accountList.querySelector(`[data-user-id="${user.id}"]`);
  if (!li) return;
  const inactive = enriched && isInactive(user);
  li.className = `account-item${inactive ? ' is-inactive' : ''}`;
  li.querySelector('.account-meta').innerHTML = `
    ${renderBadge(user, enriched)}
    <span class="account-last-tweet">${enriched ? formatDate(user.lastTweetAt) : ''}</span>`;
}

// ---------------------------------------------------------------------------
// Filtering + sorting
// ---------------------------------------------------------------------------
function sortUsers(users) {
  const copy = [...users];
  switch (currentSort) {
    case 'inactive-first':
      return copy.sort((a, b) => {
        const ai = isInactive(a), bi = isInactive(b);
        if (ai && !bi) return -1;
        if (!ai && bi) return 1;
        // Within inactive group: oldest first
        if (ai && bi) {
          const ad = a.lastTweetAt ? new Date(a.lastTweetAt).getTime() : 0;
          const bd = b.lastTweetAt ? new Date(b.lastTweetAt).getTime() : 0;
          return ad - bd;
        }
        return 0;
      });
    case 'oldest-first':
      return copy.sort((a, b) => {
        const ad = a.lastTweetAt ? new Date(a.lastTweetAt).getTime() : 0;
        const bd = b.lastTweetAt ? new Date(b.lastTweetAt).getTime() : 0;
        return ad - bd;
      });
    case 'newest-first':
      return copy.sort((a, b) => {
        const ad = a.lastTweetAt ? new Date(a.lastTweetAt).getTime() : 0;
        const bd = b.lastTweetAt ? new Date(b.lastTweetAt).getTime() : 0;
        return bd - ad;
      });
    case 'followers':
      return copy.sort((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
    default:
      return copy;
  }
}

function getViewUsers() {
  if (currentView === 'none')    return sortUsers(allUsers.filter(isNoTweets));
  if (currentView === 'unknown') return sortUsers(allUsers.filter(isUnknown));
  if (currentView === 'inactive')
    return sortUsers(allUsers.filter((u) => !isNoTweets(u) && !isUnknown(u) && isInactive(u)));
  if (currentView === 'active')
    return sortUsers(allUsers.filter((u) => !isNoTweets(u) && !isUnknown(u) && !isInactive(u)));
  return sortUsers(allUsers);
}

// ---------------------------------------------------------------------------
// 账号健康度 —— 系数 = 关注数 ÷ 粉丝数（算法见 health.js）
//   ≤ 0.6      健康        权重 100%
//   0.6 ~ 1    不健康      权重下降 30%~70%，推流变慢
//   1 ~ 2      坐牢        降权 70%~90%
//   > 2        踢出公域流量池
// ---------------------------------------------------------------------------
const {
  tierOf, estimateWeight, ratioOf, followingRanges, unfollowNeeded, fmtNum, fmtSpan,
} = window.XHealth;
function renderHealth(profile, errorText) {
  if (!profile) {
    healthBadge.textContent = '无法检测';
    healthBadge.className = 'health-badge tier-unknown';
    healthRatio.textContent = '系数 —';
    healthFollowing.textContent = '—';
    healthFollowers.textContent = '—';
    healthWeight.textContent = '—';
    healthDesc.textContent = errorText || '无法读取账号的关注数与粉丝数，请刷新 x.com 页面后重试。';
    healthDesc.classList.add('is-warn');
    healthRanges.classList.add('hidden');
    healthAction.classList.add('hidden');
    btnManualEdit.classList.add('hidden');
    showManualEntry(true);
    return;
  }

  const following = Math.max(0, Number(profile.friendsCount) || 0);
  const followers = Math.max(0, Number(profile.followersCount) || 0);
  const ratio = ratioOf(following, followers);
  const tier = tierOf(ratio);
  const weight = estimateWeight(ratio, tier);
  const R = followingRanges(followers);

  healthBadge.textContent = tier.label;
  healthBadge.className = `health-badge tier-${tier.key}`;
  healthRatio.textContent = `系数 ${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'}`;
  healthFollowing.textContent = fmtNum(following);
  healthFollowers.textContent = fmtNum(followers);
  healthWeight.textContent = `${weight}%`;

  const descParts = [tier.desc];
  if (tier.key !== 'ok' && Number.isFinite(tier.max)) {
    descParts.push(`推算权重 ${weight}%（区间 ${tier.weight[1]}%~${tier.weight[0]}%）。`);
  }
  if (followers === 0) descParts.push('粉丝数为 0，系数按无穷大处理。');
  if (profile.manual) descParts.push('（数值为手动填写）');
  else if (profile.source === 'dom') descParts.push('（数值从你的主页读取）');
  healthDesc.textContent = descParts.join('');
  healthDesc.classList.toggle('is-warn', tier.key !== 'ok');

  // 关注数区间表（以当前粉丝数不变为前提）
  const rows = [
    { key: 'ok',   name: '健康',     ratioTxt: '≤ 0.6',   followTxt: `≤ ${fmtNum(R.okMax)}` },
    { key: 'warn', name: '不健康',   ratioTxt: '0.6 – 1', followTxt: fmtSpan(R.warnMin, R.warnMax) },
    { key: 'bad',  name: '坐牢',     ratioTxt: '1 – 2',   followTxt: fmtSpan(R.badMin, R.badMax) },
    { key: 'out',  name: '踢出公域', ratioTxt: '> 2',     followTxt: `≥ ${fmtNum(R.outMin)}` },
  ];
  healthRanges.innerHTML = `
    <div class="range-row range-head">
      <span class="range-name">状态</span>
      <span class="range-ratio">系数</span>
      <span class="range-following">关注数</span>
    </div>` + rows.map((r) => `
    <div class="range-row${r.key === tier.key ? ' is-current' : ''}">
      <span class="range-name"><span class="range-dot dot-${r.key}"></span>${r.name}</span>
      <span class="range-ratio" title="系数 = 关注数 ÷ 粉丝数">${r.ratioTxt}</span>
      <span class="range-following" title="以当前粉丝数 ${fmtNum(followers)} 计算">${r.followTxt}</span>
    </div>`).join('');
  healthRanges.classList.remove('hidden');

  // 取关建议
  if (tier.key === 'ok') {
    healthActionText.textContent =
      `已在健康区间：关注数不超过 ${fmtNum(R.okMax)} 都安全（当前 ${fmtNum(following)}）。`;
    healthActionText.classList.add('is-ok');
    btnSelectHealthy.classList.add('hidden');
  } else {
    const need = unfollowNeeded(following, followers);
    healthActionText.textContent =
      `关注数需从 ${fmtNum(following)} 降到 ${fmtNum(R.okMax)} 以内 —— 至少取关 ${fmtNum(need)} 个，才能回到健康区间。`;
    healthActionText.classList.remove('is-ok');
    btnSelectHealthy.classList.remove('hidden');
  }
  healthAction.classList.remove('hidden');
  showManualEntry(false);
  btnManualEdit.classList.toggle('hidden', !profile.manual);
}

function showManualEntry(show, seed) {
  if (!show) {
    healthManual.classList.add('hidden');
    return;
  }
  if (seed) {
    if (seed.friendsCount !== undefined) manualFollowing.value = seed.friendsCount;
    if (seed.followersCount !== undefined) manualFollowers.value = seed.followersCount;
  }
  healthManual.classList.remove('hidden');
  // 折叠状态下自动展开，否则输入框藏起来了
  if (healthCollapsed) applyHealthCollapsed(false);
}

async function saveManualCounts() {
  const following = parseInt(manualFollowing.value, 10);
  const followers = parseInt(manualFollowers.value, 10);
  if (!Number.isFinite(following) || following < 0 || !Number.isFinite(followers) || followers < 0) {
    showToast('请填写有效的关注数与粉丝数（非负整数）。', 4000);
    return;
  }
  meProfile = {
    ...(meProfile || {}),
    friendsCount: following,
    followersCount: followers,
    manual: true,
    source: 'manual',
    fetchedAt: Date.now(),
  };
  try { await chrome.storage.local.set({ meProfile }); } catch (_) {}
  renderHealth(meProfile);
  showToast('已按手动填写的数字计算健康度。');
}

function friendlyProfileError(raw) {
  if (!raw) return '无法读取账号数据。';
  if (/404|does not exist|code["'\s:]*34/i.test(raw)) return 'X 已关闭这个数据接口（404）';
  if (/401|身份验证失败/.test(raw)) return '登录状态已失效，请刷新 x.com 页面后重试';
  if (/429|限流/.test(raw)) return raw;
  if (/Failed to fetch|NetworkError|无法连接/i.test(raw)) return '网络异常，请检查网络后重试';
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

// ---- 直连读页面：不调用任何 X 接口 ----------------------------------------
// 关注数 / 粉丝数就在自己的主页上，读 DOM 最稳。接口会 401 / 404，纯属多余。
function probeAvailable() {
  return typeof XProbe !== 'undefined' && XProbe && typeof XProbe.me === 'function';
}

async function probeMyProfile() {
  if (!probeAvailable()) return { ok: false, stage: '未加载读页面模块', error: '读页面模块未加载', tried: [] };
  try {
    const r = await XProbe.me();
    if (r && r.ok && r.user) {
      return {
        ok: true,
        via: r.via || 'current',
        user: { ...r.user, fetchedAt: Date.now(), source: 'dom' },
        tried: r.tried || [],
      };
    }
    return { ok: false, stage: r?.stage || '失败', error: r?.error || '没读到数字', tried: r?.tried || [] };
  } catch (e) {
    return { ok: false, stage: '异常', error: e?.message || String(e), tried: [] };
  }
}

function probeTriedText(tried) {
  return Array.isArray(tried) && tried.length ? tried.join(' · ') : '';
}

async function loadMyProfile(force = false) {
  try {
    if (!extensionContextAlive()) {
      if (!meProfile) renderHealth(null, CONTEXT_DEAD_TEXT);
      else renderHealth(meProfile);
      setStatus('error', CONTEXT_DEAD_TEXT);
      return;
    }

    if (!force) {
      const cached = await chrome.storage.local.get('meProfile');
      if (cached?.meProfile) {
        meProfile = cached.meProfile;
        renderHealth(meProfile);
        // 缓存够新就直接用，别每次打开侧栏都去开标签页；点「刷新」才重新读
        const at = Number(meProfile.fetchedAt) || 0;
        if (at && Date.now() - at < 30 * 60 * 1000) return;
      }
    } else {
      healthDesc.textContent = '正在读取主页上的数字…';
      healthDesc.classList.remove('is-warn');
    }

    // 只读页面，不发任何请求
    const probe = await probeMyProfile();
    if (probe.ok) {
      directMode = true;
      meProfile = probe.user;
      try { await chrome.storage.local.set({ meProfile }); } catch (_) {}
      renderHealth(meProfile);
      if (force) {
        showToast(probe.via === 'tab'
          ? '已从你的主页读取数字（临时标签页已自动关闭）。'
          : '已从你的主页读取关注数与粉丝数。');
      }
      return;
    }

    // 读不到 —— 说清楚原因，并给出手动入口
    const reason = probe.error || '没能读到数字';
    if (meProfile) {
      renderHealth(meProfile);
      if (force) showToast(`${reason}。当前显示上次的数值，可点「改数值」手动修正。`, 6000);
    } else {
      renderHealth(null, `${reason}。可在下方手动填写，数字在 x.com 个人主页的「正在关注 / 关注者」处。`);
      showManualEntry(true);
      if (force) showToast(probeTriedText(probe.tried) || reason, 8000);
    }
  } catch (e) {
    const msg = friendlyProfileError(e?.message);
    if (meProfile) renderHealth(meProfile);
    else renderHealth(null, `${msg}。可在下方手动填写关注数与粉丝数。`);
  }
}

// 取关后更新健康度：手动模式直接扣减，自动模式等 X 端同步后重读
async function refreshHealthAfterUnfollow(count) {
  if (!meProfile || count <= 0) return;
  if (meProfile.manual) {
    meProfile = {
      ...meProfile,
      friendsCount: Math.max(0, (Number(meProfile.friendsCount) || 0) - count),
      fetchedAt: Date.now(),
    };
    try { await chrome.storage.local.set({ meProfile }); } catch (_) {}
    renderHealth(meProfile);
    return;
  }
  setTimeout(() => loadMyProfile(true), 1500);
}

// 待取关优先级：无推文 → 无数据 → 最久没发推
function unfollowCandidates() {
  const noTweets = allUsers.filter((u) => u.statusesCount === 0);
  const noData   = allUsers.filter((u) => u.statusesCount > 0 && !u.lastTweetAt);
  const dated    = allUsers
    .filter((u) => u.lastTweetAt)
    .sort((a, b) => new Date(a.lastTweetAt) - new Date(b.lastTweetAt));
  return [...noTweets, ...noData, ...dated];
}

// 按健康线自动勾选：把关注数压到 okMax 以内
function autoSelectToHealthy() {
  if (!meProfile) { showToast('账号数据还没读到，请稍后再试。'); return; }
  if (allUsers.length === 0) {
    showToast('请先点「加载关注列表」，才能自动挑出要取关的账号。', 5000);
    return;
  }

  const followers = Math.max(0, Number(meProfile.followersCount) || 0);
  const following = Math.max(0, Number(meProfile.friendsCount) || allUsers.length);
  const R = followingRanges(followers);
  const need = unfollowNeeded(following, followers);

  if (need === 0) { showToast('当前已在健康区间，不需要取关。'); return; }

  const picked = unfollowCandidates().slice(0, Math.min(need, allUsers.length));
  if (picked.length === 0) { showToast('列表里没有可挑选的账号。'); return; }

  selectedIds.clear();
  picked.forEach((u) => selectedIds.add(u.id));

  // 跳到能看到最多已勾选账号的标签页
  const dist = { none: 0, unknown: 0, inactive: 0, active: 0 };
  picked.forEach((u) => {
    if (isNoTweets(u)) dist.none++;
    else if (isUnknown(u)) dist.unknown++;
    else if (isInactive(u)) dist.inactive++;
    else dist.active++;
  });
  const best = Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0];
  setView(best);

  const short = need > picked.length ? `，列表不足还差 ${need - picked.length} 个` : '';
  showToast(`已按「无推文 → 无数据 → 最久未发」勾选 ${picked.length} 个${short}。`, 6000);
}

function renderList(enriched = false) {
  isEnriched = enriched;
  pruneSelection();
  accountList.innerHTML = '';
  const toShow = getViewUsers();
  toShow.forEach((u) => accountList.appendChild(createAccountItem(u, enriched)));
  listEmpty.classList.toggle('hidden', allUsers.length > 0);
  statsBar.classList.toggle('hidden', allUsers.length === 0);
  viewTabs.classList.toggle('hidden', allUsers.length === 0);
  updateStats();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function getSelectedIds() {
  return Array.from(selectedIds);
}

// 列表刷新后丢弃已不在列表中的 id（例如刚被取关的账号）
function pruneSelection() {
  if (allUsers.length === 0) return;
  const alive = new Set(allUsers.map((u) => u.id));
  for (const id of Array.from(selectedIds)) {
    if (!alive.has(id)) selectedIds.delete(id);
  }
}

function updateStats() {
  const total       = allUsers.length;
  const noneN       = allUsers.filter(isNoTweets).length;
  const unknownN    = allUsers.filter(isUnknown).length;
  const inactiveN   = allUsers.filter((u) => !isNoTweets(u) && !isUnknown(u) && isInactive(u)).length;
  const activeN     = total - noneN - unknownN - inactiveN;
  const selected    = getSelectedIds().length;

  statTotal.textContent    = `共 ${total} 个关注`;
  statSelected.textContent = `已选 ${selected} 个`;
  unfollowCount.textContent = selected;

  // Tab counts
  countNone.textContent     = noneN;
  countUnknown.textContent  = unknownN;
  countInactive.textContent = inactiveN;
  countActive.textContent   = activeN;

  const showFooter = selected > 0 || isUnfollowing;
  unfollowFooter.classList.toggle('hidden', !showFooter);
  if (!isUnfollowing) unfollowProgressArea.classList.add('hidden');

  // Sync toggle-all button label with current selection state
  const checkboxes = accountList.querySelectorAll('.account-checkbox');
  const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every((cb) => cb.checked);
  btnToggleAll.textContent = allChecked ? '取消全选' : '全选';
}

// ---------------------------------------------------------------------------
// Login check
// ---------------------------------------------------------------------------
// 扩展被重新加载/更新后，已经打开的侧边栏页面会失去 chrome 上下文：
// 此时所有 chrome.* 调用都会抛错，表现成「后台服务无响应」，而且刷新 x.com
// 页面救不回来 —— 必须关掉侧边栏重新打开。先把它识别出来单独提示。
function extensionContextAlive() {
  if (contextDeadFlag) return false;
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

const CONTEXT_DEAD_TEXT = '插件已更新或重新加载 —— 请关闭侧边栏后重新打开';

async function enterApp(state, text) {
  setStatus(state, text);
  sectionNotLoggedIn.classList.add('hidden');
  sectionGuide.classList.add('hidden');
  sectionApp.classList.remove('hidden');
  loadMyProfile();   // 并行读取健康度数据，不阻塞面板显示
  if (!hasLoadedCache) {
    await loadCachedData();
    hasLoadedCache = true;
  }
}

async function checkLogin() {
  setStatus('checking', '检查中…');
  btnRefresh.classList.add('spinning');
  try {
    if (!extensionContextAlive()) {
      setStatus('error', CONTEXT_DEAD_TEXT);
      showToast(CONTEXT_DEAD_TEXT, 8000);
      return;
    }

    const res = await send('PING', {}, { retries: 1, timeoutMs: 5000 });

    if (contextDeadFlag) {
      setStatus('error', CONTEXT_DEAD_TEXT);
      showToast(CONTEXT_DEAD_TEXT, 8000);
      return;
    }

    if (res?.success && res.loggedIn) {
      directMode = false;
      const tokenLabel = res.tokenReady ? '令牌已获取 ✓' : '使用备用令牌';
      const fallbackWarning = res.usingFallback ? ' —— 令牌可能已过期，请尝试刷新 x.com' : '';
      await enterApp(res.usingFallback ? 'warn' : 'ok', `已登录 · ${tokenLabel}${fallbackWarning}`);
      return;
    }

    // 后台链路没回应 —— 由面板直接注入页面确认登录状态，不依赖 service worker
    const probe = probeAvailable()
      ? await XProbe.login()
      : { tab: null, loggedIn: false, error: '直连模块未加载' };

    if (probe && probe.loggedIn) {
      directMode = true;
      await enterApp('ok', '已登录 · 直连模式（不经过后台服务）');
      return;
    }

    let text;
    if (probe?.tab === false) {
      text = '未检测到打开的 x.com 标签页 —— 请先打开 x.com';
    } else if (res === null) {
      text = `页面未响应${probe?.error ? `（${probe.error}）` : ''} —— 请刷新 x.com 页面后重试`;
    } else if (probe?.loggedIn === false && probe?.tab) {
      text = '请先打开 x.com 并登录。';
    } else if (res?.error) {
      text = res.error;
    } else {
      text = '请先打开 x.com 并登录。';
    }

    setStatus('error', text);
    sectionApp.classList.add('hidden');
    if (!hasOnboarded) {
      sectionNotLoggedIn.classList.add('hidden');
      sectionGuide.classList.remove('hidden');
    } else {
      sectionNotLoggedIn.classList.remove('hidden');
      sectionGuide.classList.add('hidden');
    }
  } catch (e) {
    setStatus('error', `无法连接 —— ${e?.message || e}`);
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

// ---------------------------------------------------------------------------
// Load cached data
// ---------------------------------------------------------------------------
async function loadCachedData() {
  const res = await send('GET_CACHED', {}, { timeoutMs: directMode ? 2500 : 8000 });
  if (res?.success && res.followingList?.length) {
    allUsers = res.followingList;
    // Consider enriched if any user has the activityChecked flag or a lastTweetAt date
    const enriched = allUsers.some((u) => u.activityChecked || u.lastTweetAt !== null);
    listLoading.classList.add('hidden');
    renderList(enriched);
    if (res.fetchedAt) {
      const mins = Math.round((Date.now() - res.fetchedAt) / 60000);
      const inactiveN = allUsers.filter(isInactive).length;
      showToast(`${allUsers.length} 个账号（${inactiveN} 个不活跃）—— 缓存于 ${mins} 分钟前`);
    }
  } else {
    // 没有缓存，或后台没响应 —— 别把列表卡在加载态
    listLoading.classList.add('hidden');
    renderList(false);
  }
}

// ---------------------------------------------------------------------------
// Fetch following
// ---------------------------------------------------------------------------
let stateSyncListener = null;
let longTouch = null;   // 长任务的「还活着」打点器，由进度回调触发

/**
 * 发一条长任务消息（抓列表 / 查活跃度 / 取关）。
 * 这些操作本来没有超时上限，但链路断掉时消息永远不回来，按钮会一直转圈。
 * 这里加一个空闲看门狗：连续 idleMs 一条进度都没收到，就判定链路已断。
 */
function sendLong(type, payload, idleMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    let lastTick = Date.now();
    const done = (v) => {
      if (settled) return false;
      settled = true;
      longTouch = null;
      clearInterval(idle);
      resolve(v);
      return true;
    };
    longTouch = () => { lastTick = Date.now(); };
    const idle = setInterval(() => {
      if (Date.now() - lastTick > idleMs) done({ __idle: true });
    }, 2000);
    send(type, payload, { timeoutMs: 0 }).then((res) => done(res || { __idle: true }));
  });
}

const BRIDGE_DEAD_HINT = '后台链路无响应（一直没有任何进度）—— 请关闭侧栏后重新打开；若仍不行，刷新 x.com 页面再试。';

function startProgressWatcher(storageKey, onUpdate) {
  stopProgressWatcher();
  const wrapped = (data) => {
    longTouch?.();
    onUpdate(data);
  };
  if (storageKey === 'fetchProgress' || storageKey === 'enrichProgress' || storageKey === 'unfollowProgress') {
    stateSyncListener = (message) => {
      if (message && message.direction === 'STATE_SYNC' && message.type === storageKey) {
        wrapped(message.data);
      }
    };
    chrome.runtime.onMessage.addListener(stateSyncListener);
  } else {
    progressWatcher = setInterval(async () => {
      const data = await chrome.storage.local.get(storageKey);
      if (data[storageKey]) wrapped(data[storageKey]);
    }, 350);
  }
}

function stopProgressWatcher() {
  if (stateSyncListener) {
    chrome.runtime.onMessage.removeListener(stateSyncListener);
    stateSyncListener = null;
  }
  if (progressWatcher) { clearInterval(progressWatcher); progressWatcher = null; }
  if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
}

async function startFetch() {
  isFetching = true;
  btnFetch.disabled = true;
  btnCancelFetch.classList.remove('hidden');
  progressArea.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressLabel.textContent = '正在获取关注列表…';
  await chrome.storage.local.remove('enrichProgress');
  // Keep existing list visible while the network request runs

  startProgressWatcher('fetchProgress', (p) => {
    if (p.phase === 'fetch_page') {
      if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
      progressLabel.textContent = `第 ${p.page} 页 —— 已获取 ${p.total} 个账号…`;
      progressBarFill.style.width = `${Math.min(5 + p.page * 3, 68)}%`;
    } else if (p.phase === 'rate_limit') {
      const secs = Math.ceil(p.waitMs / 1000);
      setStatus('warn', `已触发限流（${secs} 秒）`);
      startRateLimitCountdown(p.waitMs, '已触发限流');
    }
  });

  try {
    const res = await sendLong('FETCH_FOLLOWING', {});
    stopProgressWatcher();

    if (res?.__idle) {
      showToast(BRIDGE_DEAD_HINT, 9000);
      setStatus('error', '后台链路无响应');
      resetFetchUI();
      return;
    }
    if (!res || !res.success) {
      showToast(res?.error || '面板已断开 —— 请关闭后重新打开侧边栏。', 6000);
      setStatus('warn', res?.error || '连接已断开');
      resetFetchUI();
      return;
    }

    const merged = res.users;
    const newCount = res.newCount ?? merged.length;
    progressBarFill.style.width = '70%';

    allUsers = merged;
    // Render immediately — show known data; accounts still needing a check show no badge
    const hasEnrichedData = merged.some((u) => u.activityChecked !== undefined);
    listLoading.classList.add('hidden');
    renderList(hasEnrichedData);

    // Mark onboarding complete on first successful fetch
    if (!hasOnboarded) {
      hasOnboarded = true;
      await chrome.storage.local.set({ hasOnboarded: true });
    }

    // Accounts whose last status was a native RT (or had no status) still need one API call
    // to find their last original post. Also retry anyone previously marked Unknown —
    // we now have better fallbacks (include_rts=1 + lastRetweetAt) that may resolve them.
    const needsEnrichment = merged.some(
      (u) => !u.protected && u.statusesCount !== 0 &&
             (u.activityChecked === undefined || isUnknown(u))
    );

    if (!needsEnrichment) {
      // Everything resolved — either from inline status or cache, no extra API calls needed
      progressBarFill.style.width = '100%';
      const inactive = allUsers.filter(isInactive).length;
      if (newCount === 0) {
        progressLabel.textContent = `没有发现新账号 —— ${merged.length} 个账号的数据均为最新。`;
        showToast(`${merged.length} 个账号的数据均为最新。`);
      } else {
        progressLabel.textContent = `完成 —— 找到 ${inactive} 个不活跃账号。`;
        showToast(`新增 ${newCount} 个账号。`);
      }
      setStatus('ok', `${allUsers.length} 个账号 · ${inactive} 个不活跃`);
      setTimeout(() => progressArea.classList.add('hidden'), 3000);
      resetFetchUI();
    } else {
      // Some accounts only retweet — need user_timeline call to find their last original post
      progressLabel.textContent = hasEnrichedData
        ? `${newCount > 0 ? `新增 ${newCount} 个 —— ` : ''}正在检查剩余账号的活跃度…`
        : `已获取 ${merged.length} 个账号 —— 正在检查活跃度…`;
      await startEnrich(merged);
    }
  } catch (e) {
    stopProgressWatcher();
    showToast(`出错：${e.message}`, 6000);
    setStatus('error', e.message);
    resetFetchUI();
  }
}

async function startEnrich(users) {
  isEnriching = true;
  await chrome.storage.local.remove('enrichProgress');
  startProgressWatcher('enrichProgress', (p) => {
    if (p.phase === 'enrich' && p.total > 0) {
      if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
      const pct = 70 + Math.round((p.index / p.total) * 30);
      progressBarFill.style.width = `${pct}%`;
      progressLabel.textContent = `检查活跃度：${p.index + 1} / ${p.total}`;
      if (p.user) {
        // Keep allUsers in sync so partial state is correct if enrichment is interrupted.
        const idx = allUsers.findIndex((u) => u.id === p.user.id);
        if (idx !== -1) allUsers[idx] = p.user;
        updateAccountItem(p.user, true);
        updateStats();
      }
    } else if (p.phase === 'rate_limit') {
      startRateLimitCountdown(p.waitMs, '已触发限流');
    }
  });

  try {
    const res = await sendLong('ENRICH_ACTIVITY', { users });
    stopProgressWatcher();

    if (res?.__idle) {
      showToast(BRIDGE_DEAD_HINT, 9000);
      setStatus('error', '后台链路无响应');
    } else if (!res) {
      showToast('面板已断开 —— 请关闭后重新打开侧边栏。', 6000);
      setStatus('warn', '连接已断开');
    } else if (res.success) {
      allUsers = res.users;
      const inactive = allUsers.filter(isInactive).length;

      // Auto-switch to Inactive tab if any were found
      if (inactive > 0) {
        currentView = 'inactive';
        document.querySelectorAll('.view-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.view === 'inactive');
        });
      }

      renderList(true);
      progressBarFill.style.width = '100%';
      progressLabel.textContent = `完成 —— 找到 ${inactive} 个不活跃账号。`;
      setStatus('ok', `${allUsers.length} 个账号 · ${inactive} 个不活跃`);
      setTimeout(() => progressArea.classList.add('hidden'), 3000);
    } else if (res.cancelled) {
      showToast('已取消活跃度检查。', 3000);
    } else {
      showToast(res.error || '活跃度检查失败。', 6000);
      setStatus('error', res.error || '活跃度检查失败');
    }
  } catch (e) {
    stopProgressWatcher();
    showToast(`活跃度检查出错：${e.message}`, 6000);
    setStatus('error', e.message);
  } finally {
    isEnriching = false;
    resetFetchUI();
  }
}

function resetFetchUI() {
  isFetching = false;
  isEnriching = false;
  btnFetch.disabled = false;
  btnCancelFetch.classList.add('hidden');
  listLoading.classList.add('hidden');
  stopProgressWatcher();
}

// ---------------------------------------------------------------------------
// Unfollow
// ---------------------------------------------------------------------------
async function startUnfollow() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  if (!confirm(`确定要取关这 ${ids.length} 个账号吗？`)) return;

  isUnfollowing = true;
  btnUnfollow.disabled = true;
  btnCancelUnfollow.classList.remove('hidden');
  unfollowProgressArea.classList.remove('hidden');
  unfollowBarFill.style.width = '0%';
  unfollowLabel.textContent = `正在取关 0 / ${ids.length}…`;

  startProgressWatcher('unfollowProgress', (p) => {
    if (p.phase === 'unfollow_progress') {
      const pct = Math.round((p.done / p.total) * 100);
      unfollowBarFill.style.width = `${pct}%`;
      unfollowLabel.textContent = `正在取关 ${p.done} / ${p.total}…`;
      const li = accountList.querySelector(`[data-user-id="${p.userId}"]`);
      if (li) li.classList.add('is-unfollowed');
    } else if (p.phase === 'unfollow_error') {
      const li = accountList.querySelector(`[data-user-id="${p.userId}"]`);
      if (li) {
        li.classList.add('is-unfollow-failed');
        li.title = p.error || '取关失败';
      }
    } else if (p.phase === 'rate_limit') {
      unfollowLabel.textContent = `已触发限流 —— 等待 ${Math.ceil(p.waitMs / 1000)} 秒…`;
    }
  });

  try {
    const res = await sendLong('UNFOLLOW', { userIds: ids });
    stopProgressWatcher();

    if (res?.__idle) {
      showToast(BRIDGE_DEAD_HINT, 9000);
      setStatus('error', '后台链路无响应');
      return;   // finally 里会恢复按钮状态
    }
    const p = res?.progress || {};
    const done = p.done ?? 0;
    const phase = p.phase || '';

    // If user cancelled, don't treat remaining accounts as successfully unfollowed.
    if (phase === 'unfollow_cancelled') {
      // Remove only the ones we actually unfollowed (marked in the DOM).
      const removedIds = Array.from(
        accountList.querySelectorAll('.account-item.is-unfollowed')
      ).map((li) => li.dataset.userId);

      if (removedIds.length > 0) {
        await send('REMOVE_UNFOLLOWED', { userIds: removedIds });
        allUsers = allUsers.filter((u) => !removedIds.includes(u.id));
        renderList(true);
        await refreshHealthAfterUnfollow(removedIds.length);
      }

      unfollowBarFill.style.width = `${Math.round((done / ids.length) * 100)}%`;
      unfollowLabel.textContent = `已停止，完成 ${done} / ${ids.length}。`;
      showToast(`已停止取关，共取关 ${done} 个账号。`, 6000);
      setStatus('warn', `取关已停止（${done}/${ids.length}）`);
      return;
    }
    const failedIds = new Set(p.failed || []);
    const errorsMap = p.errors || {};
    const successfulIds = ids.filter((id) => !failedIds.has(id));
    unfollowBarFill.style.width = '100%';
    const failedCount = failedIds.size;
    if (failedCount > 0) {
      const firstError = Object.values(errorsMap)[0] || '未知错误';
      unfollowLabel.textContent = `已取关 ${done} / ${ids.length} —— ${failedCount} 个失败。`;
      const is401 = /401|authentication failed|身份验证失败|未登录|登录状态/i.test(firstError);
      const toastMsg = is401
        ? '登录状态已失效。请刷新 x.com 页面（或重新登录），然后重新执行取关。'
        : `${failedCount} 个账号取关失败：${firstError}`;
      showToast(toastMsg, is401 ? 12000 : 8000);
      setStatus('warn', `已取关 ${done} 个，${failedCount} 个失败`);
    } else {
      unfollowLabel.textContent = `已取关 ${done} 个账号。`;
      showToast(`已取关 ${done} 个账号。`);
      setStatus('ok', `已取关 ${done} 个`);
    }

    if (successfulIds.length > 0) {
      await send('REMOVE_UNFOLLOWED', { userIds: successfulIds });
      allUsers = allUsers.filter((u) => !successfulIds.includes(u.id));
      renderList(true);
      await refreshHealthAfterUnfollow(successfulIds.length);
    }
  } catch (e) {
    stopProgressWatcher();
    showToast(`出错：${e.message}`, 6000);
    setStatus('error', e.message);
  } finally {
    isUnfollowing = false;
    btnUnfollow.disabled = false;
    btnCancelUnfollow.classList.add('hidden');
    setTimeout(() => { unfollowProgressArea.classList.add('hidden'); updateStats(); }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
btnRefresh.addEventListener('click', checkLogin);

// 健康度
btnHealthRefresh.addEventListener('click', () => loadMyProfile(true));
btnSelectHealthy.addEventListener('click', autoSelectToHealthy);
btnManualSave.addEventListener('click', saveManualCounts);
btnManualEdit.addEventListener('click', () => {
  showManualEntry(true, meProfile);
  manualFollowing.focus();
});

function applyHealthCollapsed(collapsed) {
  healthCollapsed = collapsed;
  healthCard.classList.toggle('is-collapsed', collapsed);
  btnHealthToggle.textContent = collapsed ? '展开' : '收起';
}

btnHealthToggle.addEventListener('click', async () => {
  applyHealthCollapsed(!healthCollapsed);
  try { await chrome.storage.local.set({ healthCollapsed }); } catch (_) {}
});

selectThreshold.addEventListener('change', () => {
  const custom = selectThreshold.value === 'custom';
  inputCustomDays.classList.toggle('hidden', !custom);
  if (!custom) { renderList(true); }
});
inputCustomDays.addEventListener('input', () => renderList(true));

btnFetch.addEventListener('click', () => { if (!isFetching && !isEnriching) startFetch(); });

btnCancelFetch.addEventListener('click', async () => {
  await send('CANCEL_FETCH');
  btnCancelFetch.classList.add('hidden');
  showToast('已取消获取。');
});

btnToggleAll.addEventListener('click', () => {
  // Toggle between select all / deselect all for accounts currently visible in the active tab
  const checkboxes = accountList.querySelectorAll('.account-checkbox');
  const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
  if (allChecked) {
    checkboxes.forEach((cb) => { cb.checked = false; selectedIds.delete(cb.dataset.userId); });
    btnToggleAll.textContent = '全选';
  } else {
    checkboxes.forEach((cb) => { cb.checked = true; selectedIds.add(cb.dataset.userId); });
    btnToggleAll.textContent = '取消全选';
  }
  updateStats();
});

// View filter tabs
function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  renderList(isEnriched);
  // Restore scroll to top when switching tabs
  $('list-container').scrollTop = 0;
}

document.querySelectorAll('.view-tab').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

// Sort select
selectSort.addEventListener('change', () => {
  currentSort = selectSort.value;
  renderList(isEnriched);
  $('list-container').scrollTop = 0;
});

btnUnfollow.addEventListener('click', startUnfollow);
btnCancelUnfollow.addEventListener('click', async () => {
  await send('CANCEL_UNFOLLOW');
  showToast('已停止取关。');
});

// ---------------------------------------------------------------------------
// Onboarding guide
// ---------------------------------------------------------------------------
async function markOnboarded() {
  hasOnboarded = true;
  await chrome.storage.local.set({ hasOnboarded: true });
  sectionGuide.classList.add('hidden');
  await checkLogin();
}

btnGuideCheck.addEventListener('click', markOnboarded);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
const sunIcon  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  btnTheme.innerHTML = theme === 'dark' ? sunIcon : moonIcon;
  btnTheme.title = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { await chrome.storage.local.set({ theme: next }); } catch (_) {}
}

btnTheme.addEventListener('click', toggleTheme);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    const stored = await chrome.storage.local.get(['hasOnboarded', 'theme', 'healthCollapsed']);
    hasOnboarded = !!stored.hasOnboarded;
    applyHealthCollapsed(!!stored.healthCollapsed);
    const theme = stored.theme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(theme);
  } catch (_) {
    hasOnboarded = false;
    applyHealthCollapsed(false);
    applyTheme('light');
  }

  if (hasOnboarded) {
    setStatus('checking', '检查中…');
    await checkLogin();
  } else {
    setStatus('ok', '就绪');
    sectionNotLoggedIn.classList.add('hidden');
    sectionGuide.classList.remove('hidden');
    sectionApp.classList.add('hidden');
  }
}

init().catch(() => {});
});
