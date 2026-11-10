// 高抛低吸参考价回测：结构位锚定（新） vs 滚动最低/均价带（旧） vs 拿住不动
// 数据：data/intraday-study.json 的 em5（159509，41 个交易日 5 分钟 K）
// 规则（无未来函数）：bar t 的价位只用截至 bar t-1 的数据计算；
//   空仓时 bar t 最低价触及低吸价 → 按低吸价成交；持仓时最高价触及高抛价 → 按高抛价成交；
//   收盘仍持仓按收盘价平仓。费用：双边合计 0.03%。
const fs = require('fs');
const path = require('path');
const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'intraday-study.json'), 'utf8'));
const daily = require('../data/etf-mkt-cache.json').klines;
const pcOf = {};
daily.forEach((r, i) => { if (i) pcOf[r.date] = daily[i - 1].close; });

const FEE = 0.0003;
const MIN_BUY_GAP = 0.003;
const MIN_SELL_GAP = 0.002;
const WARMUP = 6;

function cumVwap(bars, upto) { // 截至索引 upto（含）
  let ca = 0, cv = 0;
  for (let k = 0; k <= upto; k++) { ca += bars[k].amount; cv += bars[k].volume; }
  return ca / (cv * 100);
}
function swings(bars, upto) { // 已闭合分形点（j <= upto-2）
  const lo = [], hi = [];
  for (let j = 2; j <= upto - 2; j++) {
    if (bars[j].low <= bars[j - 1].low && bars[j].low <= bars[j - 2].low && bars[j].low <= bars[j + 1].low && bars[j].low <= bars[j + 2].low) lo.push(bars[j].low);
    if (bars[j].high >= bars[j - 1].high && bars[j].high >= bars[j - 2].high && bars[j].high >= bars[j + 1].high && bars[j].high >= bars[j + 2].high) hi.push(bars[j].high);
  }
  return { lo, hi };
}

// ── 新：低吸 = 现价下方≥0.3% 的最高结构位 ──
function buyNew(bars, pc, i) {
  const price = bars[i - 1].close, vwap = cumVwap(bars, i - 1), open = bars[0].open;
  const { lo } = swings(bars, i - 1);
  const swingLow = lo.length ? lo.at(-1) : null;
  let buy = null;
  for (const c of [vwap, open, pc, swingLow]) {
    if (c != null && c > 0 && price / c - 1 >= MIN_BUY_GAP) buy = Math.max(buy || 0, c);
  }
  return buy;
}
// ── 新：高抛 = 成交价上方≥0.2% 的最近阻力 ──
function sellNew(bars, pc, upto, anchorPx) {
  const vwap = cumVwap(bars, upto), open = bars[0].open;
  const { hi } = swings(bars, upto);
  const swingHigh = hi.length ? hi.at(-1) : null;
  let sell = null;
  for (const c of [vwap, open, pc, swingHigh]) {
    if (c != null && c > 0 && c / anchorPx - 1 >= MIN_SELL_GAP) sell = sell == null ? c : Math.min(sell, c);
  }
  return sell;
}
// ── 旧：低吸 = 近30分钟最低*1.003；高抛 = 均价*(1-半宽) ──
function buyOld(bars, pc, i) {
  const recent = bars.slice(Math.max(0, i - 30), i);
  return Math.min(...recent.map(b => b.low)) * 1.003;
}
function sellOld(bars, pc, upto, anchorPx) {
  const recent = bars.slice(Math.max(0, upto - 29), upto + 1);
  let ca = 0, cv = 0;
  for (const b of recent) { ca += b.amount; cv += b.volume; }
  const vwap = ca / (cv * 100);
  const low = Math.min(...recent.map(b => b.low));
  const range = (Math.max(...recent.map(b => b.high)) / low - 1) * 100;
  const hw = Math.max(0.15, Math.min(0.6, range * 0.25)) / 100;
  const s = vwap * (1 - hw);
  return s / anchorPx - 1 >= MIN_SELL_GAP ? s : null;
}

