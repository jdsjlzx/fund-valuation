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

const quoteNow = Date.parse('2026-11-10T02:53:00Z');
class QuoteDate extends Date { static now() { return quoteNow; } }
// 切片里含 FUT_HIST_FILE = path.join(__dirname, ...)，vm 上下文必须提供 path/__dirname，
// 否则整个文件在装载时就 ReferenceError（18 个夜盘用例曾经全部静默不执行）。
const vmBase = { Date: QuoteDate, path, __dirname: path.join(__dirname, '..'),
  FUTURES_PROXY: { QQQ: 'NQ', SPY: 'ES' }, stockFuturesProxy: () => ({ beta: 1, futSym: 'NQ' }) };
const overnightContext = vm.createContext({ ...vmBase, XUEQIU_ETF_MAX_LAG_MS: 300000 });
vm.runInContext(server.slice(server.indexOf('function computeOvernightQuote('), server.indexOf("app.get('/api/quotes'")), overnightContext);
const overnight = overrides => overnightContext.computeOvernightQuote({ symbol: 'QQQ', closeForOvernight: 679.35,
  overnightSessionStart: Date.parse('2026-11-10T01:00:00Z'),
  xq: { currentNight: 678.34, percentNight: -0.1487, timestampNight: Date.parse('2026-11-10T02:02:12Z') },
  // 20:00 ET 盘后收盘价 678.0（-0.20%），期货历史见 setFutHist()
  sina: { postMarketChangePercent: -0.2, regularMarketPrice: 679.35 },
  etfFut: { chgPct: -0.3, price: 20030, sourceTimeMs: quoteNow - 10000 }, ...overrides });
// 期货历史：20:00 ET 起点 20000，之后只按价格比算增量
const setFutHist = (ctx, arr) => vm.runInContext(`SINA_FUTURES_HIST.set('NQ', ${JSON.stringify(arr)})`, ctx);
setFutHist(overnightContext, [
  { ts: Date.parse('2026-11-10T01:00:00Z'), price: 20000 },
  { ts: quoteNow - 10 * 60_000, price: 20040 },
]);

test('Yahoo分钟价格与其时间配对，不使用fullday或regularMarketTime拼接', () => {
  const ctx = vm.createContext({});
  vm.runInContext(declaration(server, 'yahooExtendedTick'), ctx);
  const result = { meta: { regularMarketTime: 100, fulldayPrice: 999 }, timestamp: [90, 110, 120],
    indicators: { quote: [{ close: [679, 678, null] }] } };
  const tick = ctx.yahooExtendedTick(result);
  assert.equal(tick.extendedPrice, 678);
  assert.equal(tick.extendedTime, 110);
  result.timestamp = [90];
  assert.equal(ctx.yahooExtendedTick(result).extendedPrice, null);
});

test('本轮雪球锚点滞后 50 分钟仍在漂移窗内，用期货增量修正而不是退回纯期货', () => {
  const q = overnight();
  assert.equal(q.overnightSource, 'xueqiu-drift');
  assert.equal(q.overnightEstimated, true);
  assert.equal(q.overnightStale, false);
  assert.equal(q.overnightAsOf, quoteNow);
  // 20030 / 20000 - 1 = +0.15%
  assert.ok(Math.abs(q.overnightChangePercent - (-0.1487 + 0.15)) < 1e-9);
});

test('纯期货估算以盘后收盘价为基准，只用 20:00 之后的期货增量', () => {
  const q = overnight({ xq: null });
  assert.equal(q.overnightSource, 'futures');
  // 盘后 -0.20% + 自 20:00 的 +0.15% = -0.05%；不能再把期货相对结算的 -0.30% 套在收盘价上
  assert.ok(Math.abs(q.overnightChangePercent - (-0.05)) < 1e-9);
  assert.equal(q.overnightEstimated, true);
  assert.equal(q.overnightAsOf, quoteNow - 10000);
  const noPost = overnight({ xq: null, sina: { regularMarketPrice: 679.35 } });
  assert.equal(noPost.overnightSource, 'unavailable');
});

test('真实夜盘择新，不让旧雪球tick压过扩展或Yahoo成交', () => {
  const xq = { currentNight: 678.34, percentNight: -0.1487, timestampNight: quoteNow - 120000,
    currentExt: 678.5, percentExt: -0.125, timestampExt: quoteNow - 60000 };
  assert.equal(overnight({ xq }).overnightSource, 'xueqiu-ext');
  const yahoo = { extendedPrice: 679.35, extendedTime: (quoteNow - 30000) / 1000, fulldayPrice: 681, fulldayChangePercent: 3.54 };
  const q = overnight({ xq, yahoo });
  assert.equal(q.overnightSource, 'yahoo');
  assert.equal(q.overnightChangePercent, 0);
  assert.equal(q.overnightAsOf, quoteNow - 30000);
  assert.equal(q.overnightEstimated, false);
});

