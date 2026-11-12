const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'))[0];

const context = vm.createContext({ escHtml: v => String(v == null ? '' : v) });
vm.runInContext(['etfFadeStage', 'etfGuardBuild', 'etfGuardBarHtml', 'etfBuyGuardOf']
  .map(n => declaration(html, n)).join('\n'), context);

// 2026-11-12 的真实样本：成本 2.930，当日最高 2.983，收盘前跌到 2.916
const fade = (price, overrides = {}) => context.etfFadeStage({ price, dayHigh: 2.983, cost: 2.93, openPct: 0.95, ...overrides });

test('浮盈回吐：峰值 +1.81% 回吐到 +1.02% 时给出回吐提醒', () => {
  const r = fade(2.960);
  assert.equal(r.stage, 'fade');
  assert.equal(r.level, 'warn');
  assert.ok(Math.abs(r.peakPct - 1.8092) < 1e-3);
  assert.ok(Math.abs(r.nowPct - 1.0239) < 1e-3);
  assert.ok(Math.abs(r.give - 0.785) < 1e-3);
});

test('浮盈回吐：跌回成本下方升级为 danger，不等到全部亏完', () => {
  const r = fade(2.921);
  assert.equal(r.stage, 'cost');
  assert.equal(r.level, 'danger');
  assert.ok(r.nowPct < 0);
});

test('浮盈回吐：峰值浮盈太低时不打扰', () => {
  assert.equal(fade(2.95, { dayHigh: 2.995, cost: 2.99 }).stage, null);
  assert.equal(fade(2.94, { dayHigh: 2.96, cost: 0, openPct: 0.1 }).stage, null);
});

test('未记录持仓时只看高开回落，且要求高开超过 0.3%', () => {
  const r = context.etfFadeStage({ price: 2.94, dayHigh: 2.983, cost: 0, openPct: 0.95 });
  assert.equal(r.stage, 'high');
  assert.ok(Math.abs(r.off - 1.4422) < 1e-3);
  // 平开回落不算「追高风险兑现」
  assert.equal(context.etfFadeStage({ price: 2.94, dayHigh: 2.983, cost: 0, openPct: 0.1 }).stage, null);
  // 回落不足 0.8% 也不提醒
  assert.equal(context.etfFadeStage({ price: 2.960, dayHigh: 2.983, cost: 0, openPct: 0.95 }).stage, null);
});

const broken = { current: { kind: 'broken', label: '破位 · 禁止追涨', time: '10:42', avgGap: -0.42, move4: -0.71, support: 2.963 } };
const weak = { current: { kind: 'weak', label: '偏弱 · 禁止追涨', time: '13:04', avgGap: -0.31, move4: -0.22 } };
const block = { level: 'block', label: '不能追 · 开盘已高开', reason: '开盘涨幅 +0.95%，超过上限 0.8%', asOf: '09:31', fix: '等回落到均价附近再看' };
const base = { date: '2026-11-12', quote: { price: 2.960, quoteTime: '2026-11-12 10:42:00' }, live: true, stale: false };

test('横幅优先级：破位压过追涨拦截，且只有破位进 danger', () => {
  const g = context.etfGuardBuild({ ...base, signals: { strength: broken, chaseGate: block } });
  assert.equal(g.kind, 'broken');
  assert.equal(g.level, 'danger');
  assert.equal(g.key, 'guard-broken-2026-11-12-10:42');
  assert.match(g.title, /破位/);
  assert.match(g.text, /均价偏离 -0.42%/);
});

test('横幅：没有破位时先挂浮盈回吐，再退到「今天不宜追」', () => {
  const warn = { key: 'guard-fade-2026-11-12-fade', level: 'warn', tag: '回吐', kind: 'fade', time: '10:42', title: '浮盈回吐 0.79pp', text: '峰值 +1.81% → 现在 +1.02%' };
  const withFade = context.etfGuardBuild({ ...base, signals: { strength: weak, chaseGate: block }, fade: warn });
  assert.equal(withFade.kind, 'fade');
  const noFade = context.etfGuardBuild({ ...base, signals: { strength: weak, chaseGate: block } });
  assert.equal(noFade.key, 'guard-block-2026-11-12');
  assert.equal(noFade.tag, '不追');
  assert.match(noFade.text, /超过上限 0\.8%/);
});