function simulate(bars, pc, buyFn, sellFn, trailingSell) {
  const detail = [];
  let buyAt = null, sellPx = null;
  const close = bars.at(-1).close;
  for (let i = WARMUP + 1; i < bars.length; i++) {
    if (buyAt == null) {
      const buy = buyFn(bars, pc, i);
      if (buy != null && bars[i].low <= buy) {
        buyAt = buy;
        sellPx = sellFn(bars, pc, i - 1, buy);   // 成交瞬间用截至 i-1 的数据定锚
        if (sellPx != null && bars[i].high >= sellPx) {  // 同一根bar既触及买又触及卖（罕见，按卖出）
          detail.push({ t: bars[i].day.slice(11), buy: buyAt, sell: sellPx, ret: sellPx / buyAt - 1 - FEE, kind: 'target' });
          buyAt = null; sellPx = null;
        }
      }
    } else {
      if (trailingSell) {
        const s = sellFn(bars, pc, i - 1, buyAt);
        if (s != null && (sellPx == null || s > sellPx)) sellPx = s;  // 只允许上移，防追低卖出
      }
      if (sellPx != null && bars[i].high >= sellPx) {
        detail.push({ t: bars[i].day.slice(11), buy: buyAt, sell: sellPx, ret: sellPx / buyAt - 1 - FEE, kind: 'target' });
        buyAt = null; sellPx = null;
      }
    }
  }
  if (buyAt != null) detail.push({ t: '收盘', buy: buyAt, sell: close, ret: close / buyAt - 1 - FEE, kind: 'close' });
  return detail;
}

const days = {};
for (const b of d.em5) { const k = b.day.slice(0, 10); (days[k] = days[k] || []).push(b); }
const cfgs = [
  ['新 · 固定锚（成交时定价）', buyNew, sellNew, false],
  ['新 · 锚随行情上移', buyNew, sellNew, true],
  ['旧 · 滚动最低/均价带', buyOld, sellOld, true],
];
const hold = [];
for (const [date, bars] of Object.entries(days)) {
  const pc = pcOf[date];
  if (pc && bars.length >= WARMUP + 4) hold.push(bars.at(-1).close / bars[0].open - 1);
}
console.log('拿住不动（开盘买→收盘卖，日均值）：' + (hold.reduce((x, y) => x + y, 0) / hold.length * 100).toFixed(3) + '% · 胜率 ' + (hold.filter(x => x > 0).length / hold.length * 100).toFixed(0) + '%');
for (const [name, bf, sf, tr] of cfgs) {
  const all = [];
  for (const [date, bars] of Object.entries(days)) {
    const pc = pcOf[date];
    if (!pc || bars.length < WARMUP + 4) continue;
    all.push(...simulate(bars, pc, bf, sf, tr).map(x => ({ date, ...x })));
  }
  const rets = all.map(x => x.ret);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length * 100;
  const byKind = k => all.filter(x => x.kind === k);
  console.log(`\n【${name}】配对 ${all.length} 笔 · 日均贡献 ${mean(rets).toFixed(3)}% · 胜率 ${(rets.filter(x => x > 0).length / rets.length * 100).toFixed(0)}% · 到价平仓 ${byKind('target').length} 笔均 ${mean(byKind('target').map(x => x.ret)).toFixed(3)}% · 收盘强平 ${byKind('close').length} 笔均 ${mean(byKind('close').map(x => x.ret)).toFixed(3)}%`);
  for (const x of all.filter(x => x.kind === 'close').slice(0, 8)) console.log(`   强平 ${x.date} ${x.t} 买 ${x.buy.toFixed(3)} → 收 ${x.sell.toFixed(3)} ${(x.ret * 100).toFixed(2)}%`);
}

// ── 变体：带止损/确认的完整做T（买入=触结构位后确认，卖出=阻力锚+止损） ──
function simulateV(bars, pc, { stopPct = 0.005 } = {}) {
  const detail = [];
  let buyAt = null, sellPx = null, stopPx = null;
  const close = bars.at(-1).close;
  for (let i = WARMUP + 1; i < bars.length; i++) {
    const vwapNow = cumVwap(bars, i - 1);
    if (buyAt == null) {
      const buy = buyNew(bars, pc, i);
      if (buy == null) continue;
      if (bars[i].low <= buy && bars[i].close >= buy) {
        buyAt = bars[i].close;
        sellPx = sellNew(bars, pc, i, buyAt);
        stopPx = buyAt * (1 - stopPct);
      }
      continue;
    }
    if (bars[i].low <= stopPx) { detail.push({ t: bars[i].day.slice(11), buy: buyAt, sell: stopPx, ret: stopPx / buyAt - 1 - FEE, kind: 'stop' }); buyAt = null; continue; }
    if (sellPx != null && bars[i].high >= sellPx) { detail.push({ t: bars[i].day.slice(11), buy: buyAt, sell: sellPx, ret: sellPx / buyAt - 1 - FEE, kind: 'target' }); buyAt = null; continue; }
    if (bars[i].close >= vwapNow) { const s = sellNew(bars, pc, i, buyAt); if (s != null && (sellPx == null || s > sellPx)) sellPx = s; }
  }
  if (buyAt != null) detail.push({ t: '收盘', buy: buyAt, sell: close, ret: close / buyAt - 1 - FEE, kind: 'close' });
  return detail;
}

