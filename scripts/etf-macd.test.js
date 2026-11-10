const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const context = vm.createContext({});
vm.runInContext(['calcEMA', 'calcMACD', 'etfIntradayBar', 'etfLiveMacdBars'].map(n => declaration(server, n)).join('\n'), context);
const today = '2026-11-09';
const history = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10), close: 3 + Math.sin(i / 4) * 0.1 }));
history[history.length - 1].date = '2026-11-06';
const input = () => ({ bars: context.calcMACD(history, 60), session: { realtime: true, trading: true }, quote: { quoteDate: today, price: 2.82, volume: 100 } });

test('日K还没更新时新增今天的估算柱，isToday为真', () => {
  const data = input();
  const result = context.etfLiveMacdBars(data, history, today, new Date('2026-11-09T03:00:00Z'));
  assert.equal(result.bars.length, 60);
  assert.equal(result.bars.at(-1).date, today);
  assert.equal(result.bars.at(-1).close, 2.82);
  assert.equal(result.bars.at(-1).intraday, true);
  assert.equal(result.todayBar.isToday, true);
  assert.equal(data.bars.at(-1).date, '2026-11-06');
  assert.equal(history.at(-1).date, '2026-11-06');
  assert.equal(result.bars.at(-1).bar, context.calcMACD([...history, { date: today, close: 2.82 }], 60).at(-1).bar);
});

test('今日K已存在则覆盖不重复，实时价变化重新计算', () => {
  const rows = [...history, { date: today, close: 2.7 }];
  const data = input(); data.bars = context.calcMACD(rows, 60);
  const result = context.etfLiveMacdBars(data, rows, today, new Date('2026-11-09T03:00:00Z'));
  assert.equal(result.bars.filter(b => b.date === today).length, 1);
  assert.equal(result.bars.at(-1).close, 2.82);
  data.quote.price = 2.9;
  assert.notEqual(context.etfLiveMacdBars(data, rows, today, new Date('2026-11-09T03:00:00Z')).bars.at(-1).bar, result.bars.at(-1).bar);
});

test('午休仍保留今天估算柱，不因为session.trading=false丢失', () => {
  const data = input(); data.session.trading = false;
  const result = context.etfLiveMacdBars(data, history, today, new Date('2026-11-09T04:00:00Z'));
  assert.equal(result.bars.at(-1).date, today);
  assert.equal(result.bars.at(-1).intraday, true);
});

test('停牌无今日成交或旧行情不伪造今天柱', () => {
  const data = input(); data.quote.volume = 0;
  assert.equal(context.etfLiveMacdBars(data, history, today).todayBar, null);
  data.quote.volume = 100; data.quote.quoteDate = '2026-11-06';
  assert.equal(context.etfLiveMacdBars(data, history, today).todayBar, null);
  data.quote.quoteDate = today; data.session.realtime = false;
  assert.equal(context.etfLiveMacdBars(data, history, today).todayBar, null);
});

test('盘后日K未补齐时保留收盘估算，正式K补齐后回正式柱', () => {
  const data = input(), now = new Date('2026-11-09T07:10:00Z');
  const result = context.etfLiveMacdBars(data, history, today, now);
  assert.equal(result.bars.at(-1).estimated, true);
  assert.equal(result.bars.at(-1).intraday, false);
  const rows = [...history, { date: today, close: 2.82 }]; data.bars = context.calcMACD(rows, 60);
  assert.equal(context.etfLiveMacdBars(data, rows, today, now).bars, data.bars);
});

test('非正价格、null及数据不足不生成MACD', () => {
  for (const price of [null, NaN, 0, -1]) assert.equal(context.etfIntradayBar(history, price, today), null);
  assert.equal(context.etfIntradayBar(history.slice(0, 10), 2.82, today), null);
});

test('图表末日期标今天和盘中状态，并显示估算说明', () => {
  const result = context.etfLiveMacdBars(input(), history, today, new Date('2026-11-09T03:00:00Z'));
  const browser = vm.createContext({ ETF_TRACK: { bars: result.bars } });
  vm.runInContext(['etfMacdBarsHtml', 'etfMacdHtml'].map(n => declaration(html, n)).join('\n'), browser);
  const rendered = browser.etfMacdHtml();
  assert.match(rendered, /11\/9 · 盘中/);
  assert.match(rendered, /盘中估算，收盘前会变化/);
  assert.match(rendered, /今日实时成交价/);
  assert.match(rendered, /macd-bar neg intraday|macd-bar pos intraday/);
});

