const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const declaration = (source, name) => source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))[0];
const context = vm.createContext({});
vm.runInContext(['usMarketClock', 'getUSMarketState', 'usOvernightSessionStart'].map(n => declaration(server, n)).join('\n'), context);
const state = iso => context.getUSMarketState(new Date(iso));

test('美东周日20点后夜盘开始，对应北京时间周一9点', () => {
  assert.equal(state('2026-11-09T00:59:59Z'), 'CLOSED');
  assert.equal(state('2026-11-09T01:00:00Z'), 'OVERNIGHT');
  assert.equal(state('2026-11-09T02:11:00Z'), 'OVERNIGHT');
  assert.equal(state('2026-11-09T05:00:00Z'), 'OVERNIGHT');
  assert.equal(state('2026-11-09T09:00:00Z'), 'PRE');
});

test('周五盘后结束到周日20点保持休市，不伪造周五夜盘', () => {
  assert.equal(state('2026-11-07T00:59:59Z'), 'POST');
  assert.equal(state('2026-11-07T01:00:00Z'), 'CLOSED');
  assert.equal(state('2026-11-07T15:00:00Z'), 'CLOSED');
  assert.equal(state('2026-11-08T18:00:00Z'), 'CLOSED');
});

test('夏令时开始和结束周按美东实际时区而不是月份判断', () => {
  assert.equal(state('2026-03-06T14:29:59Z'), 'PRE');
  assert.equal(state('2026-03-06T14:30:00Z'), 'REGULAR');
  assert.equal(state('2026-03-09T13:30:00Z'), 'REGULAR');
  assert.equal(state('2026-10-30T13:30:00Z'), 'REGULAR');
  assert.equal(state('2026-11-02T13:30:00Z'), 'PRE');
  assert.equal(state('2026-11-02T14:30:00Z'), 'REGULAR');
});

test('周中盘前正规盘盘后夜盘边界准确', () => {
  assert.equal(state('2026-11-10T09:00:00Z'), 'PRE');
  assert.equal(state('2026-11-10T14:30:00Z'), 'REGULAR');
  assert.equal(state('2026-11-10T21:00:00Z'), 'POST');
  assert.equal(state('2026-11-11T01:00:00Z'), 'OVERNIGHT');
});

test('本轮夜盘起点跨周末及夏令时正确，用于识别新鲜雪球报价', () => {
  const start = iso => new Date(context.usOvernightSessionStart(new Date(iso))).toISOString();
  assert.equal(start('2026-11-09T02:11:00Z'), '2026-11-09T01:00:00.000Z');
  assert.equal(start('2026-11-09T08:59:00Z'), '2026-11-09T01:00:00.000Z');
  assert.equal(start('2026-03-09T01:00:00Z'), '2026-03-09T00:00:00.000Z');
  assert.equal(start('2026-11-02T02:00:00Z'), '2026-11-02T01:00:00.000Z');
});

test('Yahoo快照不继续沿用过期扩展报价', () => {
  const cache = new Map([['QQQ', { data: { fulldayPrice: 660 }, ts: Date.now() - 180000 }], ['NVDA', { data: { fulldayPrice: 185 }, ts: Date.now() }]]);
  const ctx = vm.createContext({ yahooExtCache: cache, YAHOO_EXT_TTL: 120000 });
  vm.runInContext(declaration(server, 'yahooExtSnapshot'), ctx);
  const snapshot = ctx.yahooExtSnapshot(['QQQ', 'NVDA']);
  assert.equal(snapshot.has('QQQ'), false);
  assert.equal(snapshot.has('NVDA'), true);
});

test('盘前涨跌基于最新正规盘收盘，不叠加上一交易日涨幅', () => {
  const block = server.match(/        if \(usState === 'PRE'\) \{[\s\S]*?\n        \}/)[0];
  const ctx = vm.createContext({ usState: 'PRE', em: { symbol: 'QQQ', regularMarketPrice: 656.1 },
    yhExtData: new Map([['QQQ', { fulldayPrice: 659.7, regularMarketPrice: 656.1, previousClose: 647.05, fulldayChangePercent: 1.615 }]]),
    sina: { postMarketChangePercent: 0, afterHoursPrice: null } });
  const result = vm.runInContext(`(function () { ${block} })()`, ctx);
  assert.ok(Math.abs(result.preMarketChangePercent - (659.7 / 656.1 - 1) * 100) < 1e-10);
  assert.equal(result.closePrice, 656.1);
  assert.equal(result.regularMarketPreviousClose, 656.1);
});

test('前端夜盘时间在夏令时切换周不偏移一小时', () => {
  const browser = vm.createContext({});
  vm.runInContext(declaration(html, 'fmtEtHm'), browser);
  assert.equal(browser.fmtEtHm(Date.parse('2026-03-06T14:30:00Z')), '09:30 ET');
  assert.equal(browser.fmtEtHm(Date.parse('2026-03-09T13:30:00Z')), '09:30 ET');
  assert.equal(browser.fmtEtHm(Date.parse('2026-11-09T02:11:00Z')), '21:11 ET');
});
