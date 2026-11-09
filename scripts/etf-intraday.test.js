const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'))[0];
const names = ['etfMinuteNumber', 'isEtfContinuousMinute', 'parseEtfMinuteData', 'getBasePrevClose', 'premarketMode', 'unpricedUsMove', 'buildPremarketPlan', 'buildEtfIntradayBands', 'buildEtfIntradayGuide', 'buildEtfIntradaySignals', 'buildEtfAlerts'];
const context = vm.createContext({ PREMIUM_BUY: 18, PREMIUM_WATCH: 22, PREMIUM_ADD: 15, PREMIUM_DANGER: 27,
  premiumZone: () => ({ key: 'exit', label: '极高' }), premiumPriceLadder: () => null,
  buildPremarketHistoryReview: () => null });
vm.runInContext(names.map(n => declaration(server, n)).join('\n'), context);
const plain = value => JSON.parse(JSON.stringify(value));
const point = (t, price, avg = 2.95) => ({ t, price, avg, volume: 100 });
function input(points, overrides = {}) {
  const last = points[points.length - 1];
  return { today: '2026-11-05', quote: { quoteDate: '2026-11-05', quoteTime: `2026-11-05 ${last.t.slice(0, 3)}${String(Number(last.t.slice(3)) + 1).padStart(2, '0')}`, price: last.price, prevClose: 2.98, premiumPct: 37 },
    session: { trading: true }, intraday: { date: '2026-11-05', points: points.map(p => ({ ...p })) }, ind: {}, signals: [], positionPlan: { tier: 'try' }, ...overrides };
}
const rebound = [point('13:00', 2.94), point('13:01', 2.92), point('13:02', 2.925), point('13:03', 2.931)];

test('原始分时排除零成交占位、午休及盘后点，不补造早盘', () => {
  const parsed = context.parseEtfMinuteData({ date: '20261105', data: ['0930 2.946 0 0', '1030 2.946 0 0', '1031 2.990 100 29900', '1200 2.98 100 29900', '1500 2.921 200 59000', '1501 2.921 200 59000'] });
  assert.deepEqual(plain(parsed.points.map(p => p.t)), ['10:31', '15:00']);
  assert.equal(parsed.inactiveRange, '09:30–10:30');
  assert.match(parsed.note, /零成交/);
  assert.equal(parsed.points[0].avg, 2.99);
});

test('盘中尚无今日日K时仍使用报价昨收及真正昨日日K', () => {
  const ctx = input(rebound, { klineLast: { date: '2026-11-04', close: 2.946, open: 2.94, high: 3, low: 2.9 }, klinePrev: { date: '2026-11-03', close: 2.8 } });
  ctx.quote.prevClose = 2.946;
  assert.equal(context.getBasePrevClose(ctx, 'live'), 2.946);
  const plan = context.buildPremarketPlan(ctx, null, { debugTime: '2026-11-05T05:03:00Z' });
  assert.equal(plan.basePrevClose, 2.946);
  assert.match(plan.logic, /昨日/);
  assert.ok(plan.buy.every(b => b.price > 0));
});

test('盘中重复请求保留触达与已观察信号，次日计划独立生成', () => {
  const ctx = input(rebound, { klineLast: { date: '2026-11-05', close: 2.93 }, klinePrev: { date: '2026-11-04', close: 2.98, open: 2.98, high: 3, low: 2.94 } });
  const day = context.buildPremarketPlan(ctx, null, { debugTime: '2026-11-05T05:04:00Z' });
  day.signalEvents = [{ key: 'observed', side: 'buy', time: '13:03' }];
  const updated = context.buildPremarketPlan(ctx, day, { debugTime: '2026-11-05T05:04:00Z' });
  assert.deepEqual(plain(updated.signalEvents), plain(day.signalEvents));
  const snapshot = JSON.stringify(day);
  const next = context.buildPremarketPlan(ctx, null, { qqqRegPct: 1, debugTime: '2026-11-05T08:00:00Z' });
  assert.equal(next.mode, 'next');
  assert.equal(next.basePrevClose, 2.93);
  assert.equal(next.touches.length, 0);
  assert.equal(JSON.stringify(day), snapshot);
});

test('正规盘暴跌不能被盘外小幅反弹掩盖，首档按累计跌幅下移', () => {
  const fixture = { today: '2026-11-06', quote: { price: 2.921, prevClose: 2.921, premiumPct: 41 }, ind: {},
    klineLast: { date: '2026-11-05', close: 2.921, open: 2.969, high: 3.008, low: 2.914 }, klinePrev: { date: '2026-11-04', close: 2.946 }, session: { trading: false } };
  const plan = context.buildPremarketPlan(fixture, null, { debugTime: '2026-11-06T00:30:00Z', qqqRegPct: -6.49, qqqPrePct: 0.98, ixicRegPct: -5.52, ixicPrePct: 1.35 });
  assert.ok(plan.expectOpenPct < -3);
  assert.ok(plan.buy[0].pct < -3);
  assert.match(plan.logic, /尚未消化的美股累计/);
  assert.ok(plan.inputs.qqqUnpricedPct < -5);
});

test('ETF休市跨多日按基准日前美股收盘累计，不重复计算已消化收盘', () => {
  const h = { dates: ['2026-11-04', '2026-11-05', '2026-11-06'], closes: [100, 95, 90] };
  assert.ok(Math.abs(context.unpricedUsMove(h, '2026-11-05', -5.26, 1, null, 'pre') + 9.1) < 0.001);
  assert.ok(Math.abs(context.unpricedUsMove(h, '2026-11-06', -5.26, 1, null, 'pre') - (90 / 95 * 1.01 - 1) * 100) < 0.001);
  assert.equal(context.unpricedUsMove(h, '2026-11-09', -5.26, 1, null, 'next'), null);
  assert.equal(context.unpricedUsMove(h, '2026-11-09', -5.26, 1, null, 'pre'), 1);
});

test('低开高抛档位基于实际开盘，低于昨收且两档分开', () => {
  const fixture = input(rebound, { today: '2026-11-06', klineLast: { date: '2026-11-06', close: 2.804 }, klinePrev: { date: '2026-11-05', close: 2.921, open: 2.969, high: 3.008, low: 2.914 } });
  fixture.quote = { ...fixture.quote, quoteDate: '2026-11-06', prevClose: 2.921, open: 2.81 };
  const old = { buy: [], sell: [{ key: 's1', pct: 0.3 }, { key: 's2', pct: 0.3 }], touched: {}, inputs: {} };
  const plan = context.buildPremarketPlan(fixture, old, { debugTime: '2026-11-06T03:00:00Z', qqqRegPct: -6.49, qqqPrePct: 1, ixicRegPct: -5.52, ixicPrePct: 1 });
  assert.equal(plan.inputs.sellAnchor, '实际开盘');
  assert.equal(plan.sell[0].price, 2.824);
  assert.equal(plan.sell[1].price, 2.838);
  assert.ok(plan.sell[1].pct > plan.sell[0].pct);
  assert.ok(plan.sell.every(s => s.pct < 0));
});

test('未触达档位不会复用旧口径，已触达档位和记录仍保留', () => {
  const fixture = input(rebound, { klineLast: { date: '2026-11-05', close: 2.9, open: 2.9, high: 3, low: 2.8 } });
  const old = { buy: [{ key: 'b1', pct: -0.3 }, { key: 'b2', pct: -0.6 }], sell: [], touched: { b1: true }, touches: [{ key: 'b1', time: '13:00' }], inputs: {} };
  const plan = context.buildPremarketPlan(fixture, old, { debugTime: '2026-11-05T05:04:00Z', qqqRegPct: -5, qqqPrePct: 1 });
  assert.equal(plan.buy[0].pct, -0.3);
  assert.ok(plan.buy[1].pct < -3);
  assert.equal(plan.touches[0].time, '13:00');
});