const premiumContext = vm.createContext({});
const premiumConstants = ['PREMIUM_ADD', 'PREMIUM_BUY', 'PREMIUM_WATCH', 'PREMIUM_DANGER', 'POS_MA_BUF', 'POS_BELOW_N', 'US_TREND_MA50_WIN', 'US_TREND_REPAIR_PCT', 'POS_US_BAD_CAP', 'POS_TRY_CAP', 'POS_RUN_CAP', 'POS_MAX_NOT_HEAVY', 'POS_PANIC_CAP', 'POS_PANIC_CAP_ADD', 'PANIC_US_GRACE_DAYS', 'PANIC_TRIGGER'];
vm.runInContext([
  ...premiumConstants.map(name => server.match(new RegExp(`^const ${name} =[^\\n]+`, 'm'))[0]),
  ...['PREMIUM_ZONES', 'POS_FACTOR_TABLE'].map(name => server.match(new RegExp(`^const ${name} = \\[[^]*?^\\];`, 'm'))[0]),
  ...['calcEMA', 'calcMACD', 'movingAvgSeries', 'williamsRSeries', 'bollingerSeries', 'premiumZone', 'buildUsTrendState', 'buildHeavyGate', 'buildEtfPositionSeries', 'buildEtfPositionPlan', 'buildEtfCompositeSignals', 'buildEtfAdvice'].map(name => declaration(server, name)),
].join('\n'), premiumContext);
const plain = value => JSON.parse(JSON.stringify(value));
const premiums = [10, 20, 40, null];
const trendRows = Array.from({ length: 150 }, (_, i) => {
  const close = i < 80 ? 3 + i * 0.01 + i * i * 0.0001
    : i < 105 ? 2 + (i - 80) * 0.002
      : i < 135 ? 2.05 + (i - 105) * 0.025 : 2.8 - (i - 135) * 0.035;
  return { date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close, high: close + 0.02, low: close - 0.02 };
});
const navFor = (rows, premium) => premium == null ? {} : Object.fromEntries(rows.map(row => [row.date, row.close / (1 + premium / 100)]));
const positionFields = rows => plain(rows.map(row => row && ({ date: row.date, state: row.state, tier: row.tier, cap: row.cap, factor: row.factor, target: row.target, panic: row.panic, panicAdded: row.panicAdded, panicLapsed: row.panicLapsed })));

test('同一走势在10%、20%、40%及缺失溢价时历史和实时仓位完全一致', () => {
  const baseline = premiumContext.buildEtfPositionSeries(trendRows, navFor(trendRows, 10));
  assert.ok(baseline.some(row => row && row.tier === 'heavy' && row.target === 1));
  for (const premium of premiums) {
    const nav = navFor(trendRows, premium);
    const historical = premiumContext.buildEtfPositionSeries(trendRows, nav);
    const live = { date: trendRows.at(-1).date, price: trendRows.at(-1).close, premiumPct: premium };
    const realtime = premiumContext.buildEtfPositionSeries(trendRows, nav, live);
    assert.deepEqual(positionFields(historical), positionFields(baseline));
    assert.deepEqual(positionFields(realtime), positionFields(baseline));
    assert.ok(historical.filter(Boolean).every(row => row.factor === 1));
    assert.equal(realtime.at(-1).premium, premium);
  }
});

test('试仓和跑路档保留20%与10%上限，不因低溢价放宽', () => {
  for (const premium of premiums) {
    const series = premiumContext.buildEtfPositionSeries(trendRows, navFor(trendRows, premium));
    const tries = series.filter(row => row && row.tier === 'try');
    const runs = series.filter(row => row && row.tier === 'run');
    assert.ok(tries.length > 0);
    assert.ok(runs.length > 0);
    assert.ok(tries.every(row => row.cap === 0.2 && row.target === 0.2));
    assert.ok(runs.every(row => row.cap <= 0.1 && row.target <= 0.1));
  }
});