test('横幅：收盘后不挂，行情延迟时明确标注', () => {
  assert.equal(context.etfGuardBuild({ ...base, live: false, stale: false, signals: { strength: broken, chaseGate: block } }), null);
  const g = context.etfGuardBuild({ ...base, live: false, stale: true, signals: { chaseGate: block } });
  assert.match(g.text, /行情延迟/);
});

test('横幅渲染带 key、级别与关闭按钮，空状态不输出 DOM', () => {
  const g = context.etfGuardBuild({ ...base, signals: { strength: broken, chaseGate: block } });
  const out = context.etfGuardBarHtml(g);
  assert.match(out, /data-guard-key="guard-broken-2026-11-12-10:42"/);
  assert.match(out, /data-guard-kind="broken"/);
  assert.match(out, /class="etf-guard-bar danger"/);
  assert.match(out, /onclick="etfGuardDismiss\(this\)"/);
  assert.equal(context.etfGuardBarHtml(null), '');
});

test('买入拦截：破位与追涨拦截都会挡，未实时或条件不成立时放行', () => {
  const b = context.etfBuyGuardOf({ gate: block, strength: broken, live: true });
  assert.equal(b.kind, 'broken');
  assert.match(b.title, /接飞刀/);
  const onlyBlock = context.etfBuyGuardOf({ gate: block, strength: { current: { kind: 'neutral' } }, live: true });
  assert.equal(onlyBlock.kind, 'block');
  assert.match(onlyBlock.text, /超过上限 0\.8%/);
  assert.equal(context.etfBuyGuardOf({ gate: { level: 'allow' }, strength: { current: { kind: 'strong' } }, live: true }), null);
  assert.equal(context.etfBuyGuardOf({ gate: block, strength: broken, live: false }), null);
  // wait 级（含行情延迟）不拦：延迟只提示，不阻断记账
  assert.equal(context.etfBuyGuardOf({ gate: { level: 'wait' }, strength: { current: { kind: 'weak' } }, live: true }), null);
});

// ── 落 DOM 的一层：横幅挂载、关闭后当天不再出现 ──
function mountContext() {
  const store = new Map();
  const slot = { innerHTML: '', id: 'etf-guard-slot' };
  const inserted = [];
  const doc = {
    getElementById: id => (id === 'etf-guard-slot' ? slot : id === 'app' ? { id: 'app' } : null),
    createElement: () => ({ innerHTML: '', id: '' }),
    body: { insertBefore: (node, ref) => inserted.push(!!ref) },
  };
  const ctx = vm.createContext({
    escHtml: v => String(v == null ? '' : v),
    document: doc,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    todayLocalStr: () => '2026-11-12',
    ETF_LOAD_ERR: null,
    ETF_FADE: { date: '2026-11-12', warn: null },
    ETF_GUARD_DISMISS: { date: '2026-11-12', keys: [] },
    etfTMarket: () => ({ date: '2026-11-12', quote: { price: 2.96, quoteTime: '2026-11-12 10:42:00' }, live: true, stale: false }),
    ETF_TRACK: { intradaySignals: { strength: broken, chaseGate: block } },
  });
  vm.runInContext(`const ETF_GUARD_DISMISS_KEY = 'etf-159509-guard-dismiss';
const ETF_FADE_KEY = 'etf-159509-fade';
` + ['etfFadeStage', 'etfGuardBuild', 'etfGuardBarHtml', 'etfGuardRender', 'etfGuardState',
    'etfGuardIsDismissed', 'etfGuardDismiss'].map(n => declaration(html, n)).join('\n'), ctx);
  return { ctx, slot, store, inserted };
}