test('旧高抛档位已触达时保留其价格，另一档仍有间距', () => {
  const fixture = input(rebound); fixture.quote.open = 2.8;
  const old = { buy: [], sell: [{ key: 's1', pct: 0.3 }, { key: 's2', pct: 0.3 }], touched: { s1: true }, inputs: {} };
  const plan = context.buildPremarketPlan(fixture, old, { debugTime: '2026-11-05T05:04:00Z', qqqRegPct: -5 });
  assert.equal(plan.sell[0].pct, 0.3);
  assert.ok(plan.sell[1].pct >= 0.5);
});

test('高点高于均价带仍允许转弱减仓，不因偏离上沿错失高抛', () => {
  const points = [point('14:00', 2.915, 2.93), point('14:01', 2.932, 2.93), point('14:02', 2.952, 2.93), point('14:03', 2.947, 2.93), point('14:04', 2.943, 2.93)];
  const events = context.buildEtfIntradaySignals(input(points)).events;
  assert.equal(events.find(e => e.side === 'sell').time, '14:04');
});

test('波动自适应均价带比固定1.2%窄，保持上下限', () => {
  const narrow = context.buildEtfIntradayBands([point('13:00', 3), point('13:01', 3.003), point('13:02', 3.005)]).at(-1);
  assert.equal(narrow.halfWidthPct, 0.15);
  const wide = context.buildEtfIntradayBands([point('13:00', 3), point('13:01', 3.3), point('13:02', 3.1)]).at(-1);
  assert.equal(wide.halfWidthPct, 0.6);
});

test('参考和确认信号共用30分钟窗口，早期低点退出后不算大反弹', () => {
  const points = Array.from({ length: 33 }, (_, i) => point(`13:${String(i).padStart(2, '0')}`, i === 0 ? 2 : (i === 31 ? 3.001 : i === 32 ? 3.002 : 3), 3));
  const fixture = input(points); fixture.session.trading = false;
  const result = context.buildEtfIntradaySignals(fixture);
  assert.ok(result.events.filter(e => e.time >= '13:30').every(e => e.side !== 'watch'));
  assert.equal(result.bands.at(-1).low, 3);
  assert.ok(result.bands.at(-1).reboundPct < 0.1);
});

test('状态说明给出尚缺反弹幅度和两分钟确认，而不是触带即买卖', () => {
  const fixture = input([point('13:00', 2.94), point('13:01', 2.93), point('13:02', 2.92)]); fixture.quote.premiumPct = 17;
  const guide = context.buildEtfIntradaySignals(fixture).guide;
  assert.match(guide.buyNote, /反弹还差/);
  assert.match(guide.buyNote, /两分钟回升/);
  assert.match(guide.sellNote, /反弹幅度还差/);
});

test('相似历史回顾剔除当日未来收盘并按ETF交易日去重', () => {
  const historyContext = vm.createContext({});
  vm.runInContext(declaration(server, 'buildPremarketHistoryReview'), historyContext);
  const rows = Array.from({ length: 65 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10), close: 3, low: 2.9 }));
  rows.push({ date: '2026-11-06', close: 2.8, low: 2.7 });
  const indices = { qqq: { dates: ['2026-07-01', '2026-11-04', '2026-11-05'], ret: { '2026-07-01': -5, '2026-11-04': -5, '2026-11-05': -5 } } };
  const beforeClose = historyContext.buildPremarketHistoryReview(rows, indices, -5, '2026-11-06');
  assert.equal(beforeClose.count, 1);
  const afterClose = historyContext.buildPremarketHistoryReview(rows, indices, -5);
  assert.equal(afterClose.count, 2);
});

test('盘口无效输入不冒充正规盘涨跌或抵消已知大跌', () => {
  assert.equal(context.unpricedUsMove(null, null, null, null, null, 'pre'), null);
  assert.ok(Math.abs(context.unpricedUsMove(null, null, -5, null, null, 'pre') + 5) < 1e-10);
  const fixture = input(rebound); fixture.session.trading = false;
  const plan = context.buildPremarketPlan(fixture, null, { debugTime: '2026-11-05T00:30:00Z' });
  assert.equal(plan.expectOpenPct, null);
  assert.match(plan.inputs.sellAnchor, /预测输入缺失/);
});

test('无美股输入时收盘模式不把null误当有效输入', () => {
  assert.equal(context.premarketMode({}, '2026-11-05T08:00:00Z', { qqqPct: null, ixicPct: null }), 'closed');
});

test('首次盘中触价立即记录，可生成alerts而不等待第二次请求', () => {
  const ctx = input(rebound, { klineLast: { date: '2026-11-05', close: 2.93 }, klinePrev: { date: '2026-11-04', close: 2.98, open: 2.98, high: 3, low: 2.94 } });
  ctx.premarket = context.buildPremarketPlan(ctx, null, { debugTime: '2026-11-05T05:03:00Z' });
  assert.ok(ctx.premarket.touches.some(e => e.key === 'b1'));
  ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  const alerts = context.buildEtfAlerts(ctx);
  assert.ok(alerts.some(e => e.key.includes('intraday_level_')));
  assert.ok(alerts.filter(e => e.key.includes('intraday_level_')).every(e => e.time === '13:04' && !e.text.includes('直接买入')));
  const repeat = context.buildPremarketPlan(ctx, ctx.premarket, { debugTime: '2026-11-05T05:03:00Z' });
  assert.equal(repeat.touches.length, ctx.premarket.touches.length);
});

test('止跌需要两分钟确认，只有高溢价观察提示没有买入指令', () => {
  const result = context.buildEtfIntradaySignals(input(rebound));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].time, '13:03');
  assert.equal(result.events[0].side, 'watch');
  assert.match(result.events[0].text, /不新增仓位/);
  assert.equal(context.buildEtfIntradaySignals(input(rebound.slice(0, 3))).events.length, 0);
});

test('允许溢价且趋势未跑路时实时止跌才是小仓候选', () => {
  const ctx = input(rebound);
  ctx.quote.premiumPct = 17;
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].side, 'buy');
  ctx.positionPlan.tier = 'run';
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].side, 'watch');
  ctx.positionPlan.tier = 'try'; ctx.quote.premiumPct = null;
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].side, 'watch');
});

test('日内买入候选遵守QQQ作废与14:30截止', () => {
  const ctx = input(rebound); ctx.quote.premiumPct = 17;
  ctx.premarket = { inputs: { qqqPrePct: -4 }, stop: { qqqAbort: -3.5 } };
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].side, 'watch');
  const late = rebound.map((p, i) => ({ ...p, t: `14:${27 + i}` }));
  assert.equal(context.buildEtfIntradaySignals(input(late)).events.length, 0);
});

test('反弹转弱可在绿盘给已有仓位减仓候选，不要求翻红', () => {
  const points = [point('14:00', 2.915, 2.955), point('14:01', 2.932, 2.955), point('14:02', 2.952, 2.955), point('14:03', 2.947, 2.955), point('14:04', 2.943, 2.955)];
  const result = context.buildEtfIntradaySignals(input(points));
  const sell = result.events.find(e => e.side === 'sell');
  assert.ok(sell);
  assert.equal(sell.time, '14:04');
  assert.ok(sell.price < 2.98);
});

test('新增未来分钟不改变之前的走势事件及确认时间', () => {
  const ctx = input(rebound); ctx.session.trading = false; ctx.quote.quoteTime = '2026-11-05 15:00';
  const before = context.buildEtfIntradaySignals(ctx).events;
  ctx.intraday.points = [...rebound, point('13:04', 3.5), point('13:05', 2.5)];
  const after = context.buildEtfIntradaySignals(ctx).events.filter(e => e.time <= '13:03');
  assert.deepEqual(plain(after), plain(before));
});

test('分钟间隙不跨越无成交或午休拼接确认', () => {
  const gap = [point('11:28', 2.92), point('11:29', 2.925), point('13:00', 2.931)];
  assert.equal(context.buildEtfIntradaySignals(input(gap)).events.length, 0);
  const missing = [point('13:00', 2.92), point('13:02', 2.925), point('13:03', 2.931)];
  assert.equal(context.buildEtfIntradaySignals(input(missing)).events.length, 0);
});

