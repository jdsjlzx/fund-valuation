const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const context = vm.createContext({ PREMIUM_BUY: 18 });
vm.runInContext(['etfMinuteNumber', 'buildEtfChaseGate'].map(n => declaration(server, n)).join('\n'), context);

const pt = (t, price, avg) => ({ t, price, avg, volume: 100 });
// 造一段从 10:31 开始、连续 n 分钟的序列，价格/均价由回调决定
function series(startMin, n, priceFn, avgFn) {
  return Array.from({ length: n }, (_, i) => {
    const m = startMin + i;
    const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return pt(t, priceFn(i), avgFn(i));
  });
}
const ctxOf = (points, over = {}) => ({
  quote: { open: points[0].price, prevClose: 2.8, price: points.at(-1).price, premiumPct: 30, ...over.quote },
  positionPlan: { tier: 'try' }, ...over,
});

test('高开超过 0.8% 直接判定不能追，并给出回踩价位', () => {
  // 今天 159509 的形态：开盘 2.867（前收 2.813，高开 1.92%），随后一路下
  const points = series(631, 20, i => 2.867 - i * 0.003, () => 2.85);
  const g = context.buildEtfChaseGate(ctxOf(points, { quote: { prevClose: 2.813 } }), points, { kind: 'weak' }, true);
  assert.equal(g.level, 'block');
  assert.match(g.reason, /高开 \+1\.92%/);
  assert.match(g.fix, /分时均价/);
  assert.equal(g.metrics.openPct.toFixed(2), '1.92');
});

test('价格跌破分时均价时不给追，即使没有高开', () => {
  const points = series(631, 20, () => 2.795, () => 2.81);
  const g = context.buildEtfChaseGate(ctxOf(points), points, { kind: 'neutral' }, true);
  assert.equal(g.level, 'block');
  assert.match(g.reason, /低于分时均价/);
});

test('站上均价但偏离超过 0.6% 时不追', () => {
  const points = series(631, 20, () => 2.83, () => 2.81);
  const g = context.buildEtfChaseGate(ctxOf(points, { quote: { prevClose: 2.829, premiumPct: 10 } }), points, { kind: 'strong' }, true);
  assert.equal(g.level, 'block');
  assert.match(g.reason, /高出分时均价 0\.71%/);
});

test('开盘不足 15 分钟只给观察，不下追的结论', () => {
  const points = series(631, 8, () => 2.815, () => 2.81);
  const g = context.buildEtfChaseGate(ctxOf(points), points, { kind: 'neutral' }, true);
  assert.equal(g.level, 'wait');
  assert.match(g.reason, /开盘才 7 分钟/);
});

test('高开不大、站上均价、偏离有限时才允许小仓', () => {
  const points = series(631, 20, () => 2.812, () => 2.808);
  const g = context.buildEtfChaseGate(ctxOf(points, { quote: { prevClose: 2.805, premiumPct: 10 } }), points, { kind: 'strong' }, true);
  assert.equal(g.level, 'allow');
  assert.match(g.label, /小仓/);
  assert.match(g.fix, /跌破分时均价/);
});

test('14:30 后一律禁止新增仓位', () => {
  const points = series(870, 10, () => 2.812, () => 2.808);
  const g = context.buildEtfChaseGate(ctxOf(points), points, { kind: 'strong' }, true);
  assert.equal(g.level, 'block');
  assert.match(g.reason, /14:30/);
});

test('非实时状态只给回看结论，不产生当前指令', () => {
  const points = series(631, 20, () => 2.812, () => 2.808);
  const g = context.buildEtfChaseGate(ctxOf(points), points, { kind: 'strong' }, false);
  assert.equal(g.level, 'closed');
  assert.match(g.fix, /不构成当前指令/);
});
test('收盘复盘：全天高开超限时明确说没有可追时点', () => {
  const points = series(631, 20, () => 2.867, p => 2.86);
  const ctx = { ...ctxOf(points), quote: { ...ctxOf(points).quote, open: 2.867, prevClose: 2.813 } };
  const g = context.buildEtfChaseGate(ctx, points, { kind: 'weak' }, false);
  assert.equal(g.level, 'closed');
  assert.match(g.label, /不该追/);
  assert.match(g.reason, /高开 \+1\.92%/);
});

test('溢价线随服务端常量下发，供前端单独警示', () => {
  const points = series(631, 20, () => 2.812, () => 2.808);
  const g = context.buildEtfChaseGate(ctxOf(points), points, { kind: 'strong' }, true);
  assert.equal(g.metrics.premiumLine, 18);
  assert.equal(g.metrics.premium, 30);
});

// ── 前端渲染：结论要摆到分时图正上方，溢价另起一行警示 ──
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
test('闸门卡片渲染 level、理由和溢价警示', () => {
  const browser = vm.createContext({
    ETF_TRACK: { intradaySignals: { chaseGate: { level: 'block', label: '现在不能追', reason: '今天开盘已高开 +1.92%（超过 0.8%），此刻追入是在替隔夜盘抬轿。', fix: '等回落到分时均价 2.822 附近重新站稳再评估。', asOf: '10:45', metrics: { premium: 38.73, premiumLine: 18 } } } },
    escHtml: v => String(v),
  });
  vm.runInContext(declaration(html, 'etfChaseGateHtml'), browser);
  const out = browser.etfChaseGateHtml();
  assert.match(out, /data-chase-gate="block"/);
  assert.match(out, /不能追/);
  assert.match(out, /高开 \+1\.92%/);
  assert.match(out, /溢价 38\.73%/);
});
test('没有闸门数据时不渲染空卡片', () => {
  const browser = vm.createContext({ ETF_TRACK: { intradaySignals: {} }, escHtml: String });
  vm.runInContext(declaration(html, 'etfChaseGateHtml'), browser);
  assert.equal(browser.etfChaseGateHtml(), '');
});
