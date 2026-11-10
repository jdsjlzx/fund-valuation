// 「深档低吸」回测：把低吸挂单价从「现价下方 0.3% 的最高结构位」加深到 0.6%/0.8%/1.0%，
// 并把当日已见低点、昨日低点纳入候选，看看等更低的价到底值不值。
// 口径（无未来函数）：bar i 的价位只用截至 i-1 的数据；bar i 最低价触及挂单价才算成交；
//   持仓时最高价触及高抛参考价按该价卖出，跌破止损按止损价卖出，收盘仍持仓按收盘价平仓；
//   费用双边合计 0.03%。
// 样本：东财 5 分钟 K，159509 + 三只纳指系 ETF 合并，缓存 data/intraday-deep-cache.json（--refresh 重抓）。
const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE = path.join(__dirname, '..', 'data', 'intraday-deep-cache.json');
const SYMBOLS = [
  { secid: '0.159509', name: '纳指科技' },
  { secid: '1.513100', name: '纳指ETF' },
  { secid: '0.159941', name: '纳指100' },
  { secid: '1.513300', name: '纳斯达克100' },
];
const refresh = process.argv.includes('--refresh');
const FEE = 0.0003;
const MIN_SELL_GAP = 0.002;
const WARMUP = 6;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => resolve(s));
    }).on('error', reject);
  });
}
async function fetchEm5(secid) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=5&fqt=0&lmt=6000&end=20500101`
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57';
  const json = JSON.parse(await get(url));
  const rows = json.data && json.data.klines || [];
  return rows.map(line => {
    const [t, o, c, h, l, v, a] = line.split(',');
    return { day: t, open: +o, close: +c, high: +h, low: +l, volume: +v, amount: +a };
  });
}
async function load() {
  if (refresh || !fs.existsSync(CACHE)) {
    const out = {};
    for (const s of SYMBOLS) {
      process.stdout.write(`抓取 ${s.name} ${s.secid}…`);
      out[s.secid] = await fetchEm5(s.secid);
      console.log(` ${out[s.secid].length} 根`);
    }
    fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), data: out }));
  }
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8')).data;
  return SYMBOLS.map(s => ({ ...s, bars: raw[s.secid] || [] })).filter(s => s.bars.length > WARMUP + 4);
}

function cumVwap(bars, upto) {
  let ca = 0, cv = 0;
  for (let k = 0; k <= upto; k++) { ca += bars[k].amount; cv += bars[k].volume; }
  return ca / (cv * 100);
}
function swings(bars, upto) {
  const lo = [], hi = [];
  for (let j = 2; j <= upto - 2; j++) {
    if (bars[j].low <= bars[j - 1].low && bars[j].low <= bars[j - 2].low && bars[j].low <= bars[j + 1].low && bars[j].low <= bars[j + 2].low) lo.push(bars[j].low);
    if (bars[j].high >= bars[j - 1].high && bars[j].high >= bars[j - 2].high && bars[j].high >= bars[j + 1].high && bars[j].high >= bars[j + 2].high) hi.push(bars[j].high);
  }
  return { lo, hi };
}
function buyLevel(bars, day, i, { gap, deep }) {
  const price = bars[i - 1].close;
  const vwap = cumVwap(bars, i - 1), open = bars[0].open;
  const { lo } = swings(bars, i - 1);
  const swingLow = lo.length ? lo.at(-1) : null;
  const cands = [['vwap', vwap], ['open', open], ['pc', day.pc], ['swingLow', swingLow]];
  if (deep) {
    cands.push(['dayLow', Math.min(...bars.slice(0, i).map(b => b.low))], ['prevLow', day.pl]);
  }
  let buy = null, anchor = null;
  for (const [name, c] of cands) {
    if (c != null && c > 0 && price / c - 1 >= gap && (buy == null || c > buy)) { buy = c; anchor = name; }
  }
  return buy == null ? null : { level: buy, anchor };
}
function sellTarget(bars, pc, upto, anchorPx) {
  const vwap = cumVwap(bars, upto), open = bars[0].open;
  const { hi } = swings(bars, upto);
  const swingHigh = hi.length ? hi.at(-1) : null;
  let sell = null;
  for (const c of [vwap, open, pc, swingHigh]) {
    if (c != null && c > 0 && c / anchorPx - 1 >= MIN_SELL_GAP) sell = sell == null ? c : Math.min(sell, c);
  }
  return sell;
}

function simulate(bars, day, { gap, deep, confirm = false, stopPct = null, fixedTarget = null, strongOnly = false }) {
  const out = [];
  let buyAt = null, sellPx = null, stopPx = null;
  const close = bars.at(-1).close;
  for (let i = WARMUP + 1; i < bars.length; i++) {
    if (buyAt == null) {
      const pick = buyLevel(bars, day, i, { gap, deep });
      if (pick == null || bars[i].low > pick.level) continue;
      const level = pick.level;
      if (strongOnly && !(bars[i - 1].close >= day.pc)) continue;
      if (confirm) {
        if (bars[i].close < level) continue;      // 只买收盘站回结构位的那根，不接跌破
        buyAt = bars[i].close;
      } else {
        buyAt = level;
      }
      sellPx = fixedTarget != null ? buyAt * (1 + fixedTarget) : sellTarget(bars, day.pc, i - 1, buyAt);
      stopPx = stopPct == null ? null : buyAt * (1 - stopPct);
      out.anchors = (out.anchors || []).concat(pick.anchor);
      continue;
    }
    if (stopPx != null && bars[i].low <= stopPx) {
      out.push({ t: bars[i].day.slice(11), buy: buyAt, sell: stopPx, ret: stopPx / buyAt - 1 - FEE, kind: 'stop' });
      buyAt = null; continue;
    }
    if (sellPx != null) {
      const s = sellTarget(bars, day.pc, i - 1, buyAt);
      if (s != null && s > sellPx && bars[i - 1].close >= cumVwap(bars, i - 1)) sellPx = s;
    }
    if (sellPx != null && bars[i].high >= sellPx) {
      out.push({ t: bars[i].day.slice(11), buy: buyAt, sell: sellPx, ret: sellPx / buyAt - 1 - FEE, kind: 'target' });
      buyAt = null; continue;
    }
  }
  if (buyAt != null) out.push({ t: '收盘', buy: buyAt, sell: close, ret: close / buyAt - 1 - FEE, kind: 'close' });
  return out;
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length * 100 : NaN;
const sd = a => {
  if (a.length < 2) return NaN;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) * 100;
};

(async () => {
  const symbols = await load();
  // 每标的按日切分，昨收/昨低用同一标的上一交易日推算（首日丢弃）
  const sets = [];
  for (const s of symbols) {
    const byDay = {};
    for (const b of s.bars) { const k = b.day.slice(0, 10); (byDay[k] = byDay[k] || []).push(b); }
    const dates = Object.keys(byDay).sort();
    for (let i = 1; i < dates.length; i++) {
      const bars = byDay[dates[i]];
      if (bars.length < WARMUP + 4) continue;
      const prev = byDay[dates[i - 1]];
      sets.push({ symbol: s.name, date: dates[i], bars, day: { pc: prev.at(-1).close, pl: Math.min(...prev.map(b => b.low)) } });
    }
  }
  const hold = sets.map(s => s.bars.at(-1).close / s.bars[0].open - 1);
  console.log(`样本 ${sets.length} 个交易日 × ${symbols.length} 只 ETF（5 分钟 K，双边费 0.03%）`);
  console.log('拿住不动（开盘买→收盘卖）日均 ' + mean(hold).toFixed(3) + '% · 胜率 ' + (hold.filter(x => x > 0).length / sets.length * 100).toFixed(0) + '%');

  const variants = [
    ['浅档 0.3%（现行上线口径）', { gap: 0.003, deep: false }],
    ['深档 0.6%（只加深，不加候选）', { gap: 0.006, deep: false }],
    ['深档 0.6% + 当日低点/昨低候选', { gap: 0.006, deep: true }],
    ['深档 0.8% + 当日低点/昨低候选', { gap: 0.008, deep: true }],
    ['深档 1.0% + 当日低点/昨低候选', { gap: 0.010, deep: true }],
    ['深档 0.6% + 站回确认', { gap: 0.006, deep: true, confirm: true }],
    ['深档 0.6% + 止损 0.5%', { gap: 0.006, deep: true, stopPct: 0.005 }],
    ['深档 0.6% + 站回确认 + 止损 0.5%', { gap: 0.006, deep: true, confirm: true, stopPct: 0.005 }],
    ['浅档 0.3% + 止损 0.5%', { gap: 0.003, deep: false, stopPct: 0.005 }],
    ['深档 0.6% + 固定 +0.6% 止盈 + 止损 0.4%', { gap: 0.006, deep: true, fixedTarget: 0.006, stopPct: 0.004 }],
    ['浅档 0.3% + 固定 +0.6% 止盈 + 止损 0.4%', { gap: 0.003, deep: false, fixedTarget: 0.006, stopPct: 0.004 }],
    ['深档 0.6% + 强势日（现价≥昨收）+ 止损 0.5%', { gap: 0.006, deep: true, strongOnly: true, stopPct: 0.005 }],
  ];
  console.log('\n| 变体 | 成交笔数 | 有成交天数 | 平均每笔 | 胜率 | 到价 | 止损 | 收盘强平 |');
  console.log('|---|---|---|---|---|---|---|---|');
  const cache = new Map();
  for (const [name, opt] of variants) {
    const all = [];
    let traded = 0;
    for (const s of sets) {
      const rows = simulate(s.bars, s.day, opt).map(x => ({ symbol: s.symbol, date: s.date, ...x }));
      if (rows.length) traded++;
      all.push(...rows);
    }
    cache.set(name, all);
    const rets = all.map(x => x.ret);
    const k = kind => all.filter(x => x.kind === kind);
    const win = rets.length ? (rets.filter(x => x > 0).length / rets.length * 100).toFixed(0) + '%' : '—';
    const seg = kind => k(kind).length ? `${k(kind).length}笔 ${mean(k(kind).map(x => x.ret)).toFixed(2)}%` : '0笔';
    console.log(`| ${name} | ${all.length} | ${traded}/${sets.length} | ${all.length ? mean(rets).toFixed(3) + '%' : '—'} | ${win} | ${seg('target')} | ${seg('stop')} | ${seg('close')} |`);
  }

  const focus = '深档 0.6% + 当日低点/昨低候选';
  const rows = cache.get(focus);
  const rets = rows.map(x => x.ret);
  const se = sd(rets) / Math.sqrt(rets.length);
  console.log(`\n${focus}：${rows.length} 笔 · 平均 ${mean(rets).toFixed(3)}% · 标准差 ${sd(rets).toFixed(2)}% · 95% 区间 ${(mean(rets) - 2 * se).toFixed(2)}% ~ ${(mean(rets) + 2 * se).toFixed(2)}%`);
  for (const s of symbols) {
    const sub = rows.filter(x => x.symbol === s.name).map(x => x.ret);
    if (sub.length) console.log(`  ${s.name} ${sub.length} 笔 · 平均 ${mean(sub).toFixed(3)}% · 胜率 ${(sub.filter(x => x > 0).length / sub.length * 100).toFixed(0)}%`);
  }
  const opt = variants.find(v => v[0] === focus)[1];
  const anchors = {}; const detail = [];
  for (const s of sets) {
    const sim = simulate(s.bars, s.day, opt);
    (sim.anchors || []).forEach(a => { anchors[a] = (anchors[a] || 0) + 1; });
    detail.push(...sim.map(x => ({ ...x, symbol: s.symbol, date: s.date })));
  }
  console.log('  触发结构位：' + Object.entries(anchors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}笔`).join(' · '));
  detail.sort((a, b) => a.ret - b.ret);
  console.log('  最差 5 笔：' + detail.slice(0, 5).map(x => `${x.date} ${x.symbol} 买${x.buy.toFixed(3)} ${(x.ret * 100).toFixed(2)}%`).join(' · '));
  console.log('  最好 5 笔：' + detail.slice(-5).reverse().map(x => `${x.date} ${x.symbol} 买${x.buy.toFixed(3)} ${(x.ret * 100).toFixed(2)}%`).join(' · '));
})();