test('历史日期、过期分钟和收盘回放不会发实时alerts', () => {
  const ctx = input(rebound); ctx.intraday.date = '2026-11-04';
  assert.equal(context.buildEtfIntradaySignals(ctx).events.length, 0);
  ctx.intraday.date = ctx.today; ctx.quote.quoteTime = '2026-11-05 14:00';
  ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  assert.equal(ctx.intradaySignals.actionable, false);
  assert.ok(context.buildEtfAlerts(ctx).every(e => !e.key.startsWith('intraday_')));
  ctx.session.trading = false;
  assert.ok(context.buildEtfIntradaySignals(ctx).events.every(e => e.side !== 'buy'));
});

test('14:29确认信号在14:30收到时也不得新增仓位', () => {
  const points = rebound.map((p, i) => ({ ...p, t: `14:${26 + i}` }));
  const ctx = input(points); ctx.quote.premiumPct = 17;
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].side, 'watch');
});

test('未闭合分钟的价格波动不用于方向确认', () => {
  const ctx = input(rebound); ctx.quote.quoteTime = '2026-11-05 13:03';
  assert.equal(context.buildEtfIntradaySignals(ctx).events.length, 0);
  ctx.quote.quoteTime = '2026-11-05 13:04';
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].time, '13:03');
});

test('观察档不得因低溢价升级为日内买入候选', () => {
  const ctx = input(rebound); ctx.quote.premiumPct = 10; ctx.positionPlan.tier = 'watch';
  assert.equal(context.buildEtfIntradaySignals(ctx).events[0].side, 'watch');
});

test('零成交分时或午休不触发档位提醒', () => {
  const ctx = input(rebound, { klineLast: { date: '2026-11-04', close: 2.98 } });
  ctx.quote.quoteTime = '2026-11-05 12:00';
  const plan = context.buildPremarketPlan(ctx, null, { debugTime: '2026-11-05T04:00:00Z' });
  assert.equal(plan.touches.length, 0);
  ctx.intraday.points = [];
  ctx.quote.quoteTime = '2026-11-05 13:04';
  assert.equal(context.buildPremarketPlan(ctx, null, { debugTime: '2026-11-05T05:04:00Z' }).touches.length, 0);
});

test('已记录买入候选遇到溢价升高时不得再次给买入提示', () => {
  const ctx = input(rebound); ctx.quote.premiumPct = 17;
  ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  assert.equal(ctx.intradaySignals.events[0].side, 'buy');
  ctx.quote.premiumPct = 40;
  const alert = context.buildEtfAlerts(ctx).find(e => e.key.startsWith('intraday_rebound_'));
  assert.equal(alert.side, 'watch');
  assert.match(alert.title, /禁止买入/);
});

