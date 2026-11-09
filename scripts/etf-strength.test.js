const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const context = vm.createContext({ PREMIUM_BUY: 18, premiumZone: () => ({ key: 'unknown' }), premiumPriceLadder: () => null });
vm.runInContext(['etfMinuteNumber', 'isEtfContinuousMinute', 'buildEtfIntradayBands', 'buildEtfIntradayGuide', 'buildEtfIntradayStrength', 'buildEtfChaseGate', 'buildEtfIntradaySignals', 'buildEtfAlerts'].map(n => declaration(server, n)).join('\n'), context);
const point = (time, price, avg = 3) => ({ t: time, price, avg, volume: 100 });
const weakPoints = [point('13:00', 2.99), point('13:01', 2.985), point('13:02', 2.98), point('13:03', 2.978), point('13:04', 2.973)];
const market = points => ({ today: '2026-11-09', intraday: { date: '2026-11-09', points }, quote: { quoteDate: '2026-11-09', quoteTime: '2026-11-09 13:05', price: points.at(-1).price, prevClose: 3, premiumPct: 40 },
  now: Date.parse('2026-11-09T13:05:00+08:00'), session: { trading: true }, positionPlan: { tier: 'try' }, ind: {}, signals: [] });
const plain = v => JSON.parse(JSON.stringify(v));

test('持续阴跌不要求先反弹，五个闭合分钟足够发走弱减仓预警', () => {
  const strength = context.buildEtfIntradayStrength(weakPoints, '2026-11-09');
  assert.equal(strength.events.length, 1);
  assert.equal(strength.events[0].time, '13:04');
  assert.equal(strength.events[0].side, 'sell');
  assert.match(strength.events[0].title, /持续走弱/);
  assert.equal(strength.current.kind, 'weak');
  assert.match(strength.current.label, /禁止追涨/);
  assert.equal(context.buildEtfIntradayStrength(weakPoints.slice(0, 4), '2026-11-09').events.length, 0);
});

test('快速破位无需先反弹，连续低于均价仍需确认', () => {
  const points = [point('13:00', 2.99), point('13:01', 2.98), point('13:02', 2.97), point('13:03', 2.96), point('13:04', 2.95)];
  const strength = context.buildEtfIntradayStrength(points, '2026-11-09');
  assert.equal(strength.current.kind, 'broken');
  assert.equal(strength.events[0].level, 'danger');
});

test('支撑破位需要历史支撑及连续两分钟确认，不使用未来低点', () => {
  const prices = [2.985, 2.984, 2.983, 2.984, 2.985, 2.982, 2.978, 2.977];
  const points = prices.map((price, i) => point(`13:${String(i).padStart(2, '0')}`, price));
  const before = context.buildEtfIntradayStrength(points.slice(0, 7), '2026-11-09');
  assert.ok(before.events.every(e => e.level !== 'danger'));
  const after = context.buildEtfIntradayStrength(points, '2026-11-09');
  assert.equal(after.events.find(e => e.level === 'danger').time, '13:07');
});

test('未达到均价持续条件的单点下跌不发减仓信号', () => {
  const points = [point('13:00', 3.01), point('13:01', 3.015), point('13:02', 3.012), point('13:03', 3.01), point('13:04', 2.95)];
  assert.equal(context.buildEtfIntradayStrength(points, '2026-11-09').events.length, 0);
});

test('持续走弱不每分钟重复，站回均价后可再次预警', () => {
  const more = [...weakPoints, ...Array.from({ length: 6 }, (_, i) => point(`13:${String(i + 5).padStart(2, '0')}`, 2.973 - i * .0001))];
  assert.equal(context.buildEtfIntradayStrength(more, '2026-11-09').events.length, 1);
  const recovered = [...more, ...Array.from({ length: 4 }, (_, i) => point(`13:${i + 11}`, 3.01)), ...Array.from({ length: 5 }, (_, i) => point(`13:${i + 15}`, 2.99 - i * .005))];
  assert.ok(context.buildEtfIntradayStrength(recovered, '2026-11-09').events.length >= 2);
});

test('偏强显示等回踩，不通过外盘上涨升级成买入', () => {
  const points = [point('13:00', 3.003), point('13:01', 3.005), point('13:02', 3.007), point('13:03', 3.009), point('13:04', 3.012)];
  const result = context.buildEtfIntradaySignals(market(points));
  assert.equal(result.strength.current.kind, 'strong');
  assert.equal(result.events.filter(e => e.side === 'buy').length, 0);
  assert.match(result.strength.chase, /不新增仓位/);
  const lowPremium = market(points); lowPremium.quote.premiumPct = 10;
  assert.match(context.buildEtfIntradaySignals(lowPremium).strength.chase, /不直接追涨/);
});

test('午休断档或均价缺失不能拼接走弱确认', () => {
  const gap = [point('11:29', 2.99), point('11:30', 2.985), point('13:00', 2.98), point('13:01', 2.975), point('13:02', 2.97)];
  assert.equal(context.buildEtfIntradayStrength(gap, '2026-11-09').events.length, 0);
  assert.equal(context.buildEtfIntradayStrength(weakPoints.map(p => ({ ...p, avg: null })), '2026-11-09').events.length, 0);
});

