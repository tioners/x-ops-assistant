/**
 * health.js — 账号健康度计算（纯函数，无 DOM 依赖）
 *
 * 系数 = 关注数 ÷ 粉丝数
 *   ≤ 0.6      健康        权重 100%
 *   0.6 ~ 1    不健康      权重降低 30%~70%，推流变慢
 *   1 ~ 2      坐牢        降权 70%~90%
 *   > 2        踢出公域流量池
 */
(function (root) {
  'use strict';

  const HEALTH_TIERS = [
    {
      key: 'ok', label: '健康', min: 0, max: 0.6, weight: [100, 100],
      desc: '健康状态：正常推荐，权重 100%。',
    },
    {
      key: 'warn', label: '不健康', min: 0.6, max: 1, weight: [70, 30],
      desc: '不健康状态：权重降低 30%~70%，推流变慢。',
    },
    {
      key: 'bad', label: '坐牢', min: 1, max: 2, weight: [30, 10],
      desc: '坐牢状态：降权 70%~90%，基本拿不到新的公域流量。',
    },
    {
      key: 'out', label: '踢出公域', min: 2, max: Infinity, weight: [0, 0],
      desc: '已超出上限：不再进入公域推荐流量池。',
    },
  ];

  /** 系数 → 档位。边界归入较低风险一侧：0.6 健康、1 不健康、2 坐牢。 */
  function tierOf(ratio) {
    if (!Number.isFinite(ratio)) return HEALTH_TIERS[3];
    for (const t of HEALTH_TIERS) {
      if (ratio <= t.max) return t;
    }
    return HEALTH_TIERS[3];
  }

  /** 在档位区间内线性估算剩余权重（仅作直观参考）。 */
  function estimateWeight(ratio, tier) {
    const t = tier || tierOf(ratio);
    const [hi, lo] = t.weight;
    if (!Number.isFinite(t.max)) return lo;
    if (hi === lo) return hi;
    const span = t.max - t.min;
    const p = span > 0 ? Math.min(1, Math.max(0, (ratio - t.min) / span)) : 0;
    return Math.round(hi - (hi - lo) * p);
  }

  /** 系数。粉丝数为 0 时按无穷大处理（无粉丝但有跟随时风险最高）。 */
  function ratioOf(following, followers) {
    const N = Math.max(0, Number(following) || 0);
    const F = Math.max(0, Number(followers) || 0);
    if (F > 0) return N / F;
    return N > 0 ? Infinity : 0;
  }

  /**
   * 固定当前粉丝数，反推「关注数」的四个档位边界。
   * 健康 N ≤ 0.6F；不健康 0.6F < N ≤ F；坐牢 F < N ≤ 2F；踢出 N > 2F。
   */
  function followingRanges(followers) {
    const F = Math.max(0, Math.floor(Number(followers) || 0));
    const okMax   = Math.floor(F * 0.6);
    const warnMax = Math.floor(F * 1);
    const badMax  = Math.floor(F * 2);
    return {
      followers: F,
      okMax,
      warnMin: okMax + 1,
      warnMax,
      badMin: warnMax + 1,
      badMax,
      outMin: badMax + 1,
    };
  }

  /** 要回到健康区间，至少需要取关多少个。 */
  function unfollowNeeded(following, followers) {
    const N = Math.max(0, Math.floor(Number(following) || 0));
    return Math.max(0, N - followingRanges(followers).okMax);
  }

  const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—');
  const fmtSpan = (from, to) => (to < from ? '—' : `${fmtNum(from)} – ${fmtNum(to)}`);

  const api = {
    HEALTH_TIERS,
    tierOf,
    estimateWeight,
    ratioOf,
    followingRanges,
    unfollowNeeded,
    fmtNum,
    fmtSpan,
  };

  root.XHealth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
