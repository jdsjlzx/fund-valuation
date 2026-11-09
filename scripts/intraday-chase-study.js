#!/usr/bin/env node
// ── 分时「追涨闸门 / 走弱减仓」样本检验（159509 纳指科技ETF）──
//
//  数据源（均免登录、可重复抓）：
//    · 东财 5 分钟 K 线：约 42 个交易日，字段含成交额，可还原真实分时均价 VWAP
//    · 新浪 1 分钟 K 线：约 5 个交易日，用于检验信号的「提前量」
//  缓存：data/intraday-study.json；加 --refresh 重新抓取
//
//  用法：
//    node scripts/intraday-chase-study.js             # 用缓存跑报告
//    node scripts/intraday-chase-study.js --refresh   # 重新抓数据再跑
//    node scripts/intraday-chase-study.js --day 2026-11-09
//
//  说明：单一标的、约 40 个交易日、不含历史溢价数据，结论只用于判断阈值方向，
//  不能当作收益承诺；所有判定只用当前及之前的数据，不含未来函数。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const CACHE = path.join(__dirname, '..', 'data', 'intraday-study.json');
const DAILY = path.join(__dirname, '..', 'data', 'etf-mkt-cache.json');
const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const dayArg = args.includes('--day') ? args[args.indexOf('--day') + 1] : null;

const get = url => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } }, res => {
    let s = '';
    res.on('data', d => s += d);
    res.on('end', () => resolve(s));
  }).on('error', reject);
});