test('Yahoo无成交时间不能用价差猜测夜盘，过期和未来时间也不可采信', () => {
  for (const extendedTime of [undefined, (quoteNow - 3600000) / 1000, (quoteNow + 60000) / 1000]) {
    assert.equal(overnight({ yahoo: { extendedPrice: 678.79, extendedTime } }).overnightSource, 'xueqiu-drift');
  }
  assert.equal(overnight({ xq: null, yahoo: { extendedPrice: 678.79, extendedTime: quoteNow / 1000, stale: true } }).overnightSource, 'futures');
});

test('盘后和上轮成交不可冒充本轮夜盘，未来雪球时间亦不可用', () => {
  for (const at of [Date.parse('2026-11-10T00:59:59Z'), quoteNow + 60000]) {
    const q = overnight({ xq: { currentNight: 678.34, timestampNight: at, currentExt: 678.22, timestampExt: at } });
    assert.equal(q.overnightSource, 'futures');
    assert.ok(Math.abs(q.overnightChangePercent - (-0.05)) < 1e-9);
  }
});

test('期货报价过期时不能拿它漂移：保留本轮旧成交并标滞后', () => {
  const q = overnight({ etfFut: { chgPct: -0.3, price: 20030, sourceTimeMs: quoteNow - 40 * 60_000 } });
  assert.equal(q.overnightSource, 'xueqiu');
  assert.equal(q.overnightStale, true);
  assert.equal(q.overnightPrice, 678.34);
  assert.equal(q.overnightLagMin, 50);
  const missing = overnight({ xq: null, etfFut: null });
  assert.equal(missing.overnightSource, 'unavailable');
  assert.equal(missing.overnightChangePercent, null);
});

// ── 雪球锚点 + 期货增量漂移：雪球夜盘 ~20 分钟一批，批次间隔内用期货增量修正旧锚 ──
const driftContext = vm.createContext({ ...vmBase, XUEQIU_ETF_MAX_LAG_MS: 30 * 60_000 });
vm.runInContext(server.slice(server.indexOf('function computeOvernightQuote('), server.indexOf("app.get('/api/quotes'")), driftContext);
const driftQuote = overrides => driftContext.computeOvernightQuote({ symbol: 'QQQ', closeForOvernight: 679.35,
  overnightSessionStart: Date.parse('2026-11-10T01:00:00Z'),
  // 雪球锚 20 分钟前：仍在 30 分钟采信窗内，但已超过 90 秒漂移阈值
  xq: { currentNight: 678.34, percentNight: -0.1487, timestampNight: quoteNow - 20 * 60_000 },
  sina: { postMarketChangePercent: -0.2, regularMarketPrice: 679.35 },
  etfFut: { chgPct: -0.30, price: 20030, sourceTimeMs: quoteNow - 10000 }, ...overrides });

test('雪球锚点滞后超90秒时叠加期货增量漂移，增量按价格比而非昨结涨跌', () => {
  setFutHist(driftContext, [
    { ts: Date.parse('2026-11-10T02:00:00Z'), price: 20000 },
    { ts: quoteNow - 10 * 60_000, price: 20060 },
  ]);
  const q = driftQuote();
  assert.equal(q.overnightSource, 'xueqiu-drift');
  assert.equal(q.overnightEstimated, true);
  assert.equal(q.overnightStale, false);
  // 锚点取 ≤ 雪球批次时刻的最近期货价（02:00 的 20000，不是 02:43 的 20060）
  // 20030 / 20000 - 1 = +0.15%；chgPct 的 -0.30 完全不参与
  assert.ok(Math.abs(q.overnightChangePercent - (-0.1487 + 0.15)) < 1e-9);
  assert.equal(q.overnightLagMin, 0);
});

test('期货历史晚于锚点时用最早一条兜底漂移，避免重启后整批冻结', () => {
  setFutHist(driftContext, [{ ts: quoteNow - 30000, price: 20000 }]);
  const q = driftQuote();
  assert.equal(q.overnightSource, 'xueqiu-drift');
  assert.ok(Math.abs(q.overnightChangePercent - (-0.1487 + 0.15)) < 1e-9);
});

test('锚点超过 3 小时漂移窗时不再用期货硬修，改回纯期货估算', () => {
  setFutHist(driftContext, [{ ts: quoteNow - 3.5 * 3600_000, price: 20000 }]);
  const q = driftQuote({ xq: { currentNight: 678.34, percentNight: -0.1487, timestampNight: quoteNow - 4 * 3600_000 } });
  assert.equal(q.overnightSource, 'futures');
  // 盘后 -0.20% + 自 20:00 的 +0.15%
  assert.ok(Math.abs(q.overnightChangePercent - (-0.05)) < 1e-9);
});

