// QQQ 250 日均线位置与「跌破后」历史表现，用于定投/低吸决策
// 数据：Yahoo Finance chart API 日线（20 年，含 2008 金融危机）
// 用法：node scripts/qqq-ma250-study.js            （读缓存）
//       node scripts/qqq-ma250-study.js --refresh  （重抓）
const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE = path.join(__dirname, '..', 'data', 'qqq-daily.json');

const get = url => new Promise((res, rej) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
    let s = ''; r.on('data', d => s += d); r.on('end', () => res(s));
  }).on('error', rej);
});

async function load(refresh) {
  if (!refresh && fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - Date.parse(c.fetchedAt) < 12 * 3600 * 1000) return c.bars;
    if (!refresh) return c.bars;
  }
  const txt = await get('https://query1.finance.yahoo.com/v8/finance/chart/QQQ?range=20y&interval=1d');
  const r = JSON.parse(txt).chart.result[0];
  const q = r.indicators.quote[0];
  const bars = r.timestamp.map((t, i) => ({
    d: new Date(t * 1000).toISOString().slice(0, 10),
    c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume[i],
  })).filter(b => b.c != null);
  fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), bars }));
  return bars;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (x, y) => (y / x - 1) * 100;
const sma = (bars, i, n) => i + 1 < n ? null : mean(bars.slice(i - n + 1, i + 1).map(b => b.c));
function rsi(bars, i, n = 14) {
  if (i < n) return null;
  let up = 0, dn = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const ch = bars[k].c - bars[k - 1].c;
    if (ch > 0) up += ch; else dn -= ch;
  }
  if (dn === 0) return 100;
  const rs = (up / n) / (dn / n);
  return 100 - 100 / (1 + rs);
}