test('每个历史前缀的强弱和走弱事件不被后续走势修改', () => {
  const points = [...weakPoints, point('13:05', 3.1), point('13:06', 2.5), point('13:07', 2.4)];
  const full = context.buildEtfIntradayStrength(points, '2026-11-09');
  for (let n = 1; n <= points.length; n++) {
    const before = context.buildEtfIntradayStrength(points.slice(0, n), '2026-11-09');
    assert.deepEqual(plain(before.history), plain(full.history.slice(0, n)));
    assert.deepEqual(plain(before.events), plain(full.events.filter(e => e.time <= points[n - 1].t)));
  }
});

test('未闭合分钟不得生成强弱事件，盘后回放不发通知', () => {
  const ctx = market(weakPoints); ctx.quote.quoteTime = '2026-11-09 13:04';
  assert.equal(context.buildEtfIntradaySignals(ctx).strength.events.length, 0);
  ctx.quote.quoteTime = '2026-11-09 15:00'; ctx.session.trading = false;
  ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  assert.equal(ctx.intradaySignals.strength.events.length, 1);
  assert.equal(ctx.intradaySignals.actionable, false);
  assert.match(ctx.intradaySignals.strength.chase, /回看/);
  assert.ok(context.buildEtfAlerts(ctx).every(e => !e.key.startsWith('intraday_weak_')));
});

test('走弱预警进入实时alerts并附确认价格，不要求持仓信息', () => {
  const ctx = market(weakPoints); ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  const alert = context.buildEtfAlerts(ctx).find(e => e.key.startsWith('intraday_weak_'));
  assert.ok(alert);
  assert.equal(alert.price, 2.973);
  assert.match(alert.title, /已有仓位/);
  assert.equal(ctx.intradaySignals.guide.buyState, '走弱 · 禁止追买');
});

test('过期行情即使分钟相近也不能发走弱实时通知', () => {
  const ctx = market(weakPoints); ctx.now += 180000;
  ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  assert.equal(ctx.intradaySignals.actionable, false);
  assert.ok(context.buildEtfAlerts(ctx).every(e => !e.key.startsWith('intraday_weak_')));
  ctx.now -= 180000; ctx.stale = true;
  assert.equal(context.buildEtfIntradaySignals(ctx).actionable, false);
});

test('走弱升级为破位不等待再次10分钟，持续破位不重复', () => {
  const points = [...weakPoints, point('13:05', 2.96), point('13:06', 2.95), point('13:07', 2.94)];
  const events = context.buildEtfIntradayStrength(points, '2026-11-09').events;
  assert.equal(events[0].level, 'warn');
  assert.equal(events[1].level, 'danger');
  assert.equal(events.length, 2);
});

test('ETF持续偏弱即使外盘涨也优先显示禁止追涨标题', () => {
  const browser = vm.createContext({ etfCurrentTradeSignal: () => ({ reduceRisk: true }), etfMarketMotion: () => null });
  vm.runInContext(declaration(html, 'etfTitleStatus'), browser);
  assert.equal(browser.etfTitleStatus(), '走弱减仓');
  browser.etfCurrentTradeSignal = () => ({ weakness: { kind: 'weak' } });
  assert.equal(browser.etfTitleStatus(), '偏弱勿追');
});

test('走弱事件使已存买入信号即时降为观察而非继续提示买入', () => {
  const ctx = market(weakPoints); ctx.quote.premiumPct = 17;
  ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  ctx.intradaySignals.events.push({ key: 'intraday_rebound_fake', time: '13:04', side: 'buy', title: '买入候选' });
  const event = context.buildEtfAlerts(ctx).find(e => e.key === 'intraday_rebound_fake');
  assert.equal(event.side, 'watch');
  assert.match(event.title, /禁止买入/);
});

test('图表显示强弱和减仓价格，偏弱仍保留回放标记而非当前买入', () => {
  const ctx = market(weakPoints); ctx.session.trading = false; ctx.intradaySignals = context.buildEtfIntradaySignals(ctx);
  const browser = vm.createContext({ ETF_TRACK: ctx, etfChartWidth: () => 360, escHtml: String, etfHeroHtml: () => '', etfSessionQuoteHtml: () => '', etfMarketLinkHtml: () => '', etfQuoteInlineHtml: () => '' });
  vm.runInContext(['etfIntradayOffset', 'etfChaseGateHtml', 'etfIntradayHtml'].map(n => declaration(html, n)).join('\n'), browser);
  const rendered = browser.etfIntradayHtml();
  assert.match(rendered, /data-etf-strength/);
  assert.match(rendered, /偏弱 · 禁止追涨/);
  assert.match(rendered, /减 2.973/);
  assert.match(rendered, /（回放）/);
  assert.match(rendered, /偏强不等于允许买入/);
});