console.log('\n──── 带风控变体（触结构位且回升确认买入；卖出=阻力锚+止损）────');
const variants = [
  ['A 止损0.5%', { stopPct: 0.005 }],
  ['B 止损0.3%', { stopPct: 0.003 }],
  ['C 止损0.7%', { stopPct: 0.007 }],
  ['D 止损1.0%', { stopPct: 0.010 }],
];
for (const [name, opt] of variants) {
  const all = [];
  for (const [date, bars] of Object.entries(days)) {
    const pc = pcOf[date]; if (!pc || bars.length < WARMUP + 4) continue;
    all.push(...simulateV(bars, pc, opt).map(x => ({ date, ...x })));
  }
  const rets = all.map(x => x.ret);
  const kind = k => all.filter(x => x.kind === k);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length * 100 : NaN;
  console.log(`【${name}】配对 ${all.length} 笔 · 日均贡献 ${mean(rets).toFixed(3)}% · 胜率 ${(rets.filter(x => x > 0).length / rets.length * 100).toFixed(0)}% · 到价 ${kind('target').length}笔均${mean(kind('target').map(x => x.ret)).toFixed(2)}% · 止损 ${kind('stop').length}笔均${mean(kind('stop').map(x => x.ret)).toFixed(2)}% · 强平 ${kind('close').length}笔均${mean(kind('close').map(x => x.ret)).toFixed(2)}%`);
}

// ── 变体 E/F/G：强势日过滤 + 不同卖出方式 ──
function simulateW(bars, pc, { stopPct = 0.005, targetMode = 'anchor', strongOnly = true } = {}) {
  const detail = [];
  let buyAt = null, sellPx = null, stopPx = null;
  const close = bars.at(-1).close;
  for (let i = WARMUP + 1; i < bars.length; i++) {
    const vwapNow = cumVwap(bars, i - 1);
    if (buyAt == null) {
      const buy = buyNew(bars, pc, i);
      if (buy == null) continue;
      const strong = !strongOnly || bars[i - 1].close >= pc;
      if (strong && bars[i].low <= buy && bars[i].close >= buy) {
        buyAt = bars[i].close;
        if (targetMode === 'fixed') { sellPx = buyAt * 1.005; }
        else { sellPx = sellNew(bars, pc, i, buyAt); if (sellPx == null) sellPx = buyAt * 1.006; }
        stopPx = buyAt * (1 - stopPct);
      }
      continue;
    }
    if (bars[i].low <= stopPx) { detail.push({ t: bars[i].day.slice(11), buy: buyAt, sell: stopPx, ret: stopPx / buyAt - 1 - FEE, kind: 'stop' }); buyAt = null; continue; }
    if (sellPx != null && bars[i].high >= sellPx) { detail.push({ t: bars[i].day.slice(11), buy: buyAt, sell: sellPx, ret: sellPx / buyAt - 1 - FEE, kind: 'target' }); buyAt = null; continue; }
    if (targetMode === 'anchor' && bars[i].close >= vwapNow) { const s = sellNew(bars, pc, i, buyAt); if (s != null && (sellPx == null || s > sellPx)) sellPx = s; }
  }
  if (buyAt != null) detail.push({ t: '收盘', buy: buyAt, sell: close, ret: close / buyAt - 1 - FEE, kind: 'close' });
  return detail;
}
console.log('\n──── 强势日过滤变体（仅现价>昨收时低吸）────');
const wv = [
  ['E 强势日+阻力锚+止损0.5%', { targetMode: 'anchor' }],
  ['F 强势日+固定+0.5%目标+止损0.5%', { targetMode: 'fixed' }],
  ['G 旧结构+强势日+止损0.5%', { targetMode: 'fixed' }],
];
for (const [name, opt] of wv) {
  const all = [];
  for (const [date, bars] of Object.entries(days)) {
    const pc = pcOf[date]; if (!pc || bars.length < WARMUP + 4) continue;
    all.push(...simulateW(bars, pc, opt).map(x => ({ date, ...x })));
  }
  const rets = all.map(x => x.ret);
  const kind = k => all.filter(x => x.kind === k);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length * 100 : NaN;
  console.log(`【${name}】配对 ${all.length} 笔 · 日均贡献 ${mean(rets).toFixed(3)}% · 胜率 ${(rets.filter(x => x > 0).length / rets.length * 100).toFixed(0)}% · 到价 ${kind('target').length}笔均${mean(kind('target').map(x => x.ret)).toFixed(2)}% · 止损 ${kind('stop').length}笔均${mean(kind('stop').map(x => x.ret)).toFixed(2)}% · 强平 ${kind('close').length}笔均${mean(kind('close').map(x => x.ret)).toFixed(2)}%`);
}