(async () => {
  const bars = await load(process.argv.includes('--refresh'));
  const n = bars.length;
  const last = bars[n - 1];
  const lastDate = last.d;

  const ma50 = sma(bars, n - 1, 50), ma150 = sma(bars, n - 1, 150);
  const ma200 = sma(bars, n - 1, 200), ma250 = sma(bars, n - 1, 250);
  const hiAll = Math.max(...bars.map(b => b.h));
  const hiIdx = bars.findIndex(b => b.h === hiAll);

  const f2 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const px = v => v.toFixed(2);

  console.log('=== QQQ 当前位置（数据截至 ' + lastDate + ' 收盘，来源 Yahoo Finance）===');
  console.log('收盘        ', px(last.c));
  console.log('MA50        ', px(ma50), ' 偏离', f2(pct(ma50, last.c)));
  console.log('MA150       ', px(ma150), ' 偏离', f2(pct(ma150, last.c)));
  console.log('MA200       ', px(ma200), ' 偏离', f2(pct(ma200, last.c)));
  console.log('MA250       ', px(ma250), ' 偏离', f2(pct(ma250, last.c)));
  console.log('历史最高    ', px(hiAll), '(' + bars[hiIdx].d + ')  当前回撤', f2(pct(hiAll, last.c)));
  console.log('RSI(14)     ', rsi(bars, n - 1).toFixed(1));
  console.log('样本区间    ', bars[0].d, '→', lastDate, n, '个交易日');

  // 距上次跌破 MA250：当前是否已经跌破
  const below250 = last.c < ma250;
  console.log('当前状态    ', below250 ? '已跌破 MA250' : 'MA250 上方');

  // ── 历史事件：从 MA250 上方转为下方（首次跌破，3 个月内不重复计）──
  const events = [];
  let lastEv = -999;
  for (let i = 251; i < n - 1; i++) {
    const m = sma(bars, i, 250), pm = sma(bars, i - 1, 250);
    if (m == null || pm == null) continue;
    const cross = bars[i - 1].c >= pm && bars[i].c < m;
    if (!cross || i - lastEv < 63) continue;
    lastEv = i;
    const m200 = sma(bars, i, 200);
    const hiBefore = Math.max(...bars.slice(Math.max(0, i - 250), i + 1).map(b => b.h));
    const row = {
      d: bars[i].d, px: bars[i].c,
      dd: pct(hiBefore, bars[i].c),
      below200: m200 != null && bars[i].c < m200,
    };
    for (const [k, w] of [['m1', 21], ['m3', 63], ['m6', 126], ['m12', 252]]) {
      const j = i + w;
      row[k] = j < n ? pct(bars[i].c, bars[j].c) : null;
    }
    // 事件后一年内的最大回撤（相对跌破日）+ 到最低点用了多少个交易日
    const win = bars.slice(i + 1, Math.min(n, i + 253));
    if (win.length) {
      let lo = Infinity, loAt = 0;
      win.forEach((b, k) => { if (b.l < lo) { lo = b.l; loAt = k; } });
      row.maxDD = pct(bars[i].c, lo);
      row.daysToLow = loAt + 1;
      row.recoveredInWin = win.some(b => b.c >= bars[i].c);
    } else {
      row.maxDD = null; row.daysToLow = null;
    }
    events.push(row);
  }

  console.log('\n=== 历史上每次「跌破 MA250」之后 ===');
  console.log('跌破日      价位      距前高    同时破200日线   3月      6月      12月    一年内最大回撤');
  for (const e of events) {
    console.log(
      e.d.padEnd(12),
      px(e.px).padStart(8),
      (e.dd.toFixed(1) + '%').padStart(8),
      (e.below200 ? '是' : '否').padStart(8),
      (e.m3 == null ? '—' : f2(e.m3)).padStart(9),
      (e.m6 == null ? '—' : f2(e.m6)).padStart(9),
      (e.m12 == null ? '—' : f2(e.m12)).padStart(9),
      (e.maxDD == null ? '—' : f2(e.maxDD)).padStart(13)
    );
  }

  const col = k => events.map(e => e[k]).filter(v => v != null);
  const stat = (arr) => {
    if (!arr.length) return '—';
    const win = arr.filter(v => v > 0).length / arr.length * 100;
    return `均值 ${f2(mean(arr))}  中位 ${f2([...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)])}  胜率 ${win.toFixed(0)}%  (n=${arr.length})`;
  };
  console.log('\n汇总（全部跌破事件）');
  console.log(' 1 个月  ', stat(col('m1')));
  console.log(' 3 个月  ', stat(col('m3')));
  console.log(' 6 个月  ', stat(col('m6')));
  console.log(' 12 个月 ', stat(col('m12')));
  console.log(' 一年内最大回撤 ', stat(col('maxDD')));
  const d2l = events.map(e => e.daysToLow).filter(v => v != null).sort((a, b) => a - b);
  console.log(' 到一年内最低点用了多少个交易日：中位', d2l[Math.floor(d2l.length / 2)], '平均', Math.round(mean(d2l)),
    '（其中 1 个月内见底的', d2l.filter(v => v <= 21).length + '/' + d2l.length, '个）');
  console.log(' 跌破后一年内曾回到跌破日价位上方：', events.filter(e => e.recoveredInWin).length + '/' + events.length, '次');

  const deep = events.filter(e => e.dd <= -15);
  const shallow = events.filter(e => e.dd > -15);
  console.log('\n按「跌破时距前高的回撤幅度」分组');
  console.log(' 回撤 ≤ -15%（跌深了才破） n=' + deep.length, ' 12月', stat(deep.map(e => e.m12).filter(v => v != null)));
  console.log(' 回撤 > -15%（高位刚破）   n=' + shallow.length, ' 12月', stat(shallow.map(e => e.m12).filter(v => v != null)));
  console.log(' 其中同时跌破 200 日线     n=' + events.filter(e => e.below200).length,
    ' 12月', stat(events.filter(e => e.below200).map(e => e.m12).filter(v => v != null)));

  // ── 定投模拟：每月首个交易日投 1 份；跌破 MA250 时投 2 倍 ──
  function dca(mult) {
    let units = 0, invested = 0, lastMonth = '';
    for (let i = 250; i < n; i++) {
      const m = bars[i].d.slice(0, 7);
      if (m === lastMonth) continue;
      lastMonth = m;
      const m250 = sma(bars, i, 250);
      if (m250 == null) continue;
      const k = (mult && bars[i].c < m250) ? 2 : 1;
      units += k; invested += k * bars[i].c;
    }
    return { units, invested, value: units * last.c, mult };
  }
  const base = dca(false), boost = dca(true);
  console.log('\n=== 定投模拟（' + bars[250].d + ' 起，每月首个交易日买入，持有到 ' + lastDate + '）===');
  console.log('固定定投     投入成本 ' + px(base.invested) + '  期末市值 ' + px(base.value) + '  收益 ' + f2(pct(base.invested, base.value)));
  console.log('跌破MA250加倍 投入成本 ' + px(boost.invested) + '  期末市值 ' + px(boost.value) + '  收益 ' + f2(pct(boost.invested, boost.value)));
  console.log('（收益为累计投入的口径，非年化；两种方案投入总额不同，只比收益率）');
})();