test('当天计划和实际观察信号落盘后能恢复，跨日不沿用', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'etf-day-plan-test-'));
  try {
    const file = path.join(directory, 'day.json');
    const store = vm.createContext({ fs, console, ETF_DAY_PLAN_FILE: file });
    vm.runInContext(declaration(server, 'saveEtfDayPlan') + '\n' + declaration(server, 'loadEtfDayPlan'), store);
    const plan = { _date: '2026-11-05', buy: [], sell: [], touched: { b1: true }, touches: [{ key: 'b1', time: '13:04' }], signalEvents: [] };
    store.saveEtfDayPlan(plan);
    assert.equal(store.loadEtfDayPlan('2026-11-05').touches[0].time, '13:04');
    plan.signalEvents.push({ key: 'actual', side: 'watch' });
    store.saveEtfDayPlan(plan);
    assert.equal(store.loadEtfDayPlan('2026-11-05').signalEvents.length, 1);
    assert.equal(store.loadEtfDayPlan('2026-11-06'), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('参考区只使用已闭合分钟，未来极低价不影响当前低吸区', () => {
  const ctx = input(rebound); ctx.quote.premiumPct = 17;
  const before = context.buildEtfIntradaySignals(ctx).guide;
  ctx.intraday.points.push(point('13:05', 1));
  const after = context.buildEtfIntradaySignals(ctx).guide;
  assert.deepEqual(plain(after), plain(before));
  assert.equal(after.lowBand.low, 2.92);
  assert.equal(after.buyState, '止跌确认 · 小仓候选');
});

test('高溢价和观察档只给低吸观察，不因进入参考区升级买入', () => {
  const ctx = input(rebound);
  let guide = context.buildEtfIntradaySignals(ctx).guide;
  assert.equal(guide.buyState, '低吸仅观察');
  assert.match(guide.buyNote, /37.00%/);
  ctx.quote.premiumPct = 10; ctx.positionPlan.tier = 'watch';
  guide = context.buildEtfIntradaySignals(ctx).guide;
  assert.equal(guide.buyState, '低吸仅观察');
  assert.match(guide.buyNote, /趋势/);
});

test('高抛参考区内仍等待转弱，强势超过参考区不自动卖', () => {
  const ctx = input([point('13:00', 2.95, 2.95), point('13:01', 2.95, 2.95), point('13:02', 2.95, 2.95)]);
  assert.equal(context.buildEtfIntradaySignals(ctx).guide.sellState, '反弹观察区内 · 等转弱');
  ctx.intraday.points[2].price = 2.98;
  assert.equal(context.buildEtfIntradaySignals(ctx).guide.sellState, '反弹持有观察');
});

test('回踩参考区内未止跌时显示等待，不直接买', () => {
  const ctx = input([point('13:00', 2.94), point('13:01', 2.93), point('13:02', 2.92)]);
  ctx.quote.premiumPct = 17;
  assert.equal(context.buildEtfIntradaySignals(ctx).guide.buyState, '低吸区内 · 等止跌');
});

test('参考区跨午休重置，只用最新连续分钟而非上午低位', () => {
  const ctx = input([point('11:30', 1), point('13:00', 3), point('13:01', 3.01), point('13:02', 3.02)]);
  assert.equal(context.buildEtfIntradaySignals(ctx).guide.lowBand.low, 3);
  assert.equal(context.buildEtfIntradaySignals(ctx).guide.from, '13:00');
});

test('连续分钟不足不绘制参考区，缺均价不造高抛区', () => {
  const gap = input([point('13:00', 2.9), point('13:03', 3), point('13:04', 3.01)]);
  assert.equal(context.buildEtfIntradaySignals(gap).guide, null);
  const noAvg = input(rebound.map(p => ({ ...p, avg: null })));
  const guide = context.buildEtfIntradaySignals(noAvg).guide;
  assert.equal(guide.highBand, null);
  assert.equal(guide.sellState, '均价待确认');
});

test('盘后参考区明确回看而不生成当前高抛或买入指令', () => {
  const ctx = input(rebound); ctx.session.trading = false;
  const guide = context.buildEtfIntradaySignals(ctx).guide;
  assert.equal(guide.buyState, '低吸仅观察');
  assert.equal(guide.sellState, '反弹观察区回看');
  assert.match(guide.buyNote, /非实时/);
});

test('图表绘制动态参考带并隐藏零成交提示，不把参考带当买卖确认', () => {
  const fixture = input(rebound); fixture.session.trading = false;
  fixture.intraday.note = '零成交时段未绘制，可能暂停交易或数据尚未到达；不据此生成信号。';
  fixture.intraday.inactiveRange = '09:30–10:30';
  const result = context.buildEtfIntradaySignals(fixture);
  const browser = vm.createContext({ ETF_TRACK: { ...fixture, intradaySignals: result }, etfChartWidth: () => 360, escHtml: String, etfHeroHtml: () => '', etfSessionQuoteHtml: () => '', etfMarketLinkHtml: () => '', etfQuoteInlineHtml: () => '' });
  vm.runInContext(declaration(html, 'etfIntradayOffset') + '\n' + declaration(html, 'etfIntradayHtml'), browser);
  const rendered = browser.etfIntradayHtml();
  assert.match(rendered, /data-reference-zone="buy"/);
  assert.match(rendered, /data-reference-zone="sell"/);
  assert.match(rendered, /低吸 2.920–2.929/);
  assert.match(rendered, /最新参考区/);
  assert.match(rendered, /累计成交均价附近的反弹观察区/);
  assert.match(rendered, /data-band-segment="buy"/);
  assert.match(rendered, /<th>低吸区<\/th>/);
  assert.doesNotMatch(rendered, /零成交时段未绘制|可能暂停交易或数据尚未到达/);
});

test('逐分钟参考带保持前缀一致，后续新低与均价不改写早盘', () => {
  const past = [point('10:31', 3, 3.01), point('10:32', 2.98, 3), point('10:33', 2.99, 2.995)];
  const before = context.buildEtfIntradayBands(past);
  const full = context.buildEtfIntradayBands([...past, point('10:34', 2.8, 2.9)]);
  assert.deepEqual(plain(full.slice(0, 3)), plain(before));
  assert.equal(before[0].lowBand, null);
  assert.equal(before[2].lowBand.low, 2.98);
  assert.equal(before[2].highBand.low, +(2.995 * (1 - before[2].halfWidthPct / 100)).toFixed(3));
  assert.equal(full[3].lowBand.low, 2.8);
});

test('逐分钟回放的每个前缀都与全天对应参考带一致', () => {
  const points = Array.from({ length: 60 }, (_, i) => point(`13:${String(i).padStart(2, '0')}`, 3 + Math.sin(i / 4) * 0.03, 3 + i * 0.0001));
  const full = context.buildEtfIntradayBands(points);
  for (let n = 1; n <= points.length; n++) {
    const prefix = context.buildEtfIntradayBands(points.slice(0, n));
    assert.deepEqual(plain(prefix), plain(full.slice(0, n)));
  }
});

test('低吸动态带只用最近30个连续分钟，不沿用过期低位', () => {
  const points = Array.from({ length: 33 }, (_, i) => point(`13:${String(i).padStart(2, '0')}`, i === 0 ? 1 : 3));
  const bands = context.buildEtfIntradayBands(points);
  assert.equal(bands[29].lowBand.low, 1);
  assert.equal(bands[30].lowBand.low, 3);
  assert.equal(bands[30].from, '13:01');
});

test('午休缺失断开动态带，缺均价仅缺高抛带', () => {
  const points = [...rebound, point('14:00', 2.9), point('14:01', 2.91), point('14:02', 2.92, null)];
  const bands = context.buildEtfIntradayBands(points);
  assert.equal(bands[4].lowBand, null);
  assert.equal(bands[5].lowBand, null);
  assert.equal(bands[6].lowBand.low, 2.9);
  assert.equal(bands[6].highBand, null);
  const fixture = input(points); fixture.session.trading = false;
  const result = context.buildEtfIntradaySignals(fixture);
  const browser = vm.createContext({ ETF_TRACK: { ...fixture, intradaySignals: result }, etfChartWidth: () => 360, escHtml: String, etfHeroHtml: () => '', etfSessionQuoteHtml: () => '', etfMarketLinkHtml: () => '', etfQuoteInlineHtml: () => '' });
  vm.runInContext(declaration(html, 'etfIntradayOffset') + '\n' + declaration(html, 'etfIntradayHtml'), browser);
  const rendered = browser.etfIntradayHtml();
  assert.equal((rendered.match(/data-band-segment="buy"/g) || []).length, 2);
  assert.equal((rendered.match(/data-band-segment="sell"/g) || []).length, 1);
});

test('未闭合或未来分钟不进入动态带', () => {
  const fixture = input(rebound); fixture.quote.quoteTime = '2026-11-05 13:03';
  const result = context.buildEtfIntradaySignals(fixture);
  assert.deepEqual(plain(result.bands.map(r => r.time)), ['13:00', '13:01', '13:02']);
});

test('15:00起即使session缓存仍为盘中，也不得新增提示记录或弹窗', () => {
  let now = Date.parse('2026-11-05T06:59:00Z'), records = 0, toasts = 0;
  const browser = vm.createContext({ Date: class extends Date { static now() { return now; } }, ETF_TRACK: { session: { trading: true } },
    ETF_ALERT_SEEN: null, ETF_ALERT_URGENT: /^intraday_/, etfAlertLogToday: () => {}, nowStr: () => '14:59',
    etfRecordAlert: () => { records++; return true; }, etfToast: () => toasts++, document: { querySelectorAll: () => [] } });
  vm.runInContext(declaration(html, 'etfAlertsActive') + '\n' + declaration(html, 'processEtfAlerts'), browser);
  browser.processEtfAlerts([{ key: 'intraday_a' }]);
  assert.equal(records, 1); assert.equal(toasts, 1);
  now = Date.parse('2026-11-05T07:00:00Z');
  browser.processEtfAlerts([{ key: 'intraday_b' }]);
  assert.equal(records, 1); assert.equal(toasts, 1);
  now = Date.parse('2026-11-05T12:00:00Z');
  browser.processEtfAlerts([{ key: 'intraday_c' }]);
  assert.equal(records, 1);
});

test('非交易时段与休市均不触发盘中通知', () => {
  const browser = vm.createContext({ ETF_TRACK: { session: { trading: true } } });
  vm.runInContext(declaration(html, 'etfAlertsActive'), browser);
  assert.equal(browser.etfAlertsActive(Date.parse('2026-11-05T04:00:00Z')), false);
  assert.equal(browser.etfAlertsActive(Date.parse('2026-11-07T05:00:00Z')), false);
  browser.ETF_TRACK.session.trading = false;
  assert.equal(browser.etfAlertsActive(Date.parse('2026-11-05T05:00:00Z')), false);
});

test('盘前参考计划独立默认折叠，开盘收盘及次日都可展开且记录随计划折叠', () => {
  const browser = vm.createContext({ ETF_TRACK: { today: '2026-11-05', premarket: { mode: 'next', buy: [], sell: [], stop: {}, basePrevClose: 3 }, quote: {} },
    ETF_PLAN_OPEN: false, escHtml: String, etfPremarketHistoryHtml: () => '' });
  vm.runInContext(declaration(html, 'etfPremarketHtml'), browser);
  for (const mode of ['pre', 'live', 'closed', 'next']) {
    browser.ETF_TRACK.premarket.mode = mode;
    browser.ETF_PLAN_OPEN = false;
    const folded = browser.etfPremarketHtml();
    assert.match(folded, /<details class="etf-plan-fold"\s+ontoggle/);
    assert.doesNotMatch(folded, /盘前／盘中/);
    assert.match(folded, mode === 'next' ? /下个交易日 · 参考计划/ : /盘前提示 · 参考计划/);
    if (mode === 'next' || mode === 'closed') assert.ok(folded.indexOf('今日计划记录') < folded.indexOf('</details>'));
    browser.ETF_PLAN_OPEN = true;
    assert.match(browser.etfPremarketHtml(), /<details class="etf-plan-fold" open/);
  }
  browser.ETF_TRACK.premarket = null; browser.ETF_PLAN_OPEN = false;
  assert.match(browser.etfPremarketHtml(), /<details class="etf-plan-fold"\s+ontoggle/);
});

test('图表用中文区分观察和买卖候选，不把观察标为买', () => {
  const browser = vm.createContext({ ETF_TRACK: { intraday: { points: [point('13:00', 2.94), point('13:01', 2.92)] }, quote: { prevClose: 2.98 },
    intradaySignals: { events: [{ time: '13:00', price: 2.94, side: 'watch', title: '观察' }, { time: '13:01', price: 2.92, side: 'buy', title: '买入候选' }, { time: '13:01', price: 2.92, side: 'sell', title: '减仓候选' }] } },
    etfChartWidth: () => 360, escHtml: String, etfHeroHtml: () => '', etfSessionQuoteHtml: () => '', etfMarketLinkHtml: () => '', etfQuoteInlineHtml: () => '' });
  vm.runInContext(declaration(html, 'etfIntradayOffset') + '\n' + declaration(html, 'etfIntradayHtml'), browser);
  const rendered = browser.etfIntradayHtml();
  assert.match(rendered, /data-intraday-side="watch"/);
  assert.match(rendered, />观察<\/text>/);
  assert.match(rendered, />买 2.920<\/text>/);
  assert.match(rendered, />卖 2.920<\/text>/);
  assert.match(rendered, /fill="var\(--up\)"[^>]*>买 2.920<\/text>/);
  assert.match(rendered, /fill="var\(--down\)"[^>]*>卖 2.920<\/text>/);
  assert.doesNotMatch(rendered, />[WBS]<\/text>/);
});

test('分时时间轴分为上午下午，午休不作为交易分钟', () => {
  const browser = vm.createContext({});
  vm.runInContext(declaration(html, 'etfIntradayOffset'), browser);
  assert.equal(browser.etfIntradayOffset('09:30'), 0);
  assert.equal(browser.etfIntradayOffset('10:30'), 60);
  assert.equal(browser.etfIntradayOffset('11:30'), 120);
  assert.equal(browser.etfIntradayOffset('13:00'), 120);
  assert.equal(browser.etfIntradayOffset('14:00'), 180);
  assert.equal(browser.etfIntradayOffset('15:00'), 240);
});

test('分时默认最近一小时，手动查看和切换上午下午刷新后保持', () => {
  const el = { dataset: { date: '2026-11-05', scale: '5', latestX: '1264' }, clientWidth: 380, scrollLeft: 0 };
  const browser = vm.createContext({ ETF_INTRADAY_VIEW: { date: null, offset: 0, follow: true }, document: { getElementById: () => el } });
  vm.runInContext(['etfIntradayScroll', 'etfInitIntradayScroll', 'etfPanIntraday'].map(n => declaration(html, n)).join('\n'), browser);
  browser.etfInitIntradayScroll();
  assert.equal(el.scrollLeft, 928);
  el.scrollLeft = 250; browser.etfIntradayScroll(el);
  browser.etfInitIntradayScroll(); assert.equal(el.scrollLeft, 250);
  assert.equal(browser.ETF_INTRADAY_VIEW.follow, false);
  browser.etfPanIntraday('morning'); assert.equal(el.scrollLeft, 0);
  browser.etfPanIntraday('afternoon'); assert.equal(el.scrollLeft, 628);
  browser.etfPanIntraday('latest'); assert.equal(el.scrollLeft, 928);
  el.dataset.latestX = '1274'; browser.etfInitIntradayScroll(); assert.equal(el.scrollLeft, 938);
  const saved = JSON.stringify(browser.ETF_INTRADAY_VIEW);
  el.isConnected = false; el.scrollLeft = 0; browser.etfIntradayScroll(el);
  assert.equal(JSON.stringify(browser.ETF_INTRADAY_VIEW), saved);
  el.isConnected = true;
  el.dataset.date = '2026-11-06'; el.dataset.latestX = '80';
  browser.etfInitIntradayScroll(); assert.equal(el.scrollLeft, 0);
});

test('全天缩放到一屏，保留买卖标记，返回最近一小时恢复宽图', () => {
  const el = { dataset: { date: '2026-11-05', scale: '5', latestX: '1264' }, clientWidth: 380, scrollLeft: 928, innerHTML: '' };
  const browser = vm.createContext({ ETF_INTRADAY_VIEW: { date: '2026-11-05', offset: 0, follow: true },
    ETF_TRACK: { intraday: { date: '2026-11-05', points: [point('10:31', 2.99), point('15:00', 2.92)] }, quote: {}, intradaySignals: { events: [] } },
    document: { getElementById: () => el }, etfChartWidth: () => 360, escHtml: String, etfHeroHtml: () => '', etfSessionQuoteHtml: () => '', etfMarketLinkHtml: () => '', etfQuoteInlineHtml: () => '' });
  vm.runInContext(['etfIntradayOffset', 'etfIntradayScroll', 'etfInitIntradayScroll', 'etfPanIntraday', 'etfIntradayHtml'].map(n => declaration(html, n)).join('\n'), browser);
  browser.etfPanIntraday('all');
  assert.equal(browser.ETF_INTRADAY_VIEW.all, true);
  assert.equal(el.scrollLeft, 0);
  const fullDay = browser.etfIntradayHtml();
  assert.match(fullDay, /<svg width="360" height="190"/);
  assert.match(fullDay, />全天<\/button>/);
  browser.etfIntradayScroll(el);
  assert.equal(browser.ETF_INTRADAY_VIEW.all, true);
  browser.etfPanIntraday('latest');
  assert.equal(browser.ETF_INTRADAY_VIEW.all, false);
  assert.equal(browser.ETF_INTRADAY_VIEW.follow, true);
  assert.match(browser.etfIntradayHtml(), /<svg width="1228" height="190"/);
});

test('前端日内事件同日同key只记录一次，刷新或条件解除后不重复弹', () => {
  const browser = vm.createContext({ ETF_ALERT_LOG: [], etfAlertLogToday: () => '2026-11-05', etfSaveAlertLog: () => {} });
  vm.runInContext(declaration(html, 'etfRecordAlert'), browser);
  assert.equal(browser.etfRecordAlert({ key: 'intraday_level_2026-11-05_b1', text: 'A' }, '13:03', false), true);
  assert.equal(browser.etfRecordAlert({ key: 'intraday_level_2026-11-05_b1', text: 'B' }, '13:04', false), false);
});

function soundBrowser(events) {
  const tones = [], toasts = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; }
    createOscillator() { return { type: '', frequency: {}, connect() {}, start: () => tones.push(1), stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  const browser = vm.createContext({ Date: class extends Date { static now() { return Date.parse('2026-11-05T05:04:00Z'); } },
    ETF_TRACK: { session: { trading: true }, intradaySignals: { actionable: true, events } },
    ETF_SOUND: true, ETF_NOTIFY: false, ETF_ALERT_SEEN: null, ETF_ALERT_LOG: [],
    ETF_ALERT_URGENT: /^(buy_opportunity|macd_flip_neg|intraday_)/,
    etfAlertLogToday: () => '2026-11-05', etfSaveAlertLog: () => {}, nowStr: () => '13:04',
    etfToast: a => toasts.push(a), currentRoute: () => ({ view: 'qdii' }), window: { AudioContext }, document: { querySelectorAll: () => [] },
    localStorage: { setItem() {} }, renderEtfPosition() {} });
  vm.runInContext(['etfAlertsActive', 'etfRecordAlert', 'processEtfAlerts', 'etfBeep', 'etfToggleSound'].map(n => declaration(html, n)).join('\n'), browser);
  return { browser, tones, toasts };
}

test('仅实时分时图买卖信号响两声，观察和其他提示仍记录但静音', () => {
  const events = [
    { key: 'intraday_rebound_2026-11-05_13:03', side: 'buy' },
    { key: 'intraday_pullback_2026-11-05_13:04', side: 'sell' },
    { key: 'intraday_rebound_2026-11-05_13:01', side: 'watch' },
  ];
  const { browser, tones, toasts } = soundBrowser(events);
  const alerts = [...events, { key: 'buy_opportunity', side: 'buy' }, { key: 'macd_flip_neg', side: 'sell' },
    { key: 'intraday_level_2026-11-05_b1', side: 'buy' }];
  browser.processEtfAlerts(alerts);
  assert.equal(tones.length, 4);
  assert.equal(toasts.length, alerts.length);
  assert.equal(browser.ETF_ALERT_LOG.length, alerts.length);
  browser.processEtfAlerts(alerts);
  assert.equal(tones.length, 4);
  browser.processEtfAlerts([]);
  browser.processEtfAlerts(events);
  assert.equal(tones.length, 4);
});

test('风控降为观察、过期或盘后回放和关闭声音均不响铃', () => {
  const event = { key: 'intraday_rebound_2026-11-05_13:03', side: 'buy' };
  for (const scenario of ['blocked', 'stale', 'closed', 'muted']) {
    const { browser, tones } = soundBrowser([event]);
    if (scenario === 'blocked') browser.processEtfAlerts([{ ...event, side: 'watch' }]);
    else {
      if (scenario === 'stale') browser.ETF_TRACK.intradaySignals.actionable = false;
      if (scenario === 'closed') browser.ETF_TRACK.session.trading = false;
      if (scenario === 'muted') browser.ETF_SOUND = false;
      browser.processEtfAlerts([event]);
    }
    assert.equal(tones.length, 0, scenario);
  }
});

test('声音开关静默解锁音频，普通弹窗不触发声音', () => {
  const { browser, tones, toasts } = soundBrowser([]);
  browser.etfToggleSound();
  browser.etfToggleSound();
  assert.equal(browser.ETF_SOUND, true);
  assert.equal(tones.length, 0);
  assert.match(toasts[0].text, /仅分时走势/);
  const box = { appendChild() {} };
  browser.document = { getElementById: () => box, createElement: () => ({ remove() {} }) };
  browser.escHtml = String; browser.setTimeout = () => {};
  vm.runInContext(declaration(html, 'etfToast'), browser);
  browser.etfToast({ key: 'buy_opportunity', title: '买入机会' }, true);
  browser.etfToast({ title: '无法记录' }, false);
  assert.equal(tones.length, 0);
});

test('分时行情头展示现价涨跌幅溢价和指数，不展示ETF名称日期或盘中状态', () => {
  const browser = vm.createContext({ ETF_TRACK: { name: '纳指科技ETF', quote: { price: 2.921, prevClose: 2.946, changePct: -0.85 },
    premium: { current: 37.08, band: { level: 'extreme', label: '极高' } }, session: { trading: true } },
    LAST_MAP: { SSE: { regularMarketChangePercent: 1.23, tradingToday: false }, QQQ: { regularMarketChangePercent: -0.54, marketState: 'PRE' } },
    escHtml: String, etfMarketMotionBadgeHtml: () => '', cls: () => 'down', fmtPct: v => v == null ? '--' : v.toFixed(2) + '%' });
  vm.runInContext(['effectiveChange', 'etfHeroHtml', 'etfSessionQuoteHtml'].map(n => declaration(html, n)).join('\n'), browser);
  const rendered = browser.etfHeroHtml() + browser.etfSessionQuoteHtml();
  assert.doesNotMatch(browser.etfHeroHtml(), /etf-hero-price|溢价/);
  assert.match(browser.etfSessionQuoteHtml(), /etf-hero-price/);
  assert.doesNotMatch(browser.etfSessionQuoteHtml(), /午休分隔|上午 09:30|下午 13:00/);
  assert.match(rendered, /分时走势/);
  assert.match(rendered, />2.921</);
  assert.match(rendered, /-0.025/);
  assert.match(rendered, /-0.85%/);
  assert.match(rendered, /溢价 37.08%/);
  assert.match(rendered, /上证<\/i><b[^>]*>\+1.23%/);
  assert.match(rendered, /QQQ<small>盘前<\/small><\/i><b[^>]*>-0.54%/);
  assert.doesNotMatch(rendered, /纳指科技ETF|截至|2026-|etf-live-tag|A股交易中|已收盘|休市/);
  browser.LAST_MAP.QQQ = { regularMarketChangePercent: -2, overnightChangePercent: 0.45, marketState: 'OVERNIGHT' };
  assert.match(browser.etfHeroHtml(), /QQQ<small>夜盘<\/small><\/i><b[^>]*>\+0.45%/);
  browser.LAST_MAP.QQQ = { regularMarketChangePercent: -2, regularMarketPrice: 100, afterHoursPrice: 101, marketState: 'POST' };
  assert.match(browser.etfHeroHtml(), /QQQ<small>盘后<\/small><\/i><b[^>]*>\+1.00%/);
  browser.ETF_TRACK = null; browser.LAST_MAP = {};
  const empty = browser.etfHeroHtml();
  assert.match(browser.etfSessionQuoteHtml(), /etf-hero-price[^>]*>--</);
  assert.match(empty, /上证<\/i><b[^>]*>--/);
  assert.match(empty, /QQQ<\/i><b[^>]*>--/);
});

test('分时数据缺失时仍保留行情头，独立顶部行情区域不再渲染或刷新', () => {
  const browser = vm.createContext({ ETF_TRACK: { quote: { price: 2.921 } },
    etfHeroHtml: time => `<div class="etf-hero">${time}</div>`, etfSessionQuoteHtml: () => '<div class="etf-session-quote"></div>', escHtml: String, etfQuoteInlineHtml: () => '' });
  vm.runInContext(declaration(html, 'etfIntradayHtml'), browser);
  assert.match(browser.etfIntradayHtml(), /etf-hero/);
  assert.match(browser.etfIntradayHtml(), /分时数据不可用/);
  assert.doesNotMatch(declaration(html, 'renderEtfView'), /id="etf-hero"/);
  assert.doesNotMatch(declaration(html, 'updateEtfLive'), /set\('etf-hero'/);
});

test('买卖弹窗标题包含信号确认价而非当前行情价', () => {
  const elements = [];
  const browser = vm.createContext({ ETF_NOTIFY: false, currentRoute: () => ({ view: 'qdii' }), escHtml: String, nowStr: () => '13:04', setTimeout() {},
    document: { getElementById: () => ({ appendChild: el => elements.push(el) }), createElement: () => ({ remove() {} }) } });
  vm.runInContext(declaration(html, 'etfToast'), browser);
  browser.etfToast({ title: '止跌买入候选', side: 'buy', price: 2.92 }, false);
  browser.etfToast({ title: '反弹减仓候选', side: 'sell', price: 2.937 }, false);
  browser.etfToast({ title: '普通提示' }, false);
  assert.match(elements[0].innerHTML, /止跌买入候选 · 2.920/);
  assert.match(elements[1].innerHTML, /反弹减仓候选 · 2.937/);
  assert.doesNotMatch(elements[2].innerHTML, /undefined|NaN/);
});

test('上证引用走沪市指数行情并使用中国市场收盘缓存', () => {
  const quotes = vm.createContext({ getUSMarketState: () => 'REGULAR', withTradingDay: q => q,
    isKoreanSymbol: () => false, isTaiwanSymbol: () => false, isJapanSymbol: () => false, HK_STOCKS_SET: new Set() });
  vm.runInContext(['toSinaId', 'quoteMarketKey', 'parseSinaResponse'].map(n => declaration(server, n)).join('\n'), quotes);
  assert.equal(quotes.toSinaId('SSE'), 'sh000001');
  assert.equal(quotes.toSinaId('000001'), 'sz000001');
  assert.equal(quotes.quoteMarketKey('SSE'), 'CN');
  const fields = Array(32).fill(''); fields[0] = '上证指数'; fields[2] = '3000'; fields[3] = '3030'; fields[30] = '2026-11-05';
  const result = quotes.parseSinaResponse(`var hq_str_sh000001="${fields.join(',')}";`, ['SSE']);
  assert.equal(result.SSE.symbol, 'SSE');
  assert.equal(result.SSE.regularMarketChangePercent, 1);
  const browser = vm.createContext({ FUNDS: [] });
  vm.runInContext(declaration(html, 'allSymbols'), browser);
  assert.ok(browser.allSymbols().includes('SSE'));
});

function motionBrowser() {
  const browser = vm.createContext({ Date: class extends Date { static now() { return Date.parse('2026-11-05T05:04:00Z'); } },
    ETF_MARKET_MOTION: {}, LAST_MAP: {}, LAST_STALE: false, ETF_TRACK: null, ETF_LOAD_ERR: null, escHtml: String });
  vm.runInContext(['effectiveChange', 'etfDetectMarketMotion', 'etfSampleMarketMotion', 'etfMarketMotion', 'etfMarketMotionBadgeHtml', 'etfAlertsActive', 'etfCurrentTradeSignal', 'etfTitleStatus', 'etfMarketLinkHtml'].map(n => declaration(html, n)).join('\n'), browser);
  return browser;
}
const motionStart = Date.parse('2026-11-05T05:00:00Z');
function sampleMotion(browser, values, symbol = 'QQQ', overrides = {}, start = motionStart) {
  values.forEach((pct, i) => {
    const at = start + i * 10000;
    browser.etfSampleMarketMotion({ [symbol]: { marketState: 'REGULAR', regularMarketChangePercent: pct,
      regularMarketPreviousClose: 100, tradingToday: true, sourceTimeMs: at, ...overrides } }, false, at);
  });
  return browser.ETF_MARKET_MOTION[symbol];
}

test('急涨急跌需要满一分钟和连续两轮确认，单点跳变不触发', () => {
  for (const direction of [1, -1]) {
    const browser = motionBrowser();
    const values = Array.from({ length: 8 }, (_, i) => direction * i * 0.05);
    const first = sampleMotion(browser, values.slice(0, 7));
    assert.equal(first.signal, null);
    const entry = sampleMotion(browser, [values[7]], 'QQQ', {}, motionStart + 70000);
    assert.equal(entry.signal.kind, direction > 0 ? 'surge' : 'drop');
    assert.equal(entry.signal.minutes, 1);
  }
  const browser = motionBrowser();
  assert.equal(sampleMotion(browser, [0, 0, 0, 0, 0, 0, 1, 1, 1]).signal, null);
  assert.equal(sampleMotion(motionBrowser(), Array(12).fill(-5)).signal, null);
});

test('三分钟缓急变化与先跌后快速反弹均可识别，单调上涨不是反弹', () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ at: motionStart + i * 10000, price: 1 + i * 0.0003 }));
  const browser = motionBrowser();
  assert.equal(browser.etfDetectMarketMotion(points, 'QQQ').minutes, 3);
  const rebound = sampleMotion(browser, [0, -0.2, -0.4, -0.6, -0.7, -0.55, -0.40, -0.25, -0.1]);
  assert.equal(rebound.signal.kind, 'rebound');
  assert.ok(rebound.signal.move > 0.5);
});