test('高溢价与缺失溢价恐慌窗口执行相同仓位，仍保留确认有效期', () => {
  const rows = trendRows.slice(0, 100);
  const active = new Set(rows.slice(80).map(row => row.date));
  const baseline = premiumContext.buildEtfPositionSeries(rows, navFor(rows, 10), null, active);
  assert.equal(baseline[80].target, 0.2);
  assert.equal(baseline[80].panicAdded, false);
  assert.equal(baseline[90].panicLapsed, true);
  assert.ok(baseline[90].target <= 0.1);
  for (const premium of premiums) {
    const series = premiumContext.buildEtfPositionSeries(rows, navFor(rows, premium), null, active);
    assert.deepEqual(positionFields(series), positionFields(baseline));
    const plan = premiumContext.buildEtfPositionPlan(rows, navFor(rows, premium), null, { active });
    assert.match(plan.action, /抄底未确认 · 撤回/);
    assert.equal(plan.posPct, Math.round(series.at(-1).target * 100));
  }
});

test('健康趋势仓位计划不因高溢价减仓或暂停加仓，仍展示技术触发线', () => {
  const rows = trendRows.slice(0, 80);
  const baseline = premiumContext.buildEtfPositionPlan(rows, navFor(rows, 10));
  assert.equal(baseline.tier, 'heavy');
  assert.equal(baseline.posPct, 100);
  for (const premium of premiums) {
    const plan = premiumContext.buildEtfPositionPlan(rows, navFor(rows, premium));
    assert.equal(plan.action, baseline.action);
    assert.equal(plan.headline, baseline.headline);
    assert.equal(plan.posPct, 100);
    assert.equal(plan.premiumFactor, 1);
    assert.ok(plan.triggers.some(trigger => trigger.label.includes('MA21')));
    assert.ok(plan.triggers.every(trigger => !trigger.label.includes('溢价')));
    assert.doesNotMatch(plan.action + plan.headline + plan.entryNote, /溢价.*(?:减仓|暂停加仓|不加仓|等溢价回落)/);
  }
});

test('买点确认只看回调过滤，今日建议采用趋势计划而不受溢价影响', () => {
  const rows = trendRows.slice(0, 80);
  const bars = premiumContext.calcMACD(rows, rows.length);
  const closes = rows.map(row => row.close);
  const price = rows.at(-1).close;
  const base = { price, ma21: premiumContext.movingAvgSeries(closes, 21).at(-1), bar: bars.at(-1).bar, bollMid: premiumContext.bollingerSeries(closes).mid.at(-1) };
  for (const willR of [-70, -10]) {
    let baseline;
    for (const premium of premiums) {
      const positionPlan = premiumContext.buildEtfPositionPlan(rows, navFor(rows, premium));
      const advice = premiumContext.buildEtfAdvice({ quote: { price, premiumPct: premium, iopv: premium == null ? null : price / (1 + premium / 100) }, ind: { ...base, willR }, positionPlan });
      assert.equal(advice.confirm.level, willR === -70 ? 'good' : 'chasing');
      assert.equal(advice.action, positionPlan.action);
      assert.equal(advice.headline, positionPlan.headline);
      assert.equal(advice.level, 'hold');
      if (baseline) assert.deepEqual(plain(advice.confirm), baseline);
      else baseline = plain(advice.confirm);
    }
  }
});

test('组合买卖信号在不同溢价及缺失净值时一致，价格破位仍清仓', () => {
  const rows = trendRows.map((row, i) => ({ ...row, high: i === 70 ? row.close + 1 : row.high }));
  const fields = result => plain(result.signals.map(signal => ({ date: signal.date, endDate: signal.endDate, code: signal.code, side: signal.side, posPct: signal.posPct, evidence: signal.evidence.filter(value => !value.startsWith('溢价 ')) })));
  const baseline = premiumContext.buildEtfCompositeSignals(rows, navFor(rows, 10));
  const gates = premiumContext.buildHeavyGate(rows);
  const watchIndexes = gates.flatMap((gate, i) => gate && gate.tier === 'watch' && i >= 35 ? [i] : []);
  assert.ok(watchIndexes.length > 0);
  assert.ok(baseline.signals.some(signal => signal.side === 'buy' && gates[signal.idx].tier === 'heavy' && signal.evidence.some(value => value.startsWith('威廉%R '))));
  assert.ok(baseline.signals.some(signal => signal.code === 'sell_run' && signal.side === 'sell'));
  for (const premium of premiums) {
    const result = premiumContext.buildEtfCompositeSignals(rows, navFor(rows, premium));
    assert.deepEqual(fields(result), fields(baseline));
    for (const index of watchIndexes) {
      assert.ok(result.signals.filter(signal => signal.idx <= index && index <= signal.endIdx).every(signal => signal.side !== 'buy'));
    }
    if (premium == null) assert.ok(result.signals.every(signal => signal.premium == null));
  }
});