test('稀疏个股旧成交仍保留，但必须标明滞后', () => {
  const q = overnight({ symbol: 'NVDA', etfFut: null });
  assert.equal(q.overnightSource, 'xueqiu');
  assert.equal(q.overnightEstimated, false);
  assert.equal(q.overnightStale, true);
});

test('雪球代理完整透传扩展报价时间并支持仅扩展行情', async () => {
  const ctx = vm.createContext({ HIST_PROXY_URL: 'https://proxy.test',
    httpGet: async () => JSON.stringify({ currentNight: null, currentExt: 678.5, timestampExt: quoteNow }) });
  vm.runInContext(server.match(/^async function fetchXueqiuViaProxy\([^]*?^\}/m)[0], ctx);
  assert.equal((await ctx.fetchXueqiuViaProxy('QQQ')).timestampExt, quoteNow);
  const handler = require('../api/night');
  const original = global.fetch;
  global.fetch = async url => url.endsWith('/hq') ? { headers: { getSetCookie: () => [] } }
    : { ok: true, text: async () => JSON.stringify({ data: { quote: { current_night_session: null, current_ext: 678.5, timestamp_ext: quoteNow } } }) };
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
  try { await handler({ query: { symbol: 'QQQ' } }, res); } finally { global.fetch = original; }
  assert.equal(res.code, 200);
  assert.equal(res.body.timestampExt, quoteNow);
});

test('纳指科技行情头显示估算来源和北京时间，旧成交显示滞后', () => {
  const browser = vm.createContext({ Date: QuoteDate, LAST_STALE: false, LAST_MAP: { QQQ: { marketState: 'OVERNIGHT', ...overnight({ xq: null }) } },
    effectiveChange: q => q?.overnightChangePercent, cls: () => 'down', fmtPct: v => v.toFixed(2) + '%', etfMarketMotionBadgeHtml: () => '' });
  vm.runInContext(html.slice(html.indexOf('function etfHeroHtml('), html.indexOf('function etfSessionQuoteHtml(')), browser);
  assert.match(browser.etfHeroHtml(), /NQ期货估算 · 10:52/);
  browser.LAST_MAP.QQQ = { marketState: 'OVERNIGHT', ...overnight() };
  assert.match(browser.etfHeroHtml(), /雪球\+NQ漂移/);
  browser.LAST_MAP.QQQ = { marketState: 'OVERNIGHT', ...overnight({ etfFut: null }) };
  assert.match(browser.etfHeroHtml(), /雪球 · 10:02 · 滞后50分钟/);
  browser.LAST_MAP.QQQ = { marketState: 'OVERNIGHT', ...overnight({ xq: null, etfFut: null }) };
  assert.match(browser.etfHeroHtml(), /夜盘数据不可用/);
  assert.match(browser.etfHeroHtml(), />--<\/b>/);
});

test('前端夜盘时间在夏令时切换周不偏移一小时', () => {
  const browser = vm.createContext({});
  vm.runInContext(declaration(html, 'fmtEtHm'), browser);
  assert.equal(browser.fmtEtHm(Date.parse('2026-03-06T14:30:00Z')), '09:30 ET');
  assert.equal(browser.fmtEtHm(Date.parse('2026-03-09T13:30:00Z')), '09:30 ET');
  assert.equal(browser.fmtEtHm(Date.parse('2026-11-09T02:11:00Z')), '21:11 ET');
});

test('有 Blue Ocean 直连报价时优先用真实夜盘价，不再漂移也不标估算', () => {
  // ATS 报价（实时指示中价）比雪球批次新，且是真实成交盘口，应直接胜出
  const q = overnight({ alpaca: { price: 678.9, at: quoteNow - 5000, bid: 678.88, ask: 678.92 } });
  assert.equal(q.overnightSource, 'alpaca');
  assert.equal(q.overnightEstimated, false);
  assert.equal(q.overnightStale, false);
  assert.equal(q.overnightPrice, 678.9);
  assert.ok(Math.abs(q.overnightChangePercent - (678.9 / 679.35 - 1) * 100) < 1e-9);
});

test('ATS 报价超出本轮夜盘或缺失时不影响原有链路', () => {
  // 上一轮的旧 ATS 报价不可采信
  const old = overnight({ alpaca: { price: 678.9, at: Date.parse('2026-11-10T00:30:00Z') } });
  assert.notEqual(old.overnightSource, 'alpaca');
  // 没有 key / 未配置时 alpaca 为 undefined，退回雪球漂移
  const none = overnight({ alpaca: null });
  assert.ok(['xueqiu', 'xueqiu-drift', 'futures'].includes(none.overnightSource));
});