test('上证和QQQ使用不同阈值，盘前噪声门槛更高', () => {
  const values = Array.from({ length: 8 }, (_, i) => i * 0.04);
  assert.equal(sampleMotion(motionBrowser(), values, 'SSE').signal.kind, 'surge');
  assert.equal(sampleMotion(motionBrowser(), values).signal, null);
  const pre = sampleMotion(motionBrowser(), Array.from({ length: 8 }, (_, i) => i * 0.06), 'QQQ', { marketState: 'PRE' });
  assert.equal(pre.signal.kind, 'surge');
});

test('数据过期中断重复请求及交易时段切换均不能沿用异动', () => {
  const values = Array.from({ length: 8 }, (_, i) => -i * 0.06);
  for (const state of ['stale', 'closed', 'estimated', 'oldSource', 'futureSource', 'gap', 'pre']) {
    const browser = motionBrowser(); sampleMotion(browser, values);
    const now = motionStart + 80000;
    const quote = { marketState: 'REGULAR', regularMarketChangePercent: -2, regularMarketPreviousClose: 100, sourceTimeMs: now };
    if (state === 'closed') quote.marketState = 'CLOSED';
    if (state === 'estimated') Object.assign(quote, { marketState: 'OVERNIGHT', overnightChangePercent: -1, overnightEstimated: true });
    if (state === 'oldSource') quote.sourceTimeMs = now - 60000;
    if (state === 'futureSource') quote.sourceTimeMs = now + 10000;
    if (state === 'pre') quote.marketState = 'PRE';
    browser.etfSampleMarketMotion({ QQQ: quote }, state === 'stale', state === 'gap' ? now + 60000 : now);
    assert.equal(browser.ETF_MARKET_MOTION.QQQ?.signal ?? null, null, state);
  }
  const browser = motionBrowser(); sampleMotion(browser, values);
  const before = browser.ETF_MARKET_MOTION.QQQ.points.length;
  browser.etfSampleMarketMotion({ QQQ: { marketState: 'REGULAR', regularMarketChangePercent: -9, regularMarketPreviousClose: 100 } }, false, motionStart + 70000);
  assert.equal(browser.ETF_MARKET_MOTION.QQQ.points.length, before);
  assert.equal(browser.etfMarketMotion('QQQ', motionStart + 120000), null);
  sampleMotion(browser, values, 'SSE');
  browser.etfSampleMarketMotion({ SSE: { marketState: 'REGULAR', regularMarketChangePercent: -1, tradingToday: true } }, false, Date.parse('2026-11-05T04:05:00Z'));
  assert.equal(browser.ETF_MARKET_MOTION.SSE, undefined);
});