test('横幅渲染进 #app 之前的挂载点，关闭后当天不再出现，换条件可再弹', () => {
  const { ctx, slot, store, inserted } = mountContext();
  ctx.etfGuardRender();
  assert.match(slot.innerHTML, /guard-broken-2026-11-12-10:42/);
  assert.deepEqual(inserted, []);   // 页面里已有 #etf-guard-slot，不重复插入
  ctx.etfGuardDismiss({ closest: () => ({ dataset: { guardKey: 'guard-broken-2026-11-12-10:42' } }) });
  assert.equal(slot.innerHTML, '');
  assert.match(store.get('etf-159509-guard-dismiss'), /guard-broken-2026-11-12-10:42/);
  assert.equal(ctx.etfGuardState(), null);
  // 新的破位分钟是新的 key，仍会再弹（不会因为关过一次就整天静音）
  ctx.ETF_TRACK.intradaySignals.strength = { current: { ...broken.current, time: '13:14', kind: 'broken' } };
  ctx.etfGuardRender();
  assert.match(slot.innerHTML, /guard-broken-2026-11-12-13:14/);
});

test('回吐提醒只挂 45 分钟，过期后横幅退回追涨拦截', () => {
  const { ctx, slot } = mountContext();
  const stale = { key: 'guard-fade-2026-11-12-fade', level: 'warn', tag: '回吐', kind: 'fade', time: '10:42',
    title: '浮盈回吐 0.78pp', text: '峰值 +1.81% → 现在 +1.02%', at: Date.now() - 50 * 60_000 };
  ctx.ETF_TRACK.intradaySignals.strength = { current: { kind: 'neutral', time: '10:45' } };
  ctx.ETF_FADE = { date: '2026-11-12', warn: stale };
  ctx.etfGuardRender();
  assert.match(slot.innerHTML, /guard-block-2026-11-12/);   // 过期回吐不再占横幅
  const fresh = { ...stale, at: Date.now() - 5 * 60_000 };
  ctx.ETF_FADE = { date: '2026-11-12', warn: fresh };
  ctx.etfGuardRender();
  assert.match(slot.innerHTML, /guard-fade-2026-11-12-fade/);
});

test('回吐检查每分钟跑，但同一阶段只提醒一次，且当日高点只增不减', () => {
  const fired = [];
  const ctx = vm.createContext({
    ETF_FADE: {},
    ETF_TRACK: { quote: { price: 2.960, high: 2.983, quoteTime: '2026-11-12 10:42:00', open: 2.970, prevClose: 2.942 },
      intraday: { points: [{ t: '09:31', price: 2.968 }, { t: '10:33', price: 2.983 }] } },
    etfTMarket: () => ({ date: '2026-11-12', quote: ctxQuote(), live: true, stale: false }),
    etfPosition: () => ({ shares: 10000, avgCost: 2.93 }),
    etfSaveFade: () => {},
    etfRecordAlert: a => fired.push(a.key),
    etfToast: () => {},
    etfBeep: () => {},
  });
  function ctxQuote() { return ctx.ETF_TRACK.quote; }
  vm.runInContext(['etfFadeStage', 'etfFadeAlert', 'etfFadeCheck', 'etfDayHigh'].map(n => declaration(html, n)).join('\n'), ctx);
  ctx.etfFadeCheck();
  assert.equal(ctx.ETF_FADE.dayHigh, 2.983);
  assert.deepEqual(fired, ['guard-fade-2026-11-12-fade']);
  ctx.etfFadeCheck();   // 同一阶段重复调用不再提醒
  assert.deepEqual(fired, ['guard-fade-2026-11-12-fade']);
  ctx.ETF_TRACK.quote.price = 2.921;   // 跌回成本 → 升级提醒
  ctx.etfFadeCheck();
  assert.deepEqual(fired, ['guard-fade-2026-11-12-fade', 'guard-fade-2026-11-12-cost']);
  assert.equal(ctx.ETF_FADE.dayHigh, 2.983);
  // 行情不实时（收盘/延迟）不再累计
  ctx.ETF_TRACK.quote.price = 2.90;
  ctx.etfTMarket = () => ({ date: '2026-11-12', quote: ctxQuote(), live: false, stale: false });
  assert.equal(ctx.etfFadeCheck(), null);
});
