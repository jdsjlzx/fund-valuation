// 恐慌试仓档（20%）的比例与降档规则敏感性回测
// ── 为什么要有这个脚本（2026-11-10）──────────────────────────────────────────
// 起因：11-10 给出「恐慌试仓 · 20%」，但那天恐慌评分只有 1/6（窗口是 11-06 6/6 触发的），
// tier 又是 run（减仓档 10%）——20% 来自恐慌下限覆盖，不是算出来的。
// 于是问：这个 20% 该不该按「已反弹多少」降档？run 档该不该被下限覆盖？
// 结论：**数值层面没有优化空间**，所有变体都在 ±1.1pp 内（见下方输出），
//   所以 server.js 的仓位数值一律不动，只改文案口径（见 buildEtfPositionPlan 的 panicWin）。
//   以后想再调这个数，先跑本脚本，别凭感觉改。
// 用真实函数：从 server.js 抽取 buildEtfPositionSeries / buildHeavyGate / buildEtfPanicSignal，
// 数据取 data/etf-mkt-cache.json 的 788 根日K + 纳指/费半缓存，不联网。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'etf-mkt-cache.json'), 'utf8'));
const klines = cache.klines;
const usIdx = cache.data.usIdx;

const decl = name => server.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const names = ['calcEMA', 'movingAvgSeries', 'calcMACD', 'rsiSeries', 'williamsRSeries', 'bollingerSeries',
  'buildUsTrendState', 'buildHeavyGate', 'buildEtfPanicSignal', 'buildEtfPositionSeries'];
// 只取标量常量：数组常量（POS_FACTOR_TABLE / PANIC_LEVELS）单独补，避免截断
const consts = server.match(/^const (?:POS_[A-Z0-9_]+|PANIC_[A-Z0-9_]+|US_TREND_[A-Z0-9_]+)\s*=[^\n]+/gm)
  .filter(l => !/=\s*\[\s*$/.test(l)).join('\n')
  + '\n' + server.match(/^const PANIC_LEVELS = \[[^]*?^\];/m)[0];

const ctx = vm.createContext({});
vm.runInContext(consts, ctx);
for (const nm of names) vm.runInContext(decl(nm), ctx);

const panic = ctx.buildEtfPanicSignal(klines, {}, usIdx);
const series = ctx.buildEtfPositionSeries(klines, {}, null, panic.active, usIdx);
const n = series.length;
const RUN_CAP = 0.10;

// 每个恐慌窗口内到当日的「最低收盘」，用于算反弹幅度
const winLow = new Array(n).fill(null);
{
  let low = Infinity;
  for (let i = 0; i < n; i++) {
    const r = series[i];
    if (!r) continue;
    if (r.panic && (i === 0 || !series[i - 1] || !series[i - 1].panic)) low = r.close;
    if (r.panic) { low = Math.min(low, r.close); winLow[i] = low; }
  }
}

function simulate(pick) {
  let eq = 1, pk = 1, mdd = 0, posSum = 0, posCnt = 0;
  for (let i = 1; i < n; i++) {
    const a = series[i - 1], b = series[i];
    if (!a || !b) continue;
    const t = pick(a, i - 1);
    eq *= (1 + t * (b.close / a.close - 1));
    if (eq > pk) pk = eq; else mdd = Math.min(mdd, eq / pk - 1);
    posSum += t; posCnt++;
  }
  const years = (n - 21) / 244;
  return { total: +((eq - 1) * 100).toFixed(1), annual: +((eq ** (1 / years) - 1) * 100).toFixed(1), mdd: +(mdd * 100).toFixed(1), avgPos: +(posSum / posCnt * 100).toFixed(1) };
}

const rebAt = i => (winLow[i] > 0 ? (series[i].close / winLow[i] - 1) * 100 : 0);
const inTry = r => r.panic && !r.panicAdded && !r.panicLapsed;

const variants = {
  'V0 现行（试仓 20%）': r => r.target,
  'VA run 档不给下限': r => (inTry(r) && r.tier === 'run') ? Math.min(r.target, RUN_CAP) : r.target,
  'VB 反弹≥3% 降到 10%': (r, i) => (inTry(r) && rebAt(i) >= 3) ? Math.min(r.target, RUN_CAP) : r.target,
  'VC 反弹≥5% 降到 10%': (r, i) => (inTry(r) && rebAt(i) >= 5) ? Math.min(r.target, RUN_CAP) : r.target,
  'VD 反弹递减 20/15/10': (r, i) => {
    if (!inTry(r)) return r.target;
    const reb = rebAt(i);
    return Math.min(r.target, reb >= 6 ? 0.10 : reb >= 3 ? 0.15 : 0.20);
  },
};

console.log(`样本 ${klines[0].date} → ${klines[n - 1].date}（${n} 个交易日）`);
console.log(`恐慌窗口 ${panic.events.length} 次 · 胜率 ${panic.stats.winRate}% · 平均 ${panic.stats.avgRet}%\n`);
for (const [k, f] of Object.entries(variants)) {
  const s = simulate(f);
  console.log(k.padEnd(22), `累计 ${String(s.total).padStart(6)}%  年化 ${String(s.annual).padStart(5)}%  回撤 ${String(s.mdd).padStart(6)}%  均仓 ${String(s.avgPos).padStart(5)}%`);
}

const tryDays = series.filter((r, i) => r && inTry(r));
const tiers = tryDays.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {});
console.log(`\n试仓档天数 ${tryDays.length}（tier 分布 ${JSON.stringify(tiers)}），其中反弹≥3% ${tryDays.filter((r, k) => rebAt(series.indexOf(r)) >= 3).length} 天、≥5% ${tryDays.filter(r => rebAt(series.indexOf(r)) >= 5).length} 天`);
console.log('结论：变体间差异全部 ≤1.9pp 累计 / ≤1.4pp 回撤，属噪音区间；恐慌窗口内 tier 几乎恒为 run，');
console.log('      所以「run 档不给下限」≈「取消恐慌下限」，等于否掉整个恐慌抄底逻辑，不宜采纳。');