test('联动提示不跨过ETF风控，不因上证QQQ反弹直接给买入', () => {
  const browser = motionBrowser();
  const drop = { kind: 'drop', label: '↓ 急跌', move: -0.5, minutes: 1 };
  const rebound = { kind: 'rebound', label: '↑ 快速反弹', move: 0.6, minutes: 1 };
  browser.etfMarketMotion = symbol => symbol === 'QQQ' ? rebound : null;
  browser.etfAlertsActive = () => true;
  browser.ETF_TRACK = { quote: { quoteTime: '2026-11-05 13:04', premiumPct: 17 }, positionPlan: { tier: 'try' },
    intradaySignals: { actionable: true, guide: { buyState: '止跌确认 · 小仓候选' }, events: [{ time: '13:03', side: 'buy' }] } };
  assert.match(browser.etfMarketLinkHtml(), /低吸候选/);
  browser.ETF_TRACK.quote.premiumPct = 40;
  assert.match(browser.etfMarketLinkHtml(), /不允许新增买入/);
  assert.doesNotMatch(browser.etfMarketLinkHtml(), /低吸候选/);
  browser.ETF_TRACK.quote.premiumPct = 17;
  browser.ETF_TRACK.intradaySignals.events[0].time = '12:59';
  assert.match(browser.etfMarketLinkHtml(), /等ETF确认/);
  browser.etfMarketMotion = symbol => symbol === 'QQQ' ? rebound : drop;
  assert.match(browser.etfMarketLinkHtml(), /指数方向分歧 · 暂缓低吸/);
  browser.etfMarketMotion = () => drop;
  assert.match(browser.etfMarketLinkHtml(), /指数急跌 · 暂缓低吸/);
  browser.etfMarketMotion = () => rebound;
  browser.ETF_TRACK.intradaySignals.events = [{ time: '13:03', side: 'sell' }];
  assert.match(browser.etfMarketLinkHtml(), /高抛候选/);
  browser.etfAlertsActive = () => false;
  assert.match(browser.etfMarketLinkHtml(), /ETF非实时交易/);
  browser.etfMarketMotion = () => null;
  assert.equal(browser.etfMarketLinkHtml(), '');
});

