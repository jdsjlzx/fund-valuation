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