async function fetchEm5() {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.159509&klt=5&fqt=0&lmt=6000&end=20500101'
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
  const json = JSON.parse(await get(url));
  return json.data.klines.map(line => {
    const [t, o, c, h, l, v, a] = line.split(',');
    return { day: t, open: +o, close: +c, high: +h, low: +l, volume: +v, amount: +a };
  });
}
async function fetchSina(scale) {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sz159509&scale=${scale}&ma=no&datalen=1023`;
  return JSON.parse(await get(url)).map(r => ({
    day: r.day.replace(' ', ' '), open: +r.open, close: +r.close, high: +r.high, low: +r.low,
    volume: +r.volume, amount: +r.amount,
  }));
}
async function load() {
  if (refresh || !fs.existsSync(CACHE)) {
    process.stdout.write('抓取分钟数据…');
    const em5 = await fetchEm5();
    const m1 = await fetchSina(1);
    fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), symbol: 'sz159509', em5, m1 }));
    console.log(` 完成（5min ${em5.length} 根 / 1min ${m1.length} 根）`);
  }
  const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  // 新浪成交量单位是股，统一换成手，使 amount/(volume*100) 还原成 VWAP
  cached.m1 = cached.m1.map(r => ({ day: r.day, open: +r.open, close: +r.close, high: +r.high, low: +r.low, volume: +r.volume / 100, amount: +r.amount }));
  return cached;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const ratio = (a, f) => a.length ? a.filter(f).length / a.length * 100 : NaN;
const fmt = (v, n = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(n) + '%' : '—');
const byDay = bars => {
  const out = {};
  for (const b of bars) (out[b.day.slice(0, 10)] = out[b.day.slice(0, 10)] || []).push(b);
  return out;
};
const prevCloses = () => {
  const map = {};
  const rows = JSON.parse(fs.readFileSync(DAILY, 'utf8')).klines;
  rows.forEach((r, i) => { if (i) map[r.date] = rows[i - 1].close; });
  return map;
};

// ── 追涨闸门的判定（与服务端 buildEtfChaseGate 同口径，5 分钟粒度回放）──
//  允许 = 时间 < 14:30 且 开盘涨幅 ≤ 0.8% 且 现价 ≥ VWAP 且 偏离 VWAP ≤ 0.6%
function gateOf(s) {
  if (s.t >= '14:30') return { ok: false, why: '尾盘' };
  if (s.openPct > 0.8) return { ok: false, why: '高开' };
  if (s.price < s.vwap) return { ok: false, why: '跌破均价' };
  if ((s.price / s.vwap - 1) * 100 > 0.6) return { ok: false, why: '偏离均价' };
  return { ok: true, why: '允许' };
}

function statesOf(bars, pc) {
  let ca = 0, cv = 0;
  return bars.map(b => {
    ca += b.amount; cv += b.volume;
    return { t: b.day.slice(11, 16), price: b.close, high: b.high, low: b.low,
      vwap: ca / (cv * 100), openPct: (bars[0].open / pc - 1) * 100 };
  });
}

function gateReport(em5, pcOf) {
  const days = byDay(em5);
  const allow = [], block = [];
  const byReason = {};
  let gateDays = 0, gateBlockedDays = 0;
  for (const [date, bars] of Object.entries(days)) {
    const pc = pcOf[date];
    if (!pc || bars.length < 8) continue;
    const states = statesOf(bars, pc);
    let sawAllow = false, sawBlock = false;
    for (let i = 3; i < states.length; i++) {
      const s = states[i];
      const g = gateOf(s);
      const fwd = (bars.at(-1).close / s.price - 1) * 100;
      const item = { date, t: s.t, fwd, openPct: s.openPct };
      if (g.ok) { allow.push(item); sawAllow = true; }
      else { block.push(item); sawBlock = true; (byReason[g.why] = byReason[g.why] || []).push(fwd); }
    }
    if (sawAllow) gateDays++;
    if (!sawAllow && sawBlock) gateBlockedDays++;
  }
  console.log('\n【一】追涨闸门：逐 5 分钟判定，追入后持有到当日收盘');
  console.log(`  样本 ${new Set([...allow, ...block].map(x => x.date)).size} 个交易日 / ${allow.length + block.length} 个判定时点`);
  console.log(`  允许：${allow.length} 个时点（${new Set(allow.map(x => x.date)).size} 天）  到收盘均值 ${fmt(mean(allow.map(x => x.fwd)))}  胜率 ${ratio(allow, x => x.fwd > 0).toFixed(0)}%`);
  console.log(`  拦截：${block.length} 个时点（${new Set(block.map(x => x.date)).size} 天）  到收盘均值 ${fmt(mean(block.map(x => x.fwd)))}  胜率 ${ratio(block, x => x.fwd > 0).toFixed(0)}%`);
  console.log(`  全天从未给出允许信号的日子：${gateBlockedDays} 天`);
  console.log('  按拦截原因拆分：');
  for (const [why, list] of Object.entries(byReason)) {
    console.log(`    ${why.padEnd(6)} n=${String(list.length).padStart(4)}  到收盘均值 ${fmt(mean(list))}`);
  }
  return { allow, block, byReason };
}

// ── 走弱减仓信号：连续 n 根收在 VWAP 下方 ≥ tol，且近 m 根跌幅 ≤ thr ──
function exitOf(bars, pc, { n = 3, tol = 0.003, m = 4, thr = -0.3 } = {}) {
  let ca = 0, cv = 0;
  const vwap = [], price = [];
  bars.forEach(b => { ca += b.amount; cv += b.volume; vwap.push(ca / (cv * 100)); price.push(b.close); });
  for (let i = n; i < bars.length - 1; i++) {
    const under = bars.slice(i - n + 1, i + 1).every((b, k) => b.close <= vwap[i - n + 1 + k] * (1 - tol));
    if (!under || i - m < 0) continue;
    if ((price[i] / price[i - m] - 1) * 100 > thr) continue;
    const rest = bars.slice(i + 1);
    return { t: bars[i].day.slice(11, 16), price: price[i],
      toClose: (bars.at(-1).close / price[i] - 1) * 100,
      minAfter: (Math.min(...rest.map(b => b.low)) / price[i] - 1) * 100,
      maxAfter: (Math.max(...rest.map(b => b.high)) / price[i] - 1) * 100,
      closePct: (bars.at(-1).close / pc - 1) * 100 };
  }
  return null;
}

function exitReport(bars, pcOf, label) {
  const rows = [];
  for (const [date, list] of Object.entries(byDay(bars))) {
    const pc = pcOf[date];
    if (!pc || list.length < 12) continue;
    const r = exitOf(list, pc);
    if (r) rows.push({ date, ...r });
  }
  console.log(`\n【${label}】触发 ${rows.length} 次 / 样本 ${Object.keys(byDay(bars)).length} 天`);
  if (!rows.length) return rows;
  console.log(`  信号后到收盘 ${fmt(mean(rows.map(r => r.toClose)))}  继续下跌占比 ${ratio(rows, r => r.toClose < 0).toFixed(0)}%`);
  console.log(`  卖出后最大反弹 ${fmt(mean(rows.map(r => r.maxAfter)))}（越大=越可能卖在坑里）  之后最低 ${fmt(mean(rows.map(r => r.minAfter)))}`);
  for (const r of rows) {
    console.log(`    ${r.date} ${r.t} 信号 ${r.price.toFixed(3)} → 收盘 ${fmt(r.toClose)} · 之后最低 ${fmt(r.minAfter)} · 之后最高 ${fmt(r.maxAfter)} · 当日 ${fmt(r.closePct)}`);
  }
  return rows;
}

function dayDetail(em5, m1, pcOf, date) {
  const bars = (byDay(em5)[date] || []);
  if (!bars.length) { console.log(`\n【四】${date} 无 5 分钟数据`); return; }
  const pc = pcOf[date];
  const states = statesOf(bars, pc);
  console.log(`\n【四】${date} 回放（前收 ${pc}，开盘 ${bars[0].open}，收盘 ${bars.at(-1).close}）`);
  let lastWhy = '';
  for (const s of states) {
    const g = gateOf(s);
    if (g.why !== lastWhy) {
      console.log(`  ${s.t}  价格 ${s.price.toFixed(3)}  均价 ${s.vwap.toFixed(3)}  开盘涨幅 ${fmt(s.openPct)}  → ${g.ok ? '允许小仓' : '不能追（' + g.why + '）'}`);
      lastWhy = g.why;
    }
  }
  const one = byDay(m1)[date] || [];
  if (one.length) {
    const r = exitOf(one, pc);
    if (r) console.log(`  1 分钟语义下最早的走弱减仓信号：${r.t} 价格 ${r.price.toFixed(3)} → 收盘 ${fmt(r.toClose)}（之后最低 ${fmt(r.minAfter)}）`);
    else console.log('  1 分钟语义下当日未触发走弱减仓信号');
  }
}

(async () => {
  const data = await load();
  const pcOf = prevCloses();
  console.log(`数据：${data.symbol}  5min ${data.em5.length} 根 / 1min ${data.m1.length} 根  抓取于 ${data.fetchedAt}`);
  gateReport(data.em5, pcOf);
  exitReport(data.em5, pcOf, '二 · 走弱减仓信号（5 分钟粒度，≈42 天）');
  exitReport(data.m1, pcOf, '三 · 走弱减仓信号（1 分钟粒度，近 5 天，更接近线上实盘）');
  dayDetail(data.em5, data.m1, pcOf, dayArg || Object.keys(byDay(data.em5)).at(-1));
})();