test('轻柔铃声降低峰值和频率，开关静音解锁仍保留', () => {
  const peaks = [], frequencies = [], stops = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; }
    createOscillator() { const o = { frequency: {}, connect() {}, start: () => frequencies.push(o.frequency.value), stop: at => stops.push(at) }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime: v => peaks.push(v) }, connect() {} }; }
  }
  const browser = vm.createContext({ ETF_SOUND: true, window: { AudioContext } });
  vm.runInContext(declaration(html, 'etfBeep'), browser);
  browser.etfBeep(true); assert.equal(frequencies.length, 0);
  browser.etfBeep();
  assert.deepEqual(frequencies, [660, 780]);
  assert.ok(Math.max(...peaks) <= 0.025);
  assert.ok(Math.max(...stops) <= 0.26);
});

test('当前ETF买卖确认拒绝过期行情、阻断低吸状态和最新QQQ作废条件', () => {
  const browser = motionBrowser(); browser.etfAlertsActive = () => true;
  browser.ETF_TRACK = { quote: { quoteTime: '2026-11-05 13:04', price: 2.94, prevClose: 2.98, premiumPct: 17 },
    positionPlan: { tier: 'try' }, premarket: { stop: { qqqAbort: -3.5, pricePct: -4 } },
    intradaySignals: { actionable: true, guide: { buyState: '止跌确认 · 小仓候选' }, events: [{ time: '13:03', side: 'buy' }] } };
  assert.equal(browser.etfCurrentTradeSignal().buy, true);
  browser.ETF_TRACK.intradaySignals.guide.buyState = '低吸仅观察';
  assert.equal(browser.etfCurrentTradeSignal().buy, false);
  browser.ETF_TRACK.intradaySignals.guide.buyState = '止跌确认 · 小仓候选';
  browser.LAST_MAP.QQQ = { marketState: 'PRE', regularMarketChangePercent: -4 };
  assert.equal(browser.etfCurrentTradeSignal().buy, false);
  browser.LAST_MAP = {}; browser.ETF_TRACK.quote.price = 2.8;
  assert.equal(browser.etfCurrentTradeSignal().buy, false);
  browser.ETF_TRACK.quote.price = 2.94;
  browser.ETF_LOAD_ERR = 'request failed';
  assert.equal(browser.etfCurrentTradeSignal(), null);
  browser.ETF_LOAD_ERR = null;
  browser.ETF_TRACK.quote.quoteTime = '2026-11-05 13:01';
  assert.equal(browser.etfCurrentTradeSignal(), null);
});

