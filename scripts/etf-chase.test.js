const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const context = vm.createContext({});
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

test('高溢价和缺失溢价不限制追涨结构，数值只供参考', () => {
  const points = series(631, 20, () => 2.812, () => 2.808);
  for (const premiumPct of [30, null]) {
    const ctx = ctxOf(points);
    ctx.quote.premiumPct = premiumPct;
    const g = context.buildEtfChaseGate(ctx, points, { kind: 'strong' }, true);
    assert.equal(g.level, 'allow');
    assert.equal(g.metrics.premiumLine, undefined);
    assert.equal(g.metrics.premium, premiumPct);
  }
});

// ── 前端渲染 ──
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
test('闸门卡片渲染 level、理由和仅供参考的溢价', () => {
  const browser = vm.createContext({
    ETF_TRACK: { intradaySignals: { chaseGate: { level: 'block', label: '现在不能追', reason: '今天开盘已高开 +1.92%（超过 0.8%），此刻追入是在替隔夜盘抬轿。', fix: '等回落到分时均价 2.822 附近重新站稳再评估。', asOf: '10:45', metrics: { premium: 38.73 } } } },
    escHtml: v => String(v),
  });
  vm.runInContext(declaration(html, 'etfChaseGateHtml'), browser);
  const out = browser.etfChaseGateHtml();
  assert.match(out, /data-chase-gate="block"/);
  assert.match(out, /不能追/);
  assert.match(out, /高开 \+1\.92%/);
  assert.match(out, /溢价 38\.73%/);
  assert.match(out, /仅供参考，不限制买卖或仓位/);
  assert.doesNotMatch(out, /买入线|不建议加仓/);
});
test('结构允许时高溢价和缺失溢价不在页面另行禁止买入', () => {
  for (const premium of [40, null]) {
    const browser = vm.createContext({
      ETF_TRACK: { intradaySignals: { chaseGate: { level: 'allow', label: '结构允许 · 小仓试', reason: '现价站上均价', metrics: { premium } } } },
      escHtml: String,
    });
    vm.runInContext(declaration(html, 'etfChaseGateHtml'), browser);
    const out = browser.etfChaseGateHtml();
    assert.match(out, /data-chase-gate="allow"/);
    assert.match(out, /可以小仓/);
    assert.match(out, /仅供参考，不限制买卖或仓位/);
    assert.doesNotMatch(out, /买入线|不建议加仓/);
  }
});
test('买点确认仅统计技术过滤，溢价高低和缺失不改变结论', () => {
  for (const premium of [10, 40, null]) {
    const browser = vm.createContext({
      ETF_TRACK: { premium: { current: premium }, advice: { confirm: {
        filters: [{ label: '威廉%R ≤ -60', value: '-70', ok: true }, { label: '价格 < MA21', value: '2.8 vs 2.9', ok: true }],
        hitCount: 2, level: 'good', note: '回调形态命中',
      } } },
    });
    vm.runInContext(declaration(html, 'etfConfirmHtml'), browser);
    const out = browser.etfConfirmHtml();
    assert.match(out, /过滤命中 2\/2/);
    assert.match(out, /溢价（仅参考）/);
    assert.equal((out.match(/class="etf-confirm-item /g) || []).length, 2);
    assert.doesNotMatch(out, /溢价未达标|溢价达标|溢价 ≤/);
  }
});

test('溢价档位和折算价仅供参考，不显示加减仓指令', () => {
  const browser = vm.createContext({
    ETF_TRACK: { quote: { price: 2.8 }, premium: {
      current: 40, rules: { add: 15, buy: 18, watch: 22, danger: 27 }, band: { key: 'exit' },
      prices: { add: { pct: 15, price: 2.3 }, buy: { pct: 18, price: 2.36 }, watch: { pct: 22, price: 2.44 }, cut: { pct: 27, price: 2.54 } },
    } },
  });
  vm.runInContext(declaration(html, 'etfPremiumZonesHtml'), browser);
  const out = browser.etfPremiumZonesHtml();
  assert.match(out, /当前 40\.00%/);
  assert.match(out, /较低溢价参考/);
  assert.match(out, /溢价仅供参考，不限制买卖或仓位/);
  assert.doesNotMatch(out, /加仓价|买入价|减仓价|只减不加|可多买|可买入|需跌/);
});

test('没有闸门数据时不渲染空卡片', () => {
  const browser = vm.createContext({ ETF_TRACK: { intradaySignals: {} }, escHtml: String });
  vm.runInContext(declaration(html, 'etfChaseGateHtml'), browser);
  assert.equal(browser.etfChaseGateHtml(), '');
});
