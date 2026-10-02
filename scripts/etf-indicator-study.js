// 159509 纳指科技ETF — 多指标 / 组合策略回测研究
// 数据：新浪日K（OHLCV）+ 天天基金单位净值（算溢价）
//
// 用途：验证「RSI / 威廉%R / KDJ / 布林带 / MACD 及各种组合」在本标的上的真实表现，
//       输出 23 套策略的收益-回撤对比 + 指标分档前瞻收益 + 溢价口径敏感性压力测试。
// 运行：node scripts/etf-indicator-study.js
// 结论（2026-10-02 实测，764 交易日）：见 .workbuddy/memory/2026-10-02.md
//   · 摆动指标单独择时全部大幅跑输买入持有（卖出即卖飞主升浪）
//   · 溢价率是一级变量；最优组合 = 溢价 ≤18% 买 + 「不追高」过滤器（威廉%R≤-60 / 收盘<MA21）
//   · 止损是负贡献；回撤只能靠仓位管理而非择时规避
const SYMBOL = 'sz159509';
const FUND = '159509';

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.text();
}

async function getKline() {
  const txt = await get(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${SYMBOL}&scale=240&ma=no&datalen=1023`,
    { Referer: 'https://finance.sina.com.cn/' });
  return JSON.parse(txt).map(r => ({
    date: String(r.day).slice(0, 10), open: +r.open, close: +r.close, high: +r.high, low: +r.low,
    volume: +r.volume,
  })).filter(r => isFinite(r.close));
}

async function getNav() {
  const txt = await get(`https://fund.eastmoney.com/pingzhongdata/${FUND}.js`, { Referer: 'https://fund.eastmoney.com/' });
  const m = txt.match(/var Data_netWorthTrend = (\[[\s\S]*?\]);/);
  const nav = {};
  for (const x of JSON.parse(m[1])) {
    if (!isFinite(x.x) || !isFinite(x.y)) continue;
    nav[new Date(x.x + 8 * 3600e3).toISOString().slice(0, 10)] = x.y;
  }
  return nav;
}

// ─── 指标 ───
const sma = (a, p) => a.map((_, i) => i + 1 < p ? null : a.slice(i + 1 - p, i + 1).reduce((s, v) => s + v, 0) / p);
function ema(a, p) { const k = 2 / (p + 1); let prev = a[0]; return a.map((v, i) => (prev = i ? v * k + prev * (1 - k) : a[0])); }
function rsi(c, p = 14) {
  const out = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
function williamsR(H, L, C, p = 14) {
  return C.map((c, i) => {
    if (i + 1 < p) return null;
    const hh = Math.max(...H.slice(i + 1 - p, i + 1)), ll = Math.min(...L.slice(i + 1 - p, i + 1));
    return hh === ll ? -50 : (hh - c) / (hh - ll) * -100;
  });
}
function kdj(H, L, C, p = 9) {
  const K = [], D = [], J = []; let k = 50, d = 50;
  for (let i = 0; i < C.length; i++) {
    if (i + 1 < p) { K.push(null); D.push(null); J.push(null); continue; }
    const hh = Math.max(...H.slice(i + 1 - p, i + 1)), ll = Math.min(...L.slice(i + 1 - p, i + 1));
    const rsv = hh === ll ? 50 : (C[i] - ll) / (hh - ll) * 100;
    k = 2 / 3 * k + 1 / 3 * rsv; d = 2 / 3 * d + 1 / 3 * k;
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  }
  return { K, D, J };
}
function boll(C, p = 20, mult = 2) {
  const mid = sma(C, p), up = [], dn = [];
  for (let i = 0; i < C.length; i++) {
    if (mid[i] == null) { up.push(null); dn.push(null); continue; }
    const seg = C.slice(i + 1 - p, i + 1);
    const sd = Math.sqrt(seg.reduce((s, v) => s + (v - mid[i]) ** 2, 0) / p);
    up.push(mid[i] + mult * sd); dn.push(mid[i] - mult * sd);
  }
  return { mid, up, dn };
}
function atr(H, L, C, p = 14) {
  const tr = C.map((c, i) => i === 0 ? H[0] - L[0] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  return ema(tr, p);
}
function macd(C, f = 12, s = 26, sig = 9) {
  const ef = ema(C, f), es = ema(C, s);
  const dif = ef.map((v, i) => v - es[i]);
  const dea = ema(dif, sig);
  return { dif, dea, hist: dif.map((v, i) => v - dea[i]) };
}

// ─── 回测引擎：全仓、收盘成交、可选跟踪止损 ───
function backtest(name, klines, buyFn, sellFn, opt = {}) {
  const n = klines.length;
  let cash = 1, shares = 0, trades = 0, wins = 0, entry = 0, peak = 0, exposure = 0;
  const curve = [];
  const rets = [];
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    if (shares === 0) {
      if (buyFn(i)) { shares = cash / k.close; cash = 0; trades++; entry = k.close; peak = k.close; }
    } else {
      peak = Math.max(peak, k.high);
      const stopHit = opt.trailPct && k.close <= peak * (1 - opt.trailPct);
      const stopAtr = opt.trailAtr && k.close <= peak - opt.trailAtr * opt.atrArr[i];
      const hardStop = opt.hardStopPct && k.close <= entry * (1 - opt.hardStopPct);
      if (stopHit || stopAtr || hardStop || sellFn(i)) {
        if (k.close > entry) wins++;
        rets.push(k.close / entry - 1);
        cash = shares * k.close; shares = 0;
      }
    }
    if (shares > 0) exposure++;
    curve.push(shares > 0 ? shares * k.close : cash);
  }
  const equity = shares > 0 ? shares * klines[n - 1].close : cash;
  let pk = curve[0], mdd = 0;
  for (const v of curve) { pk = Math.max(pk, v); mdd = Math.min(mdd, (v / pk - 1) * 100); }
  const yrs = n / 252;
  const annual = (Math.pow(equity, 1 / yrs) - 1) * 100;
  return {
    name,
    total: +((equity - 1) * 100).toFixed(1),
    annual: +annual.toFixed(1),
    mdd: +mdd.toFixed(1),
    calmar: mdd < -0.05 ? +(annual / Math.abs(mdd)).toFixed(2) : null,
    trades, winPct: trades ? +(wins / trades * 100).toFixed(0) : null,
    exposure: +(exposure / n * 100).toFixed(0),
    holding: shares > 0,
    avgWin: rets.length ? +(rets.reduce((a, b) => a + b, 0) / rets.length * 100).toFixed(2) : null,
  };
}

(async () => {
  const klines = await getKline();
  const navMap = await getNav();
  const C = klines.map(k => k.close), H = klines.map(k => k.high), L = klines.map(k => k.low);
  const n = klines.length;

  // 溢价：日终口径（当日净值）/ 保守口径（T-1 净值，避免未来信息）
  // 净值缺失日（如当日净值尚未公布）以前一可用净值前向填充 —— 等价于真实场景中用 IOPV 估算
  const navFF = new Array(n).fill(null);
  { let lastV = null; for (let i = 0; i < n; i++) { const v = navMap[klines[i].date]; if (v > 0) lastV = v; navFF[i] = lastV; } }
  const premNow = i => navFF[i] > 0 ? (C[i] / navFF[i] - 1) * 100 : null;
  const premLag = i => (i > 0 && navFF[i - 1] > 0) ? (C[i] / navFF[i - 1] - 1) * 100 : null;

  const R = rsi(C, 14), WR = williamsR(H, L, C, 14), { K, D, J } = kdj(H, L, C, 9);
  const B = boll(C, 20, 2), A = atr(H, L, C, 14), M = macd(C);
  const ma5 = sma(C, 5), ma21 = sma(C, 21), ma60 = sma(C, 60);

  const covers = klines.filter((k, i) => premNow(i) != null).length;
  console.log(`样本：${klines[0].date} → ${klines[n - 1].date}，${n} 交易日，溢价可用 ${covers} 日`);
  console.log(`价格 ${C[0]} → ${C[n - 1]}（${((C[n - 1] / C[0] - 1) * 100).toFixed(1)}%）\n`);

  const cross = (a, b, i, up) => a[i - 1] != null && b[i - 1] != null && (up ? a[i - 1] <= b[i - 1] && a[i] > b[i] : a[i - 1] >= b[i - 1] && a[i] < b[i]);
  const mx = (arr, i, p) => Math.max(...arr.slice(Math.max(0, i + 1 - p), i + 1));
  const mn = (arr, i, p) => Math.min(...arr.slice(Math.max(0, i + 1 - p), i + 1));

  const S = [];
  const add = (nm, buy, sell, opt) => S.push(backtest(nm, klines, buy, sell, opt));

  // 基准 & 现有策略
  S.push((() => {
    const g = C[n - 1] / C[0]; const yrs = n / 252;
    let pk = C[0], mdd = 0;
    for (const c of C) { pk = Math.max(pk, c); mdd = Math.min(mdd, (c / pk - 1) * 100); }
    const annual = (Math.pow(g, 1 / yrs) - 1) * 100;
    return { name: '① 买入持有（基准）', total: +((g - 1) * 100).toFixed(1), annual: +annual.toFixed(1), mdd: +mdd.toFixed(1), calmar: +(annual / Math.abs(mdd)).toFixed(2), trades: 1, winPct: null, exposure: 100, holding: true, avgWin: null };
  })());
  add('② MACD 金叉买 / 死叉卖', i => i > 0 && cross(M.dif, M.dea, i, true), i => i > 0 && cross(M.dif, M.dea, i, false));
  add('③ 纯溢价：<18% 买 / ≥22% 卖', i => premNow(i) != null && premNow(i) < 18, i => premNow(i) != null && premNow(i) >= 22);
  add('④ 溢价≤18% 买 / 跌破 MA21 卖', i => premNow(i) != null && premNow(i) <= 18, i => ma21[i] != null && C[i] < ma21[i]);

  // 单指标
  add('⑤ RSI<30 买 / RSI>70 卖', i => R[i] != null && R[i] < 30, i => R[i] != null && R[i] > 70);
  add('⑥ RSI<30 买 / RSI>60 卖', i => R[i] != null && R[i] < 30, i => R[i] != null && R[i] > 60);
  add('⑦ 威廉%R≤-80 买 / ≥-20 卖', i => WR[i] != null && WR[i] <= -80, i => WR[i] != null && WR[i] >= -20);
  add('⑧ KDJ：K<30 金叉买 / K>70 死叉卖',
    i => i > 0 && K[i] != null && cross(K, D, i, true) && K[i] < 30,
    i => i > 0 && K[i] != null && cross(K, D, i, false) && K[i] > 70);
  add('⑨ 布林带：触下轨买 / 触上轨卖', i => B.dn[i] != null && C[i] <= B.dn[i], i => B.up[i] != null && C[i] >= B.up[i]);
  add('⑩ MA5/MA21 金叉买 / 死叉卖', i => i > 0 && cross(ma5, ma21, i, true), i => i > 0 && cross(ma5, ma21, i, false));

  // 组合
  add('⑪ RSI<35 ∩ 溢价≤18 买 / RSI>70 ∪ 溢价≥22 卖',
    i => R[i] != null && R[i] < 35 && premNow(i) != null && premNow(i) <= 18,
    i => (R[i] != null && R[i] > 70) || (premNow(i) != null && premNow(i) >= 22));
  add('⑫ 布林下轨 ∩ RSI<35 买 / 上轨 ∪ 溢价≥22 卖',
    i => B.dn[i] != null && C[i] <= B.dn[i] && R[i] != null && R[i] < 35,
    i => (B.up[i] != null && C[i] >= B.up[i]) || (premNow(i) != null && premNow(i) >= 22));
  add('⑬ MA60 上方 + 溢价≤18 买 / 溢价≥22 卖',
    i => ma60[i] != null && C[i] > ma60[i] && premNow(i) != null && premNow(i) <= 18,
    i => premNow(i) != null && premNow(i) >= 22);
  add('⑭ MACD 金叉 ∩ RSI<60 ∩ 溢价≤18 买 / MACD 死叉 ∪ 溢价≥22 卖',
    i => i > 0 && cross(M.dif, M.dea, i, true) && R[i] != null && R[i] < 60 && premNow(i) != null && premNow(i) <= 18,
    i => (i > 0 && cross(M.dif, M.dea, i, false)) || (premNow(i) != null && premNow(i) >= 22));
  add('⑮ 溢价≤18 买 + 3×ATR 跟踪止损', i => premNow(i) != null && premNow(i) <= 18, () => false, { trailAtr: 3, atrArr: A });
  add('⑯ ⑪的买点 + 3×ATR 跟踪止损',
    i => R[i] != null && R[i] < 35 && premNow(i) != null && premNow(i) <= 18,
    i => (R[i] != null && R[i] > 70) || (premNow(i) != null && premNow(i) >= 22),
    { trailAtr: 3, atrArr: A });
  add('⑰ ⑪的买点 + 固定 -12% 硬止损',
    i => R[i] != null && R[i] < 35 && premNow(i) != null && premNow(i) <= 18,
    i => (R[i] != null && R[i] > 70) || (premNow(i) != null && premNow(i) >= 22),
    { hardStopPct: 0.12 });
  // 卖出更保守：只在溢价高企时减，其余时间持有
  add('⑱ 溢价≤18 买 / 只在溢价≥25 或 RSI>78 卖',
    i => premNow(i) != null && premNow(i) <= 18,
    i => (premNow(i) != null && premNow(i) >= 25) || (R[i] != null && R[i] > 78));
  add('⑲ 溢价≤18 买 / 溢价≥27 才卖（拉长持有）',
    i => premNow(i) != null && premNow(i) <= 18,
    i => premNow(i) != null && premNow(i) >= 27);
  add('⑳ 溢价≤18 ∩ RSI<45 买 / 溢价≥22 卖（RSI 只作买点筛选，不作卖出）',
    i => premNow(i) != null && premNow(i) <= 18 && R[i] != null && R[i] < 45,
    i => premNow(i) != null && premNow(i) >= 22);
  add('㉑ 溢价≤18 ∩ 威廉%R≤-60 买 / 溢价≥22 卖',
    i => premNow(i) != null && premNow(i) <= 18 && WR[i] != null && WR[i] <= -60,
    i => premNow(i) != null && premNow(i) >= 22);
  add('㉒ 溢价≤18 ∩ 布林下半区买 / 溢价≥22 卖',
    i => premNow(i) != null && premNow(i) <= 18 && B.mid[i] != null && C[i] < B.mid[i],
    i => premNow(i) != null && premNow(i) >= 22);
  add('㉓ 溢价≤18 ∩ 价格<MA21 买 / 溢价≥22 卖（跌着买）',
    i => premNow(i) != null && premNow(i) <= 18 && ma21[i] != null && C[i] < ma21[i],
    i => premNow(i) != null && premNow(i) >= 22);

  // 溢价口径敏感性（用 T-1 净值，剔除未来信息）
  const S2 = [
    backtest('㉑(T-1口径) 溢价≤18 ∩ 威廉%R≤-60 买 / 溢价≥22 卖', klines,
      i => premLag(i) != null && premLag(i) <= 18 && WR[i] != null && WR[i] <= -60,
      i => premLag(i) != null && premLag(i) >= 22),
    backtest('㉒(T-1口径) 溢价≤18 ∩ 收盘<布林中轨 买 / 溢价≥22 卖', klines,
      i => premLag(i) != null && premLag(i) <= 18 && B.mid[i] != null && C[i] < B.mid[i],
      i => premLag(i) != null && premLag(i) >= 22),
    backtest('㉓(T-1口径) 溢价≤18 ∩ 收盘<MA21 买 / 溢价≥22 卖', klines,
      i => premLag(i) != null && premLag(i) <= 18 && ma21[i] != null && C[i] < ma21[i],
      i => premLag(i) != null && premLag(i) >= 22),
    backtest('③(T-1口径) 纯溢价：<18% 买 / ≥22% 卖', klines,
      i => premLag(i) != null && premLag(i) < 18, i => premLag(i) != null && premLag(i) >= 22),
    backtest('⑱(T-1口径) 溢价≤18 买 / 溢价≥25 卖', klines,
      i => premLag(i) != null && premLag(i) <= 18, i => premLag(i) != null && premLag(i) >= 25),
    backtest('④(T-1净值口径) 溢价≤18 买 / 跌破 MA21 卖', klines,
      i => premLag(i) != null && premLag(i) <= 18, i => ma21[i] != null && C[i] < ma21[i]),
  ];

  const pad = (s, w) => String(s).padEnd(w, ' ');
  const padL = (s, w) => String(s).padStart(w);
  const show = list => {
    console.log(pad('策略', 40) + padL('总收益%', 9) + padL('年化%', 8) + padL('最大回撤%', 10) + padL('Calmar', 8) + padL('交易', 6) + padL('胜率%', 7) + padL('持仓%', 7));
    console.log('-'.repeat(95));
    for (const r of list) {
      console.log(pad(r.name, 40) + padL(r.total, 9) + padL(r.annual, 8) + padL(r.mdd, 10) + padL(r.calmar ?? '—', 8) + padL(r.trades, 6) + padL(r.winPct ?? '—', 7) + padL(r.exposure, 7));
    }
  };
  show(S);
  console.log('\n【溢价口径敏感性：改用 T-1 净值（无未来信息）】');
  show(S2);

  // 按 Calmar 排名
  console.log('\n【按 Calmar（年化/最大回撤）排名】');
  [...S].filter(r => r.calmar != null && r.trades > 0).sort((a, b) => b.calmar - a.calmar)
    .forEach((r, i) => console.log(`${i + 1}. ${r.name}  Calmar ${r.calmar}  年化 ${r.annual}%  回撤 ${r.mdd}%  交易 ${r.trades} 次`));

  // 指标当前值
  const last = n - 1;
  console.log(`\n【当前指标读数 ${klines[last].date}】`);
  console.log(`RSI(14)=${R[last].toFixed(1)}  威廉%R=${WR[last].toFixed(1)}  K=${K[last].toFixed(1)} D=${D[last].toFixed(1)} J=${J[last].toFixed(1)}`);
  console.log(`布林 上=${B.up[last].toFixed(3)} 中=${B.mid[last].toFixed(3)} 下=${B.dn[last].toFixed(3)}  收盘=${C[last]}`);
  console.log(`MACD dif=${M.dif[last].toFixed(4)} dea=${M.dea[last].toFixed(4)} hist=${M.hist[last].toFixed(4)}`);
  console.log(`MA21=${ma21[last].toFixed(3)} MA60=${ma60[last].toFixed(3)} ATR=${A[last].toFixed(3)} 溢价=${premNow(last)?.toFixed(2)}%`);

  // RSI / 威廉 分档前瞻收益（验证阈值是否合理）
  const stat = (name, arr, buckets) => {
    console.log(`\n【${name} 分档 → 未来 20 日收益】`);
    for (const [lo, hi] of buckets) {
      const idx = arr.map((v, i) => [v, i]).filter(([v]) => v != null && v >= lo && v < hi).map(([, i]) => i).filter(i => i + 20 < n);
      if (!idx.length) { console.log(`  ${lo}~${hi}: 样本 0`); continue; }
      const rets = idx.map(i => (C[i + 20] / C[i] - 1) * 100);
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      const win = rets.filter(v => v > 0).length / rets.length * 100;
      console.log(`  ${String(lo).padStart(4)}~${String(hi).padEnd(4)}: 样本 ${String(idx.length).padStart(3)}  平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%  胜率 ${win.toFixed(0)}%  最差 ${Math.min(...rets).toFixed(1)}%`);
    }
  };
  stat('RSI(14)', R, [[0, 20], [20, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 101]]);
  stat('威廉%R(14)', WR, [[-101, -90], [-90, -80], [-80, -60], [-60, -40], [-40, -20], [-20, 1]]);
  stat('溢价率', klines.map((_, i) => premNow(i)), [[-100, 5], [5, 10], [10, 15], [15, 18], [18, 22], [22, 27], [27, 40], [40, 999]]);
})().catch(e => { console.error('ERR', e); process.exit(1); });
