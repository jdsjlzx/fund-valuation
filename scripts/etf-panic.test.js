const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const constants = server.match(/^const (?:PANIC_(?!LEVELS)|POS_PANIC_|POS_TRY_|PREMIUM_BUY|PREMIUM_WATCH)[^\n]+/gm).join('\n');
const levels = server.match(/^const PANIC_LEVELS = \[[^]*?^\];/m)[0];

function fixture({ external = true, stress = false, oversold = false, premium = 40, missing = false } = {}) {
  const klines = Array.from({ length: 60 }, (_, i) => {
    const close = stress && i >= 55 ? 104 - (i - 54) * 2 : 100 + i * 0.1;
    return { date: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10), close, high: close + 1, low: close - 1 };
  });
  const nav = Object.fromEntries(klines.map(k => [k.date, k.close / (1 + premium / 100)]));
  const dates = klines.map(k => k.date);
  const us = missing ? null : {
    ixic: { dates, ret: Object.fromEntries(dates.map(d => [d, 1.44])), ret5: Object.fromEntries(dates.map(d => [d, -3.06])) },
    sox: { ret: Object.fromEntries(dates.map(d => [d, external ? -3.13 : 1])) },
  };
  const context = vm.createContext({
    movingAvgSeries: closes => closes.map(() => 100),
    rsiSeries: closes => closes.map(() => oversold ? 30 : 45),
    williamsRSeries: (highs, lows, closes) => closes.map(() => oversold ? -98 : -70),
    bollingerSeries: closes => ({ up: closes.map(c => c + (oversold ? 19 : 8)), dn: closes.map(c => c - (oversold ? 1 : 2)) }),
  });
  vm.runInContext(constants + '\n' + levels + '\n' + declaration(server, 'buildEtfPanicSignal'), context);
  const result = context.buildEtfPanicSignal(klines, nav, us);
  return { result, klines, context };
}

function render(result, premium, plan = { panic: false, posPct: 10, action: '防守仓', headline: '等待确认' }) {
  const context = vm.createContext({ ETF_TRACK: { panicSignal: result, quote: { premiumPct: premium, quoteDate: '2026-11-05' }, positionPlan: plan } });
  vm.runInContext(declaration(html, 'etfPanicHtml'), context);
  return context.etfPanicHtml();
}

test('外盘恐慌独立预警，不要求ETF超卖或低溢价', () => {
  const { result } = fixture();
  assert.equal(result.current.warning.level, '外盘恐慌预警');
  assert.equal(result.current.warning.active, true);
  assert.equal(result.current.score, 1);
  assert.equal(result.active.size, 0);
  assert.equal(result.current.warning.checks.length, 3);
});

test('外盘与ETF急跌共振，高溢价仍不隐藏预警', () => {
  const { result } = fixture({ stress: true });
  assert.equal(result.current.warning.level, '恐慌共振预警');
  assert.equal(result.current.warning.tone, 'hot');
  assert.equal(result.current.score, 3);
  assert.equal(result.active.size, 0);
  const output = render(result, 39.6);
  assert.match(output, /市场恐慌预警/);
  assert.match(output, /ETF 买入信号/);
  assert.match(output, /高溢价 · 暂停买入/);
  assert.match(output, /39\.60%/);
});

test('ETF自身回撤在无外盘恐慌时也预警', () => {
  const { result } = fixture({ stress: true, external: false });
  assert.equal(result.current.warning.level, 'ETF 回撤预警');
  assert.equal(result.current.warning.active, true);
});

test('正常市场不因低溢价而触发恐慌预警', () => {
  const { result } = fixture({ external: false, premium: 10 });
  assert.equal(result.current.warning.active, false);
  assert.equal(result.current.warning.level, '未见明显恐慌');
  assert.equal(result.active.size, 0);
});

test('外盘缺失明确标注，ETF急跌仍可单独预警', () => {
  const calm = fixture({ missing: true }).result;
  assert.equal(calm.current.warning.level, '外盘数据缺失');
  assert.match(render(calm, 40), /不能排除外盘恐慌/);
  const stressed = fixture({ stress: true, missing: true }).result;
  assert.equal(stressed.current.warning.level, 'ETF 回撤预警');
});

test('4分只是候选买点，不开启原有5分窗口', () => {
  const { result } = fixture({ external: false, oversold: true, premium: 10 });
  assert.equal(result.current.score, 4);
  assert.equal(result.active.size, 0);
  assert.match(render(result, 10), /接近买点 · 仅关注/);
  assert.match(render(result, 10), /不自动试仓或加仓/);
});

test('达到原有5分门槛后仍按实际仓位而非固定65%执行', () => {
  const { result } = fixture({ oversold: true, premium: 10 });
  assert.equal(result.current.score, 5);
  assert.ok(result.active.size > 0);
  const output = render(result, 10, { panic: true, posPct: 35, action: '恐慌试仓 · 35%', headline: '未站回MA21' });
  assert.match(output, /窗口中 · 按仓位执行/);
  assert.match(output, /恐慌试仓 · 35%/);
  assert.doesNotMatch(output, /触发后仓位下限抬到/);
});

test('即使窗口已触发，高溢价或未知溢价仍阻止买入提示', () => {
  const { result } = fixture({ stress: true, oversold: true });
  assert.equal(result.current.score, 6);
  const plan = { panic: true, posPct: 5, action: '防守', headline: '高溢价' };
  assert.match(render(result, 40, plan), /高溢价 · 暂停买入/);
  assert.match(render(result, null, plan), /溢价待确认/);
  assert.doesNotMatch(render(result, null, plan), /窗口中 · 按仓位执行/);
});

test('22%溢价边界与已失效窗口仍按实际防守仓位展示', () => {
  const { result } = fixture({ oversold: true, premium: 10 });
  const plan = { panic: true, posPct: 20, action: '抄底未确认 · 撤回 20%', headline: '10天未确认，撤回防守' };
  assert.match(render(result, 22, plan), /抄底未确认 · 撤回 20%/);
  assert.doesNotMatch(render(result, 22, plan), /高溢价 · 暂停买入/);
  assert.match(render(result, 22.01, plan), /高溢价 · 暂停买入/);
});

test('最新外盘预览达标不冒充已开启的交易窗口', () => {
  const { result } = fixture({ oversold: true, premium: 10 });
  const output = render(result, 10);
  assert.match(output, /共振达标 · 等窗口确认/);
  assert.match(output, /最新外盘预览不自动开启/);
  assert.match(output, /非 ETF 盘中实时评分/);
});

test('旧接口明确提示更新后端，而不是无限等待刷新', () => {
  const { result } = fixture();
  delete result.current.warning;
  const output = render(result, 40);
  assert.match(output, /后端已更新并重启/);
  assert.match(output, /仅刷新页面无法更新旧服务/);
  assert.doesNotMatch(output, /数据更新中|等待行情刷新/);
  assert.doesNotMatch(output, /NaN|undefined|65%/);
});

test('渲染转义数据中的HTML', () => {
  const { result } = fixture();
  result.current.warning.level = '<script>bad()</script>';
  assert.match(render(result, 40), /&lt;script&gt;/);
  assert.doesNotMatch(render(result, 40), /<script>/);
});