test('标题四字状态优先高抛风险再低吸，支持QQQ上证异动并保留价格涨跌幅', () => {
  const browser = motionBrowser();
  browser.currentRoute = () => ({ view: 'etf' }); browser.document = { title: '' }; browser.DOC_TITLE_DEFAULT = '美股基金估值';
  browser.etfCurrentTradeSignal = () => ({ buy: true, sell: false });
  browser.etfMarketMotion = () => null;
  browser.ETF_TRACK = { quote: { price: 2.921, changePct: -0.85 } };
  vm.runInContext(declaration(html, 'updateDocTitle'), browser);
  browser.updateDocTitle();
  assert.equal(browser.document.title, '▼0.85% ¥2.9210 · 低吸候选');
  browser.etfMarketMotion = symbol => symbol === 'SSE' ? { kind: 'drop' } : null;
  assert.equal(browser.etfTitleStatus(), '上证急跌');
  browser.etfMarketMotion = symbol => symbol === 'QQQ' ? { kind: 'drop' } : null;
  assert.equal(browser.etfTitleStatus(), '外盘急跌');
  browser.etfCurrentTradeSignal = () => ({ sell: true });
  assert.equal(browser.etfTitleStatus(), '高抛候选');
  browser.etfCurrentTradeSignal = () => null;
  for (const symbol of ['SSE', 'QQQ']) for (const kind of ['surge', 'rebound']) {
    browser.etfMarketMotion = s => s === symbol ? { kind } : null;
    const state = browser.etfTitleStatus();
    assert.ok(state.length <= 4); assert.match(state, /急拉|反弹/);
  }
  browser.etfMarketMotion = symbol => ({ kind: symbol === 'QQQ' ? 'drop' : 'surge' });
  assert.equal(browser.etfTitleStatus(), '指数分歧');
  browser.etfMarketMotion = () => null;
  assert.equal(browser.etfTitleStatus(), '观察');
  browser.ETF_LOAD_ERR = 'failed'; assert.equal(browser.etfTitleStatus(), '数据过期');
  browser.currentRoute = () => ({ view: 'qdii' }); browser.updateDocTitle();
  assert.equal(browser.document.title, '美股基金估值');
});

test('ETF停牌时标题继续显示温和回升回落反弹，保留原ETF价格且不产生买卖信号', () => {
  for (const symbol of ['QQQ', 'SSE']) for (const direction of [1, -1]) {
    const browser = motionBrowser();
    browser.currentRoute = () => ({ view: 'etf' }); browser.document = { title: '' }; browser.DOC_TITLE_DEFAULT = '美股基金估值';
    browser.ETF_TRACK = { session: { trading: false }, quote: { price: 2.921, changePct: 0 } };
    const start = browser.Date.now() - 70000;
    const entry = sampleMotion(browser, Array.from({ length: 8 }, (_, i) => direction * i * 0.02), symbol, {}, start);
    assert.equal(entry.signal, null);
    assert.equal(entry.trend.kind, direction > 0 ? 'rise' : 'fall');
    vm.runInContext(declaration(html, 'updateDocTitle'), browser);
    browser.updateDocTitle();
    assert.match(browser.document.title, direction > 0 ? /回升$/ : /回落$/);
    assert.match(browser.document.title, /0.00% ¥2.9210/);
    assert.doesNotMatch(browser.document.title, /低吸|高抛/);
    assert.equal(browser.etfCurrentTradeSignal(), null);
  }
  const browser = motionBrowser();
  browser.ETF_TRACK = { session: { trading: false } };
  const entry = sampleMotion(browser, [0, -0.05, -0.10, -0.15, -0.18, -0.12, -0.06, 0], 'QQQ', {}, browser.Date.now() - 70000);
  assert.equal(entry.signal, null);
  assert.equal(entry.trend.kind, 'rebound');
  assert.equal(browser.etfTitleStatus(), '外盘反弹');
  browser.ETF_LOAD_ERR = 'ETF请求失败';
  assert.equal(browser.etfTitleStatus(), '外盘反弹');
  assert.equal(browser.etfMarketMotion('QQQ', browser.Date.now() + 60000, true), null);
});

test('停牌时指数方向分歧单独展示，过期报价和单点变化不冒充回升', () => {
  const browser = motionBrowser();
  const at = browser.Date.now();
  browser.ETF_MARKET_MOTION.QQQ = { at, trend: { kind: 'rise' } };
  browser.ETF_MARKET_MOTION.SSE = { at, trend: { kind: 'fall' } };
  assert.equal(browser.etfTitleStatus(), '指数分歧');
  browser.LAST_STALE = true;
  assert.equal(browser.etfTitleStatus(), '观察');
  const flat = motionBrowser();
  const entry = sampleMotion(flat, [0, 0, 0, 0, 0, 0, 0.2, 0.2], 'QQQ', {}, at - 70000);
  assert.equal(entry.trend, null);
  assert.equal(flat.etfTitleStatus(), '平稳观察');
});

test('指数标题更新不等待ETF请求，下一轮采样仍按十秒调度', async () => {
  let resolveETF;
  const pending = new Promise(resolve => { resolveETF = resolve; });
  const order = [];
  const browser = vm.createContext({ LAST_MAP: {}, LAST_STALE: false, etfLastLoadTs: 0, timer: null,
    fetchQuotes: async () => ({ map: { QQQ: {} }, stale: false }), etfSampleMarketMotion: () => order.push('sample'),
    updateDocTitle: () => order.push('title'), currentRoute: () => ({ view: 'etf' }),
    loadEtfTrack: () => { order.push('etf'); return pending; }, rerender: () => order.push('render'), clearTimeout() {},
    setTimeout: (_, ms) => { order.push(ms); return 1; }, console });
  vm.runInContext(declaration(html, 'pollLoop'), browser);
  await browser.pollLoop();
  assert.deepEqual(order, ['sample', 'title', 'etf', 'render', 10000]);
  resolveETF(); await Promise.resolve();
  assert.equal(order.at(-1), 'render');
});
