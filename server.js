const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════
//  Fund roster (display name → eastmoney code)
// ═══════════════════════════════════════════════════════
const FUND_LIST = [
  { name: '华宝纳斯达克精选',      code: '017436' },
  { name: '浦银安盛全球智能科技',  code: '006555' },
  { name: '广发全球精选',          code: '270023' },
  { name: '嘉实全球产业升级',      code: '017730' },
  { name: '嘉实美国成长',          code: '000043' },
  { name: '易方达全球成长精选',    code: '012920' },
  { name: '国富全球科技互联',      code: '006373' },
  { name: '国富亚洲机会股票',      code: '457001' },
  { name: '建信新兴市场混合',      code: '539002' },
  { name: '汇添富全球移动互联',    code: '001668' },
  { name: '华夏全球科技先锋',      code: '005698' },
  { name: '华夏移动互联',          code: '002891' },
  { name: '银华海外数字经济',      code: '016701' },
  { name: '长城全球新能源车',      code: '501226' },
  { name: '华宝海外新能源汽车',    code: '017144' },
  { name: '华宝海外科技',          code: '501312' },
  { name: '华宝致远混合',          code: '008253' },
  { name: '景顺长城纳斯达克科技',  code: '017091' },
  { name: '天弘全球高端制造',      code: '016664' },
  { name: '富国全球科技互联网',    code: '100055' },
  { name: '中银全球策略',          code: '163813' },
  { name: '天弘全球新能源汽车',    code: '016823' },
  { name: '华夏新时代混合(QDII)', code: '005534' },
  { name: '华夏大中华混合(QDII)', code: '002230' },
];

// ═══════════════════════════════════════════════════════
//  HTTP helper with GBK→UTF-8 decoding (eastmoney uses GBK)
// ═══════════════════════════════════════════════════════
function httpGet(url, headers = {}) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          ...headers,
        },
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          // eastmoney serves UTF-8; default to UTF-8 for the holdings API
          resolve(buf.toString('utf-8'));
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════
//  Load fund holdings from local cache (data/holdings.json)
//  Run `npm run update-holdings` to refresh the cache
// ═══════════════════════════════════════════════════════
let fundsCache = null;
let fundsCacheTs = 0;
const tickerMarket = {};   // US ticker → eastmoney market id (105/106/107), built from holdings
const JP_STOCKS_SET = new Set();  // 日股，从 holdings market=JP 填充，用腾讯行情
const KR_STOCKS = new Set(['000660', '005930']);  // 韩股，腾讯 kr 通道；从 holdings market=KR 动态补充
const TW_STOCKS_SET = new Set();  // 台股，从 holdings market=TW 填充，用 TWSE 行情
const HK_STOCKS_SET = new Set();  // 港股（5位代码），新浪行情；日K走腾讯 hk 通道

function loadHoldingsFromFile() {
  const filePath = path.join(__dirname, 'data', 'holdings.json');
  if (!fs.existsSync(filePath)) {
    console.error('[funds] data/holdings.json not found! Run: npm run update-holdings');
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  fundsCache = JSON.parse(raw);
  fundsCacheTs = fs.statSync(filePath).mtimeMs;
  // Build ticker→eastmoney market map (US only: 105/106/107) for live quotes
  for (const f of fundsCache) {
    for (const h of (f.holdings || [])) {
      const m = String(h.market);
      if (m === '105' || m === '106' || m === '107') tickerMarket[h.s] = m;
      if (m === 'JP') JP_STOCKS_SET.add(h.s);
      if (m === 'KR') KR_STOCKS.add(h.s);
      if (m === 'TW') TW_STOCKS_SET.add(h.s);
      if (m === '116') HK_STOCKS_SET.add(h.s);
    }
  }
  console.log(`[funds] loaded ${fundsCache.length} funds from data/holdings.json`);
}

loadHoldingsFromFile();

app.get('/api/funds', (req, res) => {
  if (!fundsCache) {
    return res.status(500).json({ error: 'holdings data not loaded. Run: npm run update-holdings' });
  }
  res.json({ success: true, funds: fundsCache, loadedAt: fundsCacheTs });
});

// ═══════════════════════════════════════════════════════
//  Sina quotes proxy (real-time prices)
// ═══════════════════════════════════════════════════════
const quoteCache = new Map();
const QUOTE_TTL = 4 * 1000;
// Yahoo extended-hours 缓存（夜盘用，fulldayPrice 数据 60s 内复用，避免 Yahoo 限流）
const yahooExtCache = new Map();
const YAHOO_EXT_TTL = 120_000;  // 120 秒：夜盘成交稀疏，且走代理链路需控制雅虎调用量

// Known international tickers handled by a non-Sina fetcher
// (国内财经 API 不覆盖韩/日/台/欧实时行情，需要单独走 Naver/Yahoo Japan 等)
// KR_STOCKS 集合已在模块顶部声明，loadHoldingsFromFile 会从 holdings market=KR 动态补充

function isKoreanSymbol(s) { return KR_STOCKS.has(s); }

// 台股: 用 TWSE 官方 API (mis.twse.com.tw)，无频率限制
// 代码来源：holdings market=TW（裸 4 位数字代码）或 .TW 后缀符号
function isTaiwanSymbol(s) { return TW_STOCKS_SET.has(s) || /\.TW$/i.test(s); }
// 日股: market=JP，用腾讯行情 qt.gtimg.cn
function isJapanSymbol(s) { return JP_STOCKS_SET.has(s); }
// Yahoo Finance: 新加坡 (.SI) 等其他国际市场
function isYahooSymbol(s) { return /\.SI$/i.test(s); }

function toSinaId(symbol) {
  if (symbol === 'USDCNY=X') return 'fx_susdcny';
  if (symbol === 'IXIC' || symbol === '^IXIC') return 'gb_$ixic';
  if (symbol === 'DJI'  || symbol === '^DJI')  return 'gb_$dji';
  if (symbol === 'INX'  || symbol === '^GSPC') return 'gb_$inx';
  // 全球指数：纳斯达克科技市值加权指数（新浪 znb_ 前缀）
  // 注：东财也有此指数(251.NDXTMC)，但其 push2 行情主机拒绝当前出口（TLS 握手后 Empty reply），
  // 服务端不可用；新浪 znb_ 实测可达且字段含日期时间。
  if (symbol === 'NDXTMC' || symbol === '^NDXTMC') return 'znb_NDXTMC';
  // A-share: 6-digit numeric
  //   6xxxxx, 688xxx, 689xxx → 沪市
  //   0xxxxx, 1xxxxx, 3xxxxx → 深市 (含ETF 15xxxx)
  //   4xxxxx, 8xxxxx (非688/689) → 北交所
  if (/^\d{6}$/.test(symbol)) {
    if (symbol[0] === '6') return 'sh' + symbol;
    if (symbol[0] === '0' || symbol[0] === '1' || symbol[0] === '3') return 'sz' + symbol;
    if (symbol.startsWith('43') || symbol.startsWith('83') ||
        symbol.startsWith('87') || symbol.startsWith('92'))  return 'bj' + symbol;
    return 'sh' + symbol; // safe default
  }
  // HK stocks: 4-5 digit numeric (e.g. 00981 SMIC)
  // 用 rt_hk 实时通道（而非 hk 延时通道）：延时通道收盘后会冻结在收盘竞价前的
  // 价格，漏掉 16:00–16:10 收盘竞价（CAS）的定盘价，导致港股涨跌幅系统性偏小。
  if (/^\d{4,5}$/.test(symbol)) return 'rt_hk' + symbol.padStart(5, '0');
  return 'gb_' + symbol.toLowerCase();
}

function fetchSina(sinaIds) {
  const url = `https://hq.sinajs.cn/list=${sinaIds.join(',')}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Sina request timeout')));
    req.on('error', reject);
  });
}

// ──────────────────────────────────────────
//  Naver Finance fetcher (Korean stocks)
//  旧的 finance.naver.com/item/main.naver HTML 页已被 302 重定向到 SPA；
//  改用 m.stock.naver.com 的 JSON API，字段干净稳定。
// ──────────────────────────────────────────
function fetchNaverBasicJson(ticker) {
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(ticker)}/basic`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ko-KR,en;q=0.9',
          'Referer': 'https://m.stock.naver.com/',
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (e) {
            reject(new Error('Naver JSON parse failed: ' + e.message));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Naver request timeout')));
    req.on('error', reject);
  });
}

function parseNaverQuote(json, ticker) {
  if (!json || typeof json !== 'object') return null;
  const parseNum = v => {
    if (v == null) return NaN;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? NaN : n;
  };
  const price = parseNum(json.closePrice);
  if (!isFinite(price)) return null;

  // 方向：优先用 compareToPreviousPrice.name（RISING / FALLING / STEADY）
  //       兜底再看 text（상승/하락/보합）
  const dir = (json.compareToPreviousPrice && (json.compareToPreviousPrice.name || json.compareToPreviousPrice.text)) || '';
  let sign = 0;
  if (/RISING|상승/.test(dir)) sign = 1;
  else if (/FALLING|하락/.test(dir)) sign = -1;

  const changeAbs = sign * Math.abs(parseNum(json.compareToPreviousClosePrice) || 0);
  const changePct = sign * Math.abs(parseNum(json.fluctuationsRatio) || 0);
  const prevClose = price - changeAbs;

  const tradedAtMs = Date.parse(json.localTradedAt);
  return withTradingDay({
    symbol: ticker,
    regularMarketPrice: price,
    regularMarketPreviousClose: prevClose,
    regularMarketChangePercent: changePct,
    preMarketChangePercent: changePct,
    postMarketChangePercent: 0,
    marketState: krMarketState(),
    sourceTimeMs: isFinite(tradedAtMs) ? tradedAtMs : null,
  }, 'KR', json.localTradedAt);
}

async function fetchKoreanQuote(ticker) {
  const json = await fetchNaverBasicJson(ticker);
  return parseNaverQuote(json, ticker);
}

// ──────────────────────────────────────────
//  TWSE fetcher (台湾证券交易所，官方实时 API，无频率限制)
//  ticker 格式: "2330.TW"  → ex_ch: "tse_2330.tw"
// ──────────────────────────────────────────
async function fetchTaiwanQuotes(symbols) {
  // symbols 可能是裸 4 位代码（holdings market=TW）或 "2330.TW" 式符号；
  // 返回的 symbol 保持请求时的原样，确保与前端 qmap 键一致
  const codeToSym = new Map(symbols.map((s) => [s.replace(/\.TW$/i, ''), s]));
  // 默认 tse_ (上市)，OTC 上柜用 otc_
  const exCh = symbols.map((s) => {
    const code = s.replace(/\.TW$/i, '');
    return `tse_${code}.tw`;
  }).join('%7C');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0`;
  const text = await httpGet(url, { Referer: 'https://mis.twse.com.tw/' });
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const arr = (j && j.msgArray) || [];
  return arr.map((m) => {
    const code = m.c;
    if (!code) return null;
    const sym = codeToSym.get(code) || `${code}.TW`;
    // z 为最新成交价，但逐笔交易间隔期会闪现为 '-'；此时最新一笔成交价在 trade.z 里
    let price = (m.z && m.z !== '-') ? parseFloat(m.z)
              : (m.trade && m.trade.z) ? parseFloat(m.trade.z)
              : NaN;
    const prev  = parseFloat(m.y);
    if (isNaN(price) || price <= 0) {
      // 迟迟无成交：用昨收兜底显示 0 涨跌
      if (!isNaN(prev) && prev > 0) {
        return withTradingDay({
          symbol: sym,
          regularMarketPrice: prev,
          regularMarketChangePercent: 0,
          regularMarketPreviousClose: prev,
          preMarketChangePercent: 0,
          postMarketChangePercent: 0,
          marketState: 'REGULAR',
        }, 'TW', m.d);
      }
      return null;
    }
    if (isNaN(prev) || prev <= 0) return null;
    const chgPct = ((price - prev) / prev) * 100;
    return withTradingDay({
      symbol: sym,
      regularMarketPrice: price,
      regularMarketChangePercent: chgPct,
      regularMarketPreviousClose: prev,
      preMarketChangePercent: chgPct,
      postMarketChangePercent: 0,
      marketState: 'REGULAR',
    }, 'TW', m.d);
  }).filter(Boolean);
}

// ──────────────────────────────────────────
//  腾讯 ifzq 系列接口（日K / 分时）多域名轮询
//  web.ifzq.gtimg.cn 偶发被腾讯 WAF 拦截（返回 501 + 反爬跳转 HTML），
//  proxy.finance.qq.com/ifzqgtimg 与 ifzq.gtimg.cn 返回同一份数据，实测可互为备份。
// ──────────────────────────────────────────
const TENCENT_IFZQ_HOSTS = [
  'https://proxy.finance.qq.com/ifzqgtimg',
  'https://ifzq.gtimg.cn',
  'https://web.ifzq.gtimg.cn',
];

// 依次尝试各域名，返回第一个可解析的 JSON；全失败返回 null
async function fetchTencentIfzqJson(path) {
  for (const host of TENCENT_IFZQ_HOSTS) {
    try {
      const txt = await httpGet(host + path, { Referer: 'https://gu.qq.com/' });
      if (!txt || !txt.trim().startsWith('{')) continue;   // 501 反爬页是 HTML
      return JSON.parse(txt);
    } catch { /* 换下一个域名 */ }
  }
  return null;
}

// ──────────────────────────────────────────
//  Yahoo Finance fetcher (日股 .T / 新加坡 .SI)
// ──────────────────────────────────────────
function httpGetWithStatus(url, headers = {}) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          ...headers,
        },
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(body);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

async function fetchYahooQuote(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=1d`;
  const text = await httpGetWithStatus(url, { Accept: 'application/json' });
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result) return null;
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prev  = meta.chartPreviousClose || meta.previousClose;
  if (!price || !prev) return null;
  const chgPct = ((price - prev) / prev) * 100;
  return {
    symbol,
    regularMarketPrice: price,
    regularMarketChangePercent: chgPct,
    regularMarketPreviousClose: prev,
    preMarketChangePercent: chgPct,
    postMarketChangePercent: 0,
    marketState: meta.marketState || 'REGULAR',
  };
}

// ──────────────────────────────────────────
//  Yahoo Finance extended-hours fetcher (美股夜盘 fulldayPrice)
//  通过 includePrePost=true 拿到 hasPrePostMarketData + fulldayPrice 等字段，
//   解决新浪 fields[21] 滞后一日的问题，与富途/各行情终端一致。
//   限流友好：60s 缓存 + 5 并发。
// ──────────────────────────────────────────
async function fetchYahooFulldayOne(symbol) {
  const cached = yahooExtCache.get(symbol);
  if (cached) {
    // hardUntil: 整链路失败的硬退避截止时间，期间直接返回缓存(null)，不再重试
    if (cached.hardUntil && Date.now() < cached.hardUntil) return cached.data;
    if (Date.now() - cached.ts < YAHOO_EXT_TTL) return cached.data;
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=1d&includePrePost=true`;
  let text = null;
  try {
    text = await httpGetWithStatus(url, { Accept: 'application/json' });
  } catch (e) {
    // 本地出口 403 被墙 / Render 出口 429 限流 → 走代理链路
  }

  if (text == null) {
    // 代理链路：本地/Render → HIST_PROXY_URL 实例 /api/fullday → 其 Vercel 二级（不同 IP 池）。
    // 雪球限流或不可用时，这是夜盘真实价的唯一来源（β 模型估算偏差可达 0.5%+）
    try {
      const proxyText = await httpGet(
        `${HIST_PROXY_URL}/api/fullday?symbol=${encodeURIComponent(symbol)}`,
        { Accept: 'application/json' }
      );
      const j = JSON.parse(proxyText);
      if (j && j.noPrePost) {
        // 当前没有盘前/盘后/夜盘活动
        yahooExtCache.set(symbol, { data: null, ts: Date.now() });
        return null;
      }
      if (j && isFinite(j.fulldayPrice)) {
        const data = {
          fulldayPrice: j.fulldayPrice,
          fulldayChange: j.fulldayChange,
          fulldayChangePercent: j.fulldayChangePercent,
          previousClose: j.previousClose,
          regularMarketPrice: j.regularMarketPrice,
        };
        yahooExtCache.set(symbol, { data, ts: Date.now() });
        return data;
      }
    } catch (e2) {
      console.error('[yahoo-ext]', symbol, 'proxy fail:', e2.message);
    }
    // 直连 + 代理全失败 → 硬退避 5 分钟，避免整轮扫描期间反复硬撞
    yahooExtCache.set(symbol, { data: null, ts: Date.now(), hardUntil: Date.now() + 5 * 60_000 });
    return null;
  }
  let j;
  try { j = JSON.parse(text); } catch (e) {
    console.error('[yahoo-ext]', symbol, 'parse fail:', e.message, 'snippet:', text.slice(0, 100));
    yahooExtCache.set(symbol, { data: null, ts: Date.now() - YAHOO_EXT_TTL / 2 });
    return null;
  }
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result || !result.meta) {
    console.error('[yahoo-ext]', symbol, 'no meta, snippet:', text.slice(0, 200));
    return null;
  }
  const meta = result.meta;
  // hasPrePostMarketData=false 时该股当前没有盘前/盘后活动，fulldayPrice 不可用
  if (!meta.hasPrePostMarketData) {
    yahooExtCache.set(symbol, { data: null, ts: Date.now() });
    return null;
  }
  const data = {
    fulldayPrice: meta.fulldayPrice,
    fulldayChange: meta.fulldayChange,
    fulldayChangePercent: meta.fulldayChangePercent,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    regularMarketPrice: meta.regularMarketPrice,
  };
  console.log('[yahoo-ext]', symbol, 'OK fulldayPrice=', data.fulldayPrice);
  yahooExtCache.set(symbol, { data, ts: Date.now() });
  return data;
}

let yahooExtSweepRunning = false;

// 请求路径取缓存快照（全量扫描需数分钟，绝不能阻塞 /api/quotes）
function yahooExtSnapshot(symbols) {
  const map = new Map();
  for (const s of symbols) {
    const c = yahooExtCache.get(s);
    if (c && c.data) map.set(s, c.data);
  }
  return map;
}

function kickYahooExtSweep(symbols) {
  if (yahooExtSweepRunning || !symbols || !symbols.length) return;
  yahooExtSweepRunning = true;
  (async () => {
    try {
      await sweepYahooExtended(symbols);
    } finally {
      yahooExtSweepRunning = false;
    }
  })();
}

// 全量扫描 Yahoo fullday（直连→代理链路），并发 4 + 250ms 节流（雅虎调用量控制）
async function sweepYahooExtended(symbols) {
  if (!symbols || symbols.length === 0) return;
  const CONCURRENCY = 4;
  const REQ_DELAY_MS = 250;
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const sym = symbols[i++];
      try {
        await fetchYahooFulldayOne(sym);
      } catch (e) {
        console.error('[yahoo-ext]', sym, e.message);
      }
      if (i < symbols.length) await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
    }
  }
  await Promise.all(Array(Math.min(CONCURRENCY, symbols.length)).fill(0).map(worker));
}

// 兼容旧调用（调试端点等待完整扫描后返回结果）
async function fetchYahooExtended(symbols) {
  await sweepYahooExtended(symbols);
  return yahooExtSnapshot(symbols);
}

// ──────────────────────────────────────────
//  腾讯行情 fetcher (日股，qt.gtimg.cn)
//  格式: v_jp{code}="351~名称~{code}.T~最新价~昨收~...~时间~..."
// ──────────────────────────────────────────
async function fetchJapanQuotes(symbols) {
  const ids = symbols.map((s) => `jp${s}`).join(',');
  const url = `https://qt.gtimg.cn/q=${ids}`;
  const text = await httpGet(url, { Referer: 'https://finance.qq.com/' });
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/v_jp(\w+)="([^"]+)"/);
    if (!m) continue;
    const sym = m[1].toUpperCase();
    const fields = m[2].split('~');
    // fields[3]=最新价  fields[4]=昨收  fields[5]=涨跌额  fields[37]=涨跌幅(含%)
    const price    = parseFloat(fields[3]);
    const prevClose = parseFloat(fields[4]);
    if (!isFinite(price) || !isFinite(prevClose) || prevClose <= 0) continue;
    const chgPct = ((price - prevClose) / prevClose) * 100;
    // 日期字段位置在不同品种间会漂移，直接按内容找 'YYYY-MM-DD HH:mm:ss'
    const dateField = fields.find((f) => /^\d{4}-\d{2}-\d{2}[ T]/.test(f));
    // 时区偏移传 8（北京时间）：腾讯时间戳为北京时间，收盘后定格在收盘时刻（北京
    // 14:00 = JST 15:00）；若按 JP(+9) 判定，北京时间 23:00 后 JST 已跨日，会误判休市
    map[sym] = withTradingDay({
      symbol: sym,
      regularMarketPrice: price,
      regularMarketChangePercent: chgPct,
      regularMarketPreviousClose: prevClose,
      preMarketChangePercent: chgPct,
      postMarketChangePercent: 0,
      marketState: 'REGULAR',
    }, 8, dateField);
  }
  return map;
}

// ──────────────────────────────────────────
//  Tencent fetcher (Korean stocks) — 韩股收盘后主源
//  背景：Naver 的 /basic 与 fchart 日线在收盘后都不会更新为 15:30 KST 定盘价，
//        而是冻结在收盘竞价开始前（约 15:20）的最后成交价 —— 实测三星电子
//        2026-10-01 定盘 276000(+2.79%)，Naver 始终返回 273000(+1.68%)。
//        腾讯 qt.gtimg.cn 的 kr 前缀通道返回定盘价（东财"收涨2.79%"与之吻合）。
//        但腾讯 kr 通道盘中更新滞后数十分钟（实测冻结于 25 分钟前），盘中不实时，
//        故与 Naver 在 /api/quotes 中按 sourceTimeMs 择新合并（盘中用 Naver 实时价）。
//  字段与日股同构: [3]现价 [4]昨收；[30]为日期时间，注意是**北京时间**(KST-1h)
// ──────────────────────────────────────────
async function fetchTencentKrQuotes(symbols) {
  const ids = symbols.map((s) => `kr${s}`).join(',');
  const url = `https://qt.gtimg.cn/q=${ids}`;
  const text = await httpGet(url, { Referer: 'https://finance.qq.com/' });
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/v_kr(\w+)="([^"]+)"/);
    if (!m) continue;
    const sym = m[1].toUpperCase();
    const fields = m[2].split('~');
    const price = parseFloat(fields[3]);
    const prevClose = parseFloat(fields[4]);
    if (!isFinite(price) || !isFinite(prevClose) || prevClose <= 0) continue;
    const chgPct = ((price - prevClose) / prevClose) * 100;
    const dateField = fields.find((f) => /^\d{4}-\d{2}-\d{2}[ T]/.test(f));
    // 时区偏移传 8（北京时间）：腾讯收盘后时间戳定格在收盘时刻（北京 14:30 = KST 15:30），
    // 若按 KR(+9) 判定，北京时间 23:00 后 KST 已跨日，会把"今日已交易"误判为休市
    const tMs = Date.parse(String(dateField || '').replace(' ', 'T') + '+08:00');
    map[sym] = withTradingDay({
      symbol: sym,
      regularMarketPrice: price,
      regularMarketChangePercent: chgPct,
      regularMarketPreviousClose: prevClose,
      preMarketChangePercent: chgPct,
      postMarketChangePercent: 0,
      marketState: krMarketState(),
      sourceTimeMs: isFinite(tMs) ? tMs : null,
    }, 8, dateField);
  }
  return map;
}

// ──────────────────────────────────────────
//  日/韩/台/港股「昨日涨跌幅」(yesterdayChangePercent) —— 收盘估值视图用
//  背景：QDII 基金净值 T+2 滞后（实测 457001/539002 等最新净值仅到 9/29），
//        昨日各亚洲市场 session 的涨跌尚未计入净值。估值若用今日盘中实时值，
//        会把昨日的大涨跌完全漏掉（例：三星电子 10.1 +2.79%，今日盘中仅 +0.2%）。
//        故 default(收盘) 视图按昨日涨跌幅计，由前端 effectiveChange 使用。
//  口径：昨日收盘优先用行情源实时「昨收」（腾讯定盘口径，官方值），
//        前日收盘取自各市场日K（韩股经涨跌额锚定反推、亦为官方值）。
//  K线行缓存 30 分钟（昨日K线日内不变）；后台预取，绝不阻塞行情响应。
// ──────────────────────────────────────────
const INTL_YDAY_TTL = 30 * 60_000;         // K线行缓存时长
const INTL_YDAY_FAIL_BACKOFF = 5 * 60_000; // 取数失败后的重试间隔
const INTL_YDAY_TZ = 9;                    // 日韩均为 UTC+9
const intlYdayRowsCache = new Map();       // sym → { rows, ts, inflight }
const intlYdayQueue = [];
let intlYdayActive = 0;
const INTL_YDAY_CONCURRENCY = 2;           // Yahoo Japan 突发并发会断连，保守并发
const INTL_YDAY_REQ_GAP = 400;             // 相邻请求间隔(ms)

// 韩股官方日K：Naver 移动端 /price 接口 + 「涨跌额锚定」反推官方收盘。
// 背景：Naver 所有日K（siseJson/fchart/price）的 closePrice 都是 15:20 竞价前
// 最后成交价，不含 15:30 KST 收盘竞价定盘（实测海力士 10.1 Naver=1,828,000
// vs 官方定盘=1,833,000）。但每行的 compareToPreviousClosePrice（涨跌额）是
// 相对**官方前日收盘**计算的：closePrice(当日) − 涨跌额 = 前一交易日的官方收盘。
// 用「次交易日行」的锚定值即可反推出每个交易日的官方收盘：
//   官方收盘(D) = closePrice(次交易日行) − 涨跌额(次交易日行)
// 已交叉验证：海力士 10.2行 1,848,000−15,000=1,833,000（=腾讯昨收/官方10.1收盘）；
//   海力士 10.1行 1,828,000−52,000=1,776,000（=官方9/30收盘，官方10.1涨幅
//   1,833,000/1,776,000=+3.21% 与东财一致）。
async function fetchNaverMobilePriceOfficial(symbol) {
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(symbol)}/price`;
  const txt = await httpGet(url, {
    Referer: 'https://m.stock.naver.com/',
    Accept: 'application/json',
  });
  let arr;
  try { arr = JSON.parse(txt); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const num = (v) => parseFloat(String(v).replace(/,/g, ''));
  // arr 为日期降序（[0]=最新）。anchor(arr[i]) = 官方收盘(arr[i+1] 的日期)
  const official = [];
  for (let i = 0; i < arr.length - 1; i++) {
    const close = num(arr[i].closePrice);
    const chg = num(arr[i].compareToPreviousClosePrice);
    const d = arr[i + 1].localTradedAt;
    if (!d || !isFinite(close) || !isFinite(chg) || !isFinite(num(arr[i + 1].closePrice))) continue;
    official.push({ date: d, close: close - chg });
  }
  official.sort((a, b) => a.date.localeCompare(b.date));
  return official;
}

// 从文本中按括号配对提取 JSON 数组/对象（跳过字符串内的括号）
function extractJsonAt(text, startIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

// 日股日K：Yahoo Japan 時系列页，日K在 Next.js RSC payload 的 "histories" 数组里
// values 顺序：始値/高値/安値/終値/出来高，收盘取 values[3]（已与腾讯昨收交叉核验）
// 注意： finance.yahoo.co.jp 对突发并发会直接 socket hang up，失败需退避重试
async function fetchYahooJapanDaily(symbol) {
  const url =
    `https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}.T/history?period=1M&term=daily`;
  let html;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      html = await httpGet(url, { Accept: 'text/html,application/xhtml+xml' });
      if (html && html.length > 10000) break;
      html = null;
    } catch (e) {
      if (attempt > 0) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!html) return [];
  let merged = '';
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { merged += JSON.parse('"' + m[1] + '"'); } catch { /* 忽略坏块 */ }
  }
  const i = merged.indexOf('"histories"');
  if (i < 0) return [];
  const arrTxt = extractJsonAt(merged, merged.indexOf('[', i));
  if (!arrTxt) return [];
  let arr;
  try { arr = JSON.parse(arrTxt); } catch { return []; }
  const rows = (Array.isArray(arr) ? arr : []).map((h) => ({
    date: h && h.date,
    close: parseFloat(String((h.values && h.values[3] && h.values[3].value) || '').replace(/,/g, '')),
  })).filter((r) => r.date && isFinite(r.close));
  rows.sort((a, b) => a.date.localeCompare(b.date));   // histories 为日期降序，统一转升序
  return rows;
}

// 昨日涨跌幅（结合行情源 quote 对齐官方昨收）：
//   A. 行情源停在昨日 session（今日休市/未开盘）：腾讯价 = 昨日官方收盘、
//      昨收 = 前日官方收盘 → 行情源涨跌幅即昨日官方涨跌幅
//   B. 昨日无K线（休市）且不符 A → 0
//   C. 昨日有K线：昨日收盘用 quote.昨收（官方，tradingToday 时对齐昨日），
//      日K值兜底；前日收盘取日K。缺前收基准 → null（不附加字段）
function calcYesterdayChange(rows, quote, tzOffsetHours) {
  const yKey = new Date(Date.now() + tzOffsetHours * 3600_000 - 86400_000).toISOString().slice(0, 10);
  if (
    quote && quote.tradingToday === false && quote.sessionDate === yKey &&
    isFinite(quote.regularMarketChangePercent)
  ) {
    return { pct: quote.regularMarketChangePercent, date: yKey };
  }
  const idx = rows.findIndex((r) => r.date === yKey);
  if (idx < 0) return { pct: 0, date: yKey };
  if (idx === 0) return null;
  let yClose = rows[idx].close;
  if (
    quote && quote.tradingToday === true &&
    isFinite(quote.regularMarketPreviousClose) && quote.regularMarketPreviousClose > 0
  ) {
    yClose = quote.regularMarketPreviousClose;
  }
  const prevClose = rows[idx - 1].close;
  if (!isFinite(yClose) || !isFinite(prevClose) || prevClose <= 0) return null;
  return { pct: (yClose / prevClose - 1) * 100, date: yKey };
}

// ──────────────────────────────────────────
//  Yahoo 官方日K（韩股 .KS / 台股 .TW）—— 收盘价为交易所官方定盘口径
//  本地网络出口访问 query1 Yahoo 被墙(403)：直连失败时走已部署的 Render 实例
//  代理（其出口可达 Yahoo，见 /api/_hist 端点）；在 Render 上运行时直连即命中。
// ──────────────────────────────────────────
const HIST_PROXY_URL = process.env.HIST_PROXY_URL || 'https://fund-valuation-m37d.onrender.com';
const histProxyCache = new Map();   // sym → { rows, ts }（含失败退避）
const HIST_PROXY_TTL = 10 * 60_000;
const HIST_PROXY_FAIL_BACKOFF = 5 * 60_000;

function parseYahooChart(j, tzOffsetHours) {
  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result || !result.timestamp) return [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const rows = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = closes[i];
    if (c == null || !isFinite(c)) continue;
    rows.push({ date: new Date(result.timestamp[i] * 1000 + tzOffsetHours * 3600_000).toISOString().slice(0, 10), close: c });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function fetchYahooChartDaily(fullSym, tzOffsetHours) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(fullSym)}` +
    `?interval=1d&range=1mo`;
  try {
    const text = await httpGetWithStatus(url, { Accept: 'application/json' });
    return parseYahooChart(JSON.parse(text), tzOffsetHours);
  } catch (e) {
    // 本地出口被墙 → 走部署实例代理
  }
  const cached = histProxyCache.get(fullSym);
  if (cached) {
    if (cached.rows) return cached.rows;
    if (Date.now() - cached.ts < HIST_PROXY_FAIL_BACKOFF) return [];
  }
  try {
    const proxyUrl = `${HIST_PROXY_URL}/api/_hist?symbol=${encodeURIComponent(fullSym)}&tz=${tzOffsetHours}`;
    const text = await httpGet(proxyUrl, { Accept: 'application/json' });
    const j = JSON.parse(text);
    const rows = (j && j.rows) || [];
    histProxyCache.set(fullSym, { rows: rows.length ? rows : null, ts: Date.now() });
    return rows;
  } catch (e) {
    histProxyCache.set(fullSym, { rows: null, ts: Date.now() });
    console.warn('[hist-proxy]', fullSym, e.message);
    return [];
  }
}

// ──────────────────────────────────────────
//  台股官方收盘累积存储（data/intl-closes.json）
//  台股在当前网络无任何可达历史K线源（雅虎台湾为错误页、TWSE 官方日线
//  www.twse.com.tw 被墙、腾讯/雪球不覆盖台股）。TWSE 实时行情的昨收(y)
//  = 前一交易日官方收盘 —— 每个交易日记录「当日的昨收」，随时间累积出
//  官方收盘序列：store[session D] = 官方收盘(D 的前一 session)。
//  读取：官方收盘(D) = store[次 session(D)]；store 的 key 即 session 序列
//  （节假日无行情无 key，天然保持相邻性）。从部署后第 2 个交易日起自愈，
//  此前端回落今日实时值。
// ──────────────────────────────────────────
const INTL_CLOSES_PATH = path.join(__dirname, 'data', 'intl-closes.json');
const intlOfficialCloses = {};   // sym → { 'YYYY-MM-DD': 前一session官方收盘 }
let intlClosesDirty = false;

(function loadIntlCloses() {
  try {
    const j = JSON.parse(fs.readFileSync(INTL_CLOSES_PATH, 'utf-8'));
    for (const k of Object.keys(j)) intlOfficialCloses[k] = j[k];
    console.log('[intl-closes] loaded', Object.keys(intlOfficialCloses).length, 'symbols');
  } catch { /* 首次运行无文件 */ }
})();

function recordIntlClose(sym, sessionDate, prevOfficialClose) {
  if (!sym || !sessionDate || !isFinite(prevOfficialClose) || prevOfficialClose <= 0) return;
  if (!intlOfficialCloses[sym]) intlOfficialCloses[sym] = {};
  if (intlOfficialCloses[sym][sessionDate] === prevOfficialClose) return;
  intlOfficialCloses[sym][sessionDate] = prevOfficialClose;
  intlClosesDirty = true;
}

// 由累积存储构建官方收盘 rows（升序）：官方收盘(D_i) = store[D_{i+1}]
function twOfficialRows(sym) {
  const m = intlOfficialCloses[sym] || {};
  const sessions = Object.keys(m).sort();
  const rows = [];
  for (let i = 1; i < sessions.length; i++) {
    rows.push({ date: sessions[i - 1], close: m[sessions[i]] });
  }
  return rows;
}

setInterval(() => {
  if (!intlClosesDirty) return;
  intlClosesDirty = false;
  try {
    fs.writeFileSync(INTL_CLOSES_PATH, JSON.stringify(intlOfficialCloses), 'utf-8');
  } catch (e) {
    console.error('[intl-closes] write fail:', e.message);
  }
}, 60_000);

// 日K数据源分市场路由：
//   日股 → Yahoo Japan 時系列页（本地可达，官方收盘）
//   港股 → 腾讯 hk 通道日K（本地可达，官方收盘）
//   韩股 → Naver 移动端 /price 涨跌额锚定反推官方收盘（本地可达，见其函数注释）
//   台股 → 本地累积的官方收盘存储；未积累前回落 Yahoo 代理，再无则今日实时
function fetchIntlYdayRows(sym) {
  if (JP_STOCKS_SET.has(sym)) return fetchYahooJapanDaily(sym);
  if (HK_STOCKS_SET.has(sym)) return fetchTencentHkDaily(sym);
  if (KR_STOCKS.has(sym)) return fetchNaverMobilePriceOfficial(sym);
  if (TW_STOCKS_SET.has(sym)) {
    const rows = twOfficialRows(sym);
    if (rows.length) return Promise.resolve(rows);
    return fetchYahooChartDaily(sym + '.TW', 8);
  }
  return Promise.resolve(null);
}

function pumpIntlYdayQueue() {
  while (intlYdayActive < INTL_YDAY_CONCURRENCY && intlYdayQueue.length) {
    const sym = intlYdayQueue.shift();
    const entry = intlYdayRowsCache.get(sym);
    if (!entry || entry.inflight) continue;
    entry.inflight = true;
    intlYdayActive++;
    (async () => {
      try {
        const rows = await fetchIntlYdayRows(sym);
        if (rows && rows.length) {
          entry.rows = rows;
          entry.ts = Date.now();
          console.log('[intl-yday]', sym, 'rows=' + rows.length, rows[rows.length - 1].date, '~', rows[0].date);
        } else {
          entry.ts = Date.now();  // 无历史/解析失败 → 记录尝试时间用于退避
          console.warn('[intl-yday]', sym, 'empty rows');
        }
      } catch (e) {
        entry.ts = Date.now();
        console.error('[intl-yday]', sym, e.message);
      } finally {
        await new Promise((r) => setTimeout(r, INTL_YDAY_REQ_GAP));
        entry.inflight = false;
        intlYdayActive--;
        pumpIntlYdayQueue();
      }
    })();
  }
}

function prefetchIntlYdayRows(sym) {
  let entry = intlYdayRowsCache.get(sym);
  if (!entry) {
    entry = { rows: null, ts: 0, inflight: false };
    intlYdayRowsCache.set(sym, entry);
  }
  if (entry.inflight || intlYdayQueue.includes(sym)) return;
  intlYdayQueue.push(sym);
  pumpIntlYdayQueue();
}

// 同步附加：有K线即结合当前行情源计算（官方昨收对齐随行情实时刷新）；
// 无K线触发后台预取；失败退避期内不重试。绝不阻塞本次响应。
function attachIntlYday(quote) {
  const sym = quote.symbol;
  if (
    !JP_STOCKS_SET.has(sym) && !KR_STOCKS.has(sym) &&
    !TW_STOCKS_SET.has(sym) && !HK_STOCKS_SET.has(sym)
  ) return quote;
  // 台股：累积「当日昨收 = 前一交易日官方收盘」序列
  if (TW_STOCKS_SET.has(sym) && quote.tradingToday === true && quote.sessionDate) {
    recordIntlClose(sym, quote.sessionDate, quote.regularMarketPreviousClose);
  }
  const c = intlYdayRowsCache.get(sym);
  if (c && c.rows && c.rows.length) {
    if (Date.now() - c.ts >= INTL_YDAY_TTL) prefetchIntlYdayRows(sym);
    const calc = calcYesterdayChange(c.rows, quote, INTL_YDAY_TZ);
    if (calc) return { ...quote, yesterdayChangePercent: calc.pct, yesterdayDate: calc.date };
    return quote;
  }
  if (!c || Date.now() - c.ts >= INTL_YDAY_FAIL_BACKOFF) prefetchIntlYdayRows(sym);
  return quote;
}

// ──────────────────────────────────────────
//  Xueqiu (雪球) fetcher — 美股夜盘 ECN 数据源
//  字段 current_night_session / percent_night_session 对应富途"夜盘"涨幅
//  需要 cookie 鉴权：首次访问主站拿 session cookie，后续带 cookie 请求
// ──────────────────────────────────────────
let xueqiuCookie = null;
let xueqiuCookieTs = 0;
const XUEQIU_COOKIE_TTL = 30 * 60_000;  // 30 分钟
const xueqiuQuoteCache = new Map();
let xqCircuitOpenUntil = 0;    // 雪球熔断截止时间（整批失败/被限流时暂停调用）
let xqConsecutiveFails = 0;
const XUEQIU_QUOTE_TTL = 30_000;  // 30 秒：夜盘成交稀疏，且全量标的每轮刷新的调用量很大（高频会触发雪球限流）
const XUEQIU_ETF_MAX_LAG_MS = 5 * 60_000;

// 注：雪球夜盘数据不做"距今多少分钟"式的过期判定。
// 夜盘尾声（约 03:30 ET 后）成交稀少，推送间隔会自然拉长，但最后一条仍是
// 真实成交价。改用"时间戳是否落在本轮夜盘内"判定，见 usOvernightSessionStart()。

function fetchXueqiuRaw(url, extraHeaders = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://xueqiu.com/',
        ...(xueqiuCookie ? { Cookie: xueqiuCookie } : {}),
        ...extraHeaders,
      },
      timeout: 8000,
    }, (res) => {
      // Collect Set-Cookie before handling redirect
      const sc = res.headers['set-cookie'];
      if (sc && sc.length) {
        const added = sc.map((s) => s.split(';')[0]).join('; ');
        xueqiuCookie = xueqiuCookie ? `${xueqiuCookie}; ${added}` : added;
        xueqiuCookieTs = Date.now();
      }
      // Follow redirects (xueqiu /hq → www.xueqiu.com/hq)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchXueqiuRaw(res.headers.location, extraHeaders, depth + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('xueqiu timeout')));
    req.on('error', reject);
  });
}

async function ensureXueqiuCookie() {
  const now = Date.now();
  if (xueqiuCookie && now - xueqiuCookieTs < XUEQIU_COOKIE_TTL) return;
  // 访问 /hq 行情页拿完整 session cookie (xq_a_token / xqat / u / cookiesu)
  // 首页 '/' 只返回 acw_tc，调用 /v5/stock/quote.json 时会得 400016 鉴权失败
  xueqiuCookie = null;
  await fetchXueqiuRaw('https://xueqiu.com/hq', {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }).catch(() => {});
}

async function fetchXueqiuDirect(symbol) {
  await ensureXueqiuCookie();
  const url = `https://stock.xueqiu.com/v5/stock/quote.json?symbol=${encodeURIComponent(symbol)}&extend=detail`;
  let text;
  try {
    text = await fetchXueqiuRaw(url);
  } catch (e) {
    console.error('[xueqiu]', symbol, 'http fail:', e.message);
    return null;
  }
  let j;
  try { j = JSON.parse(text); } catch (e) {
    console.error('[xueqiu]', symbol, 'parse fail:', e.message);
    return null;
  }
  // 鉴权失败则清缓存重试一次
  if (j && j.error_code && j.error_code !== 0) {
    xueqiuCookie = null;
    await ensureXueqiuCookie();
    try {
      text = await fetchXueqiuRaw(url);
      j = JSON.parse(text);
    } catch (e) {
      console.error('[xueqiu]', symbol, 'retry fail:', e.message);
      return null;
    }
  }
  const q = j && j.data && j.data.quote;
  if (!q) return null;
  return {
    current: q.current,
    percent: q.percent,
    lastClose: q.last_close,
    currentExt: q.current_ext,
    percentExt: q.percent_ext,
    timestampExt: q.timestamp_ext,
    currentNight: q.current_night_session,
    percentNight: q.percent_night_session,
    chgNight: q.chg_night_session,
    timestampNight: q.timestamp_night_session,
    status: j.data?.market?.status_id,
  };
}

// 直连失败（本机/Render 出口 IP 被雪球反爬拉黑，返回防爬 HTML）→
// 走 HIST_PROXY_URL 实例 /api/night（不同平台 IP 池）代取夜盘数据。
// percent_night_session 与富途「夜盘」同源同口径（相对正股收盘价）。
async function fetchXueqiuViaProxy(symbol) {
  const text = await httpGet(
    `${HIST_PROXY_URL}/api/night?symbol=${encodeURIComponent(symbol)}`,
    { Accept: 'application/json' }
  );
  const j = JSON.parse(text);
  if (!j || (j.currentNight == null && j.currentExt == null)) return null;
  return {
    currentNight: j.currentNight,
    percentNight: j.percentNight,
    chgNight: j.chgNight,
    timestampNight: j.timestampNight,
    currentExt: j.currentExt,
    percentExt: j.percentExt,
    current: j.current,
  };
}

async function fetchXueqiuQuote(symbol, opts = {}) {
  const cached = xueqiuQuoteCache.get(symbol);
  if (cached && Date.now() - cached.ts < XUEQIU_QUOTE_TTL) return cached.data;

  let data = null;
  // 熔断打开期间跳过直连（避免重撞限流墙），直接走代理
  if (Date.now() >= xqCircuitOpenUntil) {
    data = await fetchXueqiuDirect(symbol).catch(() => null);
  }
  if (!data && opts.allowProxy !== false) {
    data = await fetchXueqiuViaProxy(symbol).catch((e) => {
      console.error('[xueqiu]', symbol, 'proxy fail:', e.message);
      return null;
    });
  }
  if (data) xueqiuQuoteCache.set(symbol, { data, ts: Date.now() });
  return data;
}

async function fetchXueqiuQuotes(symbols) {
  if (!symbols.length) return new Map();
  // 熔断：被限流（整批失败返回防爬 HTML）时直连暂停 5 分钟（fetchXueqiuQuote
  // 内自动改走代理实例），否则每轮刷新重撞限流墙，且永远恢复不了
  const map = new Map();
  // 雪球每个请求是单标的，并发 5 个够用
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const sym = symbols[i++];
      try {
        const data = await fetchXueqiuQuote(sym);
        if (data) map.set(sym, data);
      } catch (e) {
        console.error('[xueqiu]', sym, e.message);
      }
    }
  }
  await Promise.all(Array(Math.min(CONCURRENCY, symbols.length)).fill(0).map(worker));
  if (map.size === 0 && symbols.length > 0) {
    xqConsecutiveFails++;
    if (xqConsecutiveFails >= 2) {
      xqCircuitOpenUntil = Date.now() + 5 * 60_000;
      xqConsecutiveFails = 0;
      console.warn('[xueqiu] 连续整批失败，疑似限流，熔断 5 分钟');
    }
  } else {
    xqConsecutiveFails = 0;
  }
  return map;
}

// ──────────────────────────────────────────
//  Sina 外盘期货 fetcher (hf_NQ / hf_ES / hf_YM)
//  用于夜盘(ET 20:00-04:00) 美股 ETF 的 24h 走势代理，与富途一致。
//  字段: [0]最新 [4]高 [5]低 [6]时间 [7]开盘 [8]昨结算 [12]日期 [13]名称
// ──────────────────────────────────────────
const SINA_FUTURES_CACHE = new Map();
const SINA_FUTURES_TTL = 5_000;
async function fetchSinaFutures(symbols = ['NQ', 'ES', 'YM']) {
  const now = Date.now();
  const cacheKey = symbols.join(',');
  const cached = SINA_FUTURES_CACHE.get(cacheKey);
  if (cached && now - cached.ts < SINA_FUTURES_TTL) return cached.data;
  const list = symbols.map((s) => `hf_${s}`).join(',');
  const text = await fetchSina([list]).catch(() => '');
  const map = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/hq_str_hf_([A-Z]+)="([^"]*)"/);
    if (!m || !m[2]) continue;
    const sym = m[1];
    const f = m[2].split(',');
    const price = parseFloat(f[0]);
    const prevSettle = parseFloat(f[8]);
    if (!isFinite(price) || !isFinite(prevSettle) || prevSettle <= 0) continue;
    const chgPct = ((price - prevSettle) / prevSettle) * 100;
    map[sym] = { price, prevSettle, chgPct, time: f[6] || '' };
  }
  SINA_FUTURES_CACHE.set(cacheKey, { data: map, ts: now });
  return map;
}

function getUSMarketState() {
  const now = new Date();
  const month = now.getUTCMonth();
  const isDST = month > 2 && month < 10;
  const etOffsetMin = isDST ? -240 : -300;
  const et = new Date(now.getTime() + etOffsetMin * 60000);
  const day = et.getUTCDay();
  const minOfDay = et.getUTCHours() * 60 + et.getUTCMinutes();
  if (day === 0 || day === 6) return 'CLOSED';
  if (minOfDay >= 240 && minOfDay < 570) return 'PRE';
  if (minOfDay >= 570 && minOfDay < 960) return 'REGULAR';
  if (minOfDay >= 960 && minOfDay < 1200) return 'POST';
  // 工作日 00:00-04:00 ET：夜盘（期货持续交易）
  return 'OVERNIGHT';
}

// 本轮美股夜盘（20:00-04:00 ET）的起点时间戳（毫秒）。
// 用途：判断雪球夜盘数据是否属于"当前这一轮夜盘"。
// 背景：夜盘尾声（约 03:30 ET 之后）Blue Ocean 通道成交稀少，雪球的推送间隔
//       会从几分钟拉长到几十分钟甚至更久。若按"距今多少分钟"判定，
//       会把它误判为"数据源停更"而回退到 β 模型估算 —— 而那个估算
//       在个股上偏差极大（实测闪迪：真实 +1.89% vs 估算 -0.21%）。
//       最后一条雪球推送仍是真实成交价，只滞后不失效，因此判据应为
//       "时间戳落在本轮夜盘内"，而非"距今多久"。
function usOvernightSessionStart() {
  const now = new Date();
  const isDST = now.getUTCMonth() > 2 && now.getUTCMonth() < 10;
  const etOffsetMin = isDST ? -240 : -300;
  const et = new Date(now.getTime() + etOffsetMin * 60000);
  const minOfDay = et.getUTCHours() * 60 + et.getUTCMinutes();
  // ET 当天 00:00 对应的 UTC 毫秒
  const etMidnightUtc = Date.UTC(et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate()) - etOffsetMin * 60000;
  // ET 20:00（1200 分）之前 → 本轮夜盘起于前一日 20:00
  const dayShift = minOfDay < 1200 ? -1 : 0;
  return etMidnightUtc + (1200 + dayShift * 1440) * 60000;
}

// ─────────────────────────────────────────────────────────────
//  交易日判定（节假日 / 周末 / 未开盘）
//  行情源（新浪、Naver、腾讯、TWSE）都会带上"该报价所属的日期"。
//  若这个日期不是当地今天，说明该市场今天没有交易 —— 通常是放假。
//  例：A 股国庆休市期间，新浪仍返回 9/30 的收盘与涨跌幅，
//      直接展示会把"上一交易日的涨跌幅"误报成今日涨跌。
//  处理：保留原始值，另加 sessionDate / tradingToday 字段，
//        由前端在 24h 视图把它按 0 计。
// ─────────────────────────────────────────────────────────────
const MARKET_TZ_OFFSET = { CN: 8, HK: 8, TW: 8, JP: 9, KR: 9 };

function marketToday(tzOffsetHours) {
  return new Date(Date.now() + tzOffsetHours * 3600_000).toISOString().slice(0, 10);
}

function marketClock(tzOffsetHours) {
  const d = new Date(Date.now() + tzOffsetHours * 3600_000);
  return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// 各市场现货交易时段（当地时间分钟数；午休视为交易中——午间报价冻结在
// 上午收盘值，仍代表"今日涨跌幅"，避免盘中状态来回抖动）
const MARKET_SESSIONS = {
  CN: [[570, 900]],   // 9:30–15:00
  HK: [[570, 960]],   // 9:30–16:00
  JP: [[540, 900]],   // 9:00–15:00
  KR: [[540, 930]],   // 9:00–15:30
  TW: [[540, 810]],   // 9:00–13:30
};

// 该市场此刻是否在交易中：'REGULAR' / 'CLOSED'；未知市场返回 null（不覆盖原值）
function marketSessionState(marketKey) {
  const key = typeof marketKey === 'number' ? 'KR' : marketKey;   // 数字偏移 = 腾讯韩股通道
  const sessions = MARKET_SESSIONS[key];
  if (!sessions) return null;
  const { day, min } = marketClock(MARKET_TZ_OFFSET[key]);
  if (day === 0 || day === 6) return 'CLOSED';
  return sessions.some(([a, b]) => min >= a && min < b) ? 'REGULAR' : 'CLOSED';
}

function krMarketState() {
  const { day, min } = marketClock(MARKET_TZ_OFFSET.KR);
  return day >= 1 && day <= 5 && min >= 540 && min < 930 ? 'REGULAR' : 'CLOSED';
}

// 'YYYY-MM-DD' / 'YYYY/MM/DD' / 'YYYYMMDD' / ISO 时间戳 → 'YYYY-MM-DD'
function toDateKey(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m;
  if ((m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// 给行情对象补齐交易日信息。数据源未提供日期时原样返回（不做判定，避免误判）。
function withTradingDay(quote, marketKey, rawDate) {
  const key = toDateKey(rawDate);
  if (!key) return quote;
  // marketKey 可传市场标识（'KR'）或直接的 UTC 偏移小时数（腾讯源的时间戳统一为北京时间）
  const tz = typeof marketKey === 'number' ? marketKey : (MARKET_TZ_OFFSET[marketKey] ?? 8);
  // 统一按当地时间标注实时交易状态（原先 JP/TW/HK/CN 硬编码 'REGULAR'，
  // 导致 24h 视图无法区分"开盘中实时价"与"收盘冻结价"）
  const ms = marketSessionState(marketKey);
  return {
    ...quote,
    sessionDate: key,
    tradingToday: key === marketToday(tz),
    ...(ms ? { marketState: ms } : {}),
  };
}

// ──────────────────────────────────────────
//  Eastmoney push2 fetcher (US stocks / indices / ETFs)
//  覆盖盘前·盘中·盘后(及隔夜，待隔夜时段验证)，并提供准确昨收 (f18)。
//  f2 最新价 · f3 涨跌幅 · f12 代码 · f13 市场 · f14 名称 · f18 昨收 (fltt=2 不缩放)
// ──────────────────────────────────────────
const EM_STATIC = {            // 指数/ETF → eastmoney secid
  IXIC: '100.NDX',             // 纳斯达克综合
  QQQ:  '105.QQQ',
  SPY:  '107.SPY',
  VIXY: '107.VIXY',
};
function emSecid(sym) {
  if (EM_STATIC[sym]) return EM_STATIC[sym];
  const m = tickerMarket[sym];
  if (m === '105' || m === '106' || m === '107') return `${m}.${sym}`;
  return null;                 // 非美股(汇率/港股/A股/韩股/未知) → 不走 eastmoney
}
function fetchEastmoney(secids) {
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get` +
    `?secids=${secids.join(',')}&fields=f2,f3,f12,f13,f14,f18&fltt=2`;
  return httpGet(url, { Referer: 'https://quote.eastmoney.com/' });
}
function parseEastmoney(jsonText, secidToSym) {
  let j;
  try { j = JSON.parse(jsonText); } catch { return {}; }
  const diff = (j && j.data && j.data.diff) || [];
  const usState = getUSMarketState();
  const map = {};
  for (const d of diff) {
    const secid = `${d.f13}.${d.f12}`;
    const sym = secidToSym.get(secid) || d.f12;
    const price = Number(d.f2), chg = Number(d.f3), prev = Number(d.f18);
    if (!isFinite(price) || !isFinite(chg)) continue;  // eastmoney 用 '-' 表示无数据
    map[sym] = {
      symbol: sym,
      regularMarketPrice: price,
      regularMarketChangePercent: chg,
      regularMarketPreviousClose: isFinite(prev) ? prev : null,
      preMarketChangePercent: chg,
      postMarketChangePercent: 0,
      marketState: usState,
    };
  }
  return map;
}

function parseSinaResponse(text, requestedSymbols) {
  const map = {};
  const symMap = new Map(requestedSymbols.map((s) => [s.toUpperCase(), s]));
  const usState = getUSMarketState();

  for (const line of text.split('\n')) {
    const m = line.match(/var\s+hq_str_([\w$^]+)\s*=\s*"([^"]*)"/);
    if (!m) continue;
    const id = m[1];
    const fields = m[2].split(',');
    if (fields.length < 3) continue;

    if (id === 'fx_susdcny') {
      const price   = parseFloat(fields[8]) || parseFloat(fields[2]) || 0;
      const prevRef = parseFloat(fields[3]) || price;
      let chgPct = parseFloat(fields[10]);
      if (isNaN(chgPct) && prevRef) chgPct = ((price - prevRef) / prevRef) * 100;
      if (isNaN(chgPct)) chgPct = 0;
      map['USDCNY=X'] = {
        symbol: 'USDCNY=X',
        regularMarketPrice: price,
        regularMarketPreviousClose: prevRef,
        regularMarketChangePercent: chgPct,
        marketState: 'REGULAR',
      };
      continue;
    }

    if (id.startsWith('znb_')) {
      // 新浪全球指数（znb_ 前缀），字段布局：
      //  [0]名称 [1]最新 [2]涨跌额 [3]涨跌幅% [4][5]空
      //  [6]日期 [7]时间(北京时间，美股指数收盘=04:00) [8]今开 [9]昨收 [10]最高 [11]最低
      const upper = id.slice(4).toUpperCase();
      const symbol = symMap.get(upper) || upper;
      const price = parseFloat(fields[1]);
      if (isNaN(price) || price <= 0) continue;
      let chgPct = parseFloat(fields[3]);
      if (isNaN(chgPct)) {
        const prev = parseFloat(fields[9]);
        chgPct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
      }
      map[symbol] = {
        symbol,
        regularOnly: true,   // 现货指数：仅美股盘中实时，盘前/夜盘/盘后估值按 0（前端 effectiveChange 使用）
        regularMarketPrice: price,
        regularMarketChangePercent: chgPct,
        regularMarketPreviousClose: parseFloat(fields[9]) || null,
        marketState: usState,
      };
      continue;
    }

    if (id.startsWith('gb_')) {
      let upper = id.slice(3).toUpperCase();
      if (upper.startsWith('$')) {
        const stripped = upper.slice(1);
        upper = symMap.has(stripped) ? stripped
              : symMap.has('^' + stripped) ? '^' + stripped
              : stripped;
      }
      const symbol = symMap.get(upper) || upper;
      const closePrice = parseFloat(fields[1]);   // 昨日正式收盘价
      const prevClose  = parseFloat(fields[26]) || parseFloat(fields[8]) || null; // 前收盘(涨跌基准)
      if (isNaN(closePrice)) continue;

      // fields[21]: 盘前时段=盘前最新价，盘后时段=盘后最新价
      // fields[5]:  盘前备用价（更新较慢）
      const f21Price  = parseFloat(fields[21]);
      const f5Price   = parseFloat(fields[5]);

      // 根据时段选取实时价和涨跌幅
      let price, chgPct, ahPrice = null;
      if (usState === 'PRE') {
        // 盘前：优先 fields[21]，fallback fields[5]
        const prePrice = (!isNaN(f21Price) && f21Price > 0) ? f21Price
                       : (!isNaN(f5Price)  && f5Price  > 0) ? f5Price
                       : closePrice;
        price  = prePrice;
        chgPct = closePrice > 0 ? ((prePrice - closePrice) / closePrice) * 100 : 0;
      } else {
        price  = closePrice;
        chgPct = parseFloat(fields[2]);
        if (isNaN(chgPct)) chgPct = 0;
        // 盘后：fields[21] 是盘后实时价
        if (!isNaN(f21Price) && f21Price > 0) ahPrice = f21Price;
      }

      let postChgPct = 0;
      if (ahPrice && closePrice > 0) {
        postChgPct = ((ahPrice - closePrice) / closePrice) * 100;
      }
      map[symbol] = {
        symbol,
        regularMarketPrice: price,
        closePrice,
        regularMarketChangePercent: chgPct,
        regularMarketPreviousClose: prevClose,
        preMarketChangePercent: chgPct,
        postMarketChangePercent: postChgPct,
        afterHoursPrice: ahPrice,
        marketState: usState,
      };
      continue;
    }

    if (id.startsWith('rt_hk') || id.startsWith('hk')) {
      // HK stock fields (rt_hk 实时通道与 hk 延时通道字段布局一致)：
      //  [2] open  [3] prev_close  [4] high  [5] low
      //  [6] current  [7] change_amt  [8] change_%
      //  [17] 日期(YYYY/MM/DD)  [18] 时间
      // 优先 rt_hk（实时）：延时通道 hk 在收盘后冻结在收盘竞价前的价格
      // （例 ASMPT 00522 冻结于 15:58 的 172.70/+7.94%，漏掉竞价定盘 173.00/+8.13%）
      const isRtHk = id.startsWith('rt_hk');
      const ticker = isRtHk ? id.slice(5) : id.slice(2);
      const symbol = symMap.get(ticker) || symMap.get(ticker.replace(/^0+/, '')) || ticker;
      if (!isRtHk && map[symbol]) continue;  // 延时通道仅作兜底，不覆盖实时价
      const price = parseFloat(fields[6]);
      const chgPct = parseFloat(fields[8]);
      if (isNaN(price) || isNaN(chgPct)) continue;
      map[symbol] = withTradingDay({
        symbol,
        regularMarketPrice: price,
        regularMarketChangePercent: chgPct,
        regularMarketPreviousClose: parseFloat(fields[3]) || null,
        preMarketChangePercent: chgPct,
        postMarketChangePercent: 0,
        marketState: 'REGULAR',
      }, 'HK', fields[17]);
      continue;
    }

    if (id.startsWith('sh') || id.startsWith('sz') || id.startsWith('bj')) {
      // A-share fields (Sina):
      //   [0] 名称  [1] 今开  [2] 昨收  [3] 当前价  [4] 最高  [5] 最低
      //   [6] 买1价 [7] 卖1价 [8] 成交量  ...  [30] 日期  [31] 时间
      // “当日收盘价”：A 股盘后 fields[3] 即为收盘价；盘中为最新价。两者均取 fields[3]。
      const ticker = id.slice(2);
      const symbol = symMap.get(ticker) || ticker;
      const prevClose = parseFloat(fields[2]);
      const price     = parseFloat(fields[3]);
      if (isNaN(price) || isNaN(prevClose) || prevClose <= 0) continue;
      const chgPct = ((price - prevClose) / prevClose) * 100;
      // fields[30] = 该报价所属交易日；不是今天即休市（节假日/周末）
      map[symbol] = withTradingDay({
        symbol,
        regularMarketPrice: price,
        regularMarketPreviousClose: prevClose,
        regularMarketChangePercent: chgPct,
        preMarketChangePercent: chgPct,
        postMarketChangePercent: 0,
        marketState: 'REGULAR',
      }, 'CN', fields[30]);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
//  夜盘代理映射表
//  指数ETF 夜盘代理：Yahoo 不可达时回落到外盘期货
//    QQQ/IXIC → NQ (纳斯达克100 期货)
//    SPY      → ES (标普500 期货)
//    VIXY     → 无合适期货代理，保留 sina 盘后数据（可能滞后）
// ─────────────────────────────────────────────────────────────
const FUTURES_PROXY = { QQQ: 'NQ', IXIC: 'NQ', SPY: 'ES' };

// 个股夜盘代理：ET 20:00 后 ECN 夜盘价免费 API 取不到。
// 回退方案：夜盘涨跌 = sina 20:00 ET 盘后涨跌 + β × (NQ/ES 期货从 20:00 到现在的 delta)
// delta 用 "期货当前涨跌 - QQQ/SPY 20:00 盘后涨跌" 近似（期货和 ETF 在 20:00 收盘时价差小）
// STOCK_BETA: 行业经验值，参考常用 regress-to-NDX beta
//   HIGH (1.5+): 高波动 AI/半导体龙头
//   MED (1.0-1.3): 主流科技/大盘科技股 (默认)
//   LOW_SPY (0.5-0.8): 医药/消费类，跟踪 ES 更合适
//   STABLE (<0.5): 低 beta 蓝筹
const STOCK_BETA = {
  // 高 beta 科技（NQ）
  NVDA: 1.8, TSLA: 2.0, SMCI: 2.5, ARM: 1.8, PONY: 2.2, NBIS: 2.5, RIVN: 2.3, NIO: 2.0, ALAB: 2.0,
  MRVL: 1.6, AMD: 1.7, MU: 1.6, SNDK: 1.6, WDC: 1.5, STX: 1.4, COHR: 1.7, LITE: 1.7,
  ONTO: 1.6, MPWR: 1.5, LRCX: 1.5, KLAC: 1.4, AMAT: 1.4, ASML: 1.4, TER: 1.5,
  // 中 beta 科技（NQ）
  AAPL: 1.1, MSFT: 1.0, GOOG: 1.1, GOOGL: 1.1, META: 1.3, AMZN: 1.2, NFLX: 1.3,
  AVGO: 1.3, TSM: 1.3, INTC: 1.1, CSCO: 0.9, ADBE: 1.2, UMC: 1.2, STM: 1.2,
  MKSI: 1.3, GLW: 1.0, NOK: 0.9,
  // 低 beta （SPY 更合适）
  LLY: 0.5, RACE: 0.8,
};

// beta 查不到时默认 1.0 （主流科技股）
// 医药/消费 (beta<0.9) 用 ES 代理，其余用 NQ 代理
function stockFuturesProxy(sym) {
  const beta = STOCK_BETA[sym] ?? 1.0;
  const useES = beta < 0.9;
  return { beta, futSym: useES ? 'ES' : 'NQ' };
}

// ─────────────────────────────────────────────────────────────
//  夜盘涨跌幅统一计算 —— eastmoney 主源路径 与 新浪兜底路径 共用
//
//  口径：以「正股收盘价」为基准（富途/长桥/雪球 percent_night_session 同款）。
//        切勿再用「昨收」做基准，否则会把正股当日涨跌叠加进来，数值系统性偏大。
//  优先级：新鲜雪球夜盘 > Yahoo fullday > 外盘期货代理 > β 近似估算
//  返回 { overnightChangePercent, overnightPrice, overnightSource,
//         overnightEstimated, overnightAsOf }
// ─────────────────────────────────────────────────────────────
function computeOvernightQuote({
  symbol,
  closeForOvernight,
  sina,
  yahoo,
  xq,
  etfFut,
  overnightSessionStart,
  esDelta,
  nqDelta,
}) {
  // Yahoo fullday 只有在「确实比正股收盘 / 盘后价更新」时才采信：
  // 若其值等于收盘价或盘后价，说明它并不覆盖隔夜盘，直接跳过，
  // 避免拿盘后价冒充夜盘价。
  const yahooFullday = yahoo && isFinite(yahoo.fulldayPrice) ? yahoo.fulldayPrice : null;
  const yahooCoversOvernight =
    yahooFullday != null &&
    isFinite(yahoo.fulldayChangePercent) &&
    Math.abs(yahooFullday - (closeForOvernight || 0)) > 1e-6 &&
    // 相对容差 0.1%：Yahoo 的 fullday 价经常只是盘后价多保留了几位小数
    // （实测 MKSI：286.569 vs 盘后 286.5685，差 0.0005 绝对容差拦不住），
    // 差异小于 0.1% 视为"未覆盖夜盘"，避免拿盘后价冒充夜盘价
    (!sina?.afterHoursPrice || Math.abs(yahooFullday - sina.afterHoursPrice) / sina.afterHoursPrice > 0.001);

  // 雪球夜盘（富途同款 Blue Ocean 通道）是否可用：
  //   个股 = 时间戳落在"本轮夜盘"内；指数 ETF 有连续期货代理，雪球滞后时改用期货。
  const xqTs = xq && xq.timestampNight != null ? xq.timestampNight : null;
  const xqAge = xqTs ? Date.now() - xqTs : Infinity;
  const xqInSession = xqTs != null && xqTs >= overnightSessionStart - 30 * 60000;
  const xqFreshEnough = !etfFut || xqAge <= XUEQIU_ETF_MAX_LAG_MS;
  const xqPrice = xq && xq.currentNight != null ? xq.currentNight : null;

  let chg = null;
  let price = null;
  let source = null;

  if (xqInSession && xqFreshEnough && xqPrice != null && closeForOvernight > 0) {
    // 雪球自带的 percent_night_session 即"相对正股收盘价"的夜盘涨跌幅，
    // 与富途 App 完全同口径，优先直接采用，避免自行换算再引入偏差。
    chg = isFinite(xq.percentNight)
      ? xq.percentNight
      : ((xqPrice - closeForOvernight) / closeForOvernight) * 100;
    price = xqPrice;
    source = 'xueqiu';
  } else if (xq && xq.currentExt != null && isFinite(xq.percentExt)) {
    // 夜盘 tick 尚未刷新（本轮夜盘还没成交推送）时，退而用雪球扩展行情
    // current_ext/percent_ext——盘后+夜盘连续的最新成交价，同样以正股收盘为基准
    // （实测 MKSI：ext 282.48/+1.19% vs 收盘 279.15；盘后 tape 的 286.57/+2.66%
    //  是坏 print，富途夜盘 279.96/+0.29% —— ext 介于两者之间且随成交滚动）
    chg = xq.percentExt;
    price = xq.currentExt;
    source = 'xueqiu-ext';
  } else if (yahooCoversOvernight) {
    // Yahoo fullday（含盘前/盘后/隔夜），海外网络可达时为实时值
    chg = yahoo.fulldayChangePercent;
    price = yahooFullday;
    source = 'yahoo';
  } else if (etfFut) {
    // 指数 ETF：外盘期货代理（NQ/ES）
    chg = etfFut.chgPct;
    price = closeForOvernight ? closeForOvernight * (1 + etfFut.chgPct / 100) : null;
    source = 'futures';
  } else {
    // 个股：盘后涨跌 + β × 期货增量（近似估算）
    const post20 = sina?.postMarketChangePercent ?? 0;
    const { beta, futSym } = stockFuturesProxy(symbol);
    const delta = futSym === 'ES' ? esDelta : nqDelta;
    const extra = isFinite(delta) && delta != null ? beta * delta : 0;
    chg = post20 + extra;
    price = closeForOvernight ? closeForOvernight * (1 + chg / 100) : (sina?.afterHoursPrice ?? null);
    source = 'proxy';
  }
  if (!isFinite(chg)) chg = 0;

  // 实测值（xueqiu/yahoo）即便略有滞后也不加"≈"——它是真实成交价；
  // 只有 futures/proxy 这类模型推算值才需要标注为估算。
  return {
    overnightChangePercent: chg,
    overnightPrice: price,
    overnightSource: source,
    overnightEstimated: source !== 'xueqiu' && source !== 'xueqiu-ext' && source !== 'yahoo',
    overnightAsOf: source === 'xueqiu' ? (xqTs ?? null) : null,
    overnightLagMin: source === 'xueqiu' && xqTs ? Math.max(0, Math.round((Date.now() - xqTs) / 60000)) : null,
  };
}

app.get('/api/quotes', async (req, res) => {
  const diag = req.query.diag === '1';
  const raw = (req.query.symbols || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols required' });
  const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const cacheKey = [...symbols].sort().join(',');
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < QUOTE_TTL) {
    return res.json({ success: true, data: cached.data, cached: true });
  }

  // Route each symbol: eastmoney(US) → Naver(KR) → TWSE(TW) → Tencent(JP) → Yahoo(SG) → Sina(forex/HK/A股/兜底)
  const krSymbols   = symbols.filter((s) =>  isKoreanSymbol(s));
  const twSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && isTaiwanSymbol(s));
  const jpSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && isJapanSymbol(s));
  const yhSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isJapanSymbol(s) && isYahooSymbol(s));
  const emSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isJapanSymbol(s) && !isYahooSymbol(s) && emSecid(s));
  const sinaSymbols = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isJapanSymbol(s) && !isYahooSymbol(s) && !emSecid(s));
  const secidToSym  = new Map(emSymbols.map((s) => [emSecid(s), s]));

  try {
    // 1) eastmoney 主源(美股)，失败的标的回落到新浪
    let emMap = {};
    if (emSymbols.length) {
      try {
        const txt = await fetchEastmoney(emSymbols.map(emSecid));
        emMap = parseEastmoney(txt, secidToSym);
      } catch (e) {
        console.error('[eastmoney]', e.message);
      }
    }
    const emMissing = emSymbols.filter((s) => !emMap[s]);
    const usState = getUSMarketState();
    // Always fetch Sina for all US stocks to get after-hours data (field[21])
    // 夜盘时段还要额外拉 QQQ/SPY 作为 β 代理的 20:00 基准（即使调用方没请求这两个）
    const sinaReferences = usState === 'OVERNIGHT' ? ['QQQ', 'SPY'] : [];
    const sinaAll = [...new Set([...sinaSymbols, ...emMissing, ...emSymbols.filter((s) => emMap[s]), ...sinaReferences])];

    const [emData, sinaData, krData, twData, jpData, yhData, yhExtData, futuresData, xueqiuData] = await Promise.all([
      emSymbols.map((s) => emMap[s]).filter(Boolean),
      (async () => {
        if (sinaAll.length === 0) return [];
        // 港股额外请求延时(hk)通道作兜底：实时 rt_hk 缺失时才有用（解析时实时优先）
        const hkFallbackIds = sinaAll
          .filter((s) => /^\d{4,5}$/.test(s))
          .map((s) => 'hk' + s.padStart(5, '0'));
        const text = await fetchSina([...sinaAll.map(toSinaId), ...hkFallbackIds]);
        const m = parseSinaResponse(text, sinaAll);
        return { map: m, list: sinaAll.map((s) => m[s]).filter(Boolean) };
      })(),
      // 韩股双源并行，按报价时间戳(sourceTimeMs)取更新者：
      //   盘中：腾讯 kr 通道滞后数十分钟，Naver 实时 → Naver 胜出
      //   收盘后：Naver 冻结在 15:20 竞价前旧价，腾讯为 15:30 定盘价 → 腾讯胜出
      // 单边失败时用另一边兜底
      (async () => {
        if (!krSymbols.length) return [];
        const [tencentKr, naverList] = await Promise.all([
          fetchTencentKrQuotes(krSymbols).catch((e) => {
            console.error('[tencent-kr]', e.message);
            return {};
          }),
          Promise.all(
            krSymbols.map((s) =>
              fetchKoreanQuote(s).catch((e) => {
                console.error('[naver]', s, e.message);
                return null;
              })
            )
          ),
        ]);
        const naverMap = {};
        for (const q of naverList) if (q) naverMap[q.symbol] = q;
        return krSymbols
          .map((s) => {
            const t = tencentKr[s], n = naverMap[s];
            if (t && n) {
              if (t.marketState === 'CLOSED') return t;
              return (n.sourceTimeMs ?? 0) > (t.sourceTimeMs ?? 0) ? n : t;
            }
            return t || n;
          })
          .filter(Boolean);
      })(),
      twSymbols.length
        ? fetchTaiwanQuotes(twSymbols).catch((e) => {
            console.error('[twse]', e.message);
            return [];
          })
        : [],
      jpSymbols.length
        ? fetchJapanQuotes(jpSymbols).then((m) => Object.values(m)).catch((e) => {
            console.error('[tencent-jp]', e.message);
            return [];
          })
        : [],
      Promise.all(
        yhSymbols.map((s) =>
          fetchYahooQuote(s).catch((e) => {
            console.error('[yahoo]', s, e.message);
            return null;
          })
        )
      ).then((arr) => arr.filter(Boolean)),
      // 夜盘/盘前时段：Yahoo fullday 走后台扫描（直连→Render代理→Vercel 链路，
      // 全量标的需数分钟），请求路径直接用缓存快照，绝不阻塞行情响应
      (usState === 'OVERNIGHT' || usState === 'PRE') && emSymbols.length
        ? (async () => { kickYahooExtSweep(emSymbols); return yahooExtSnapshot(emSymbols); })()
        : Promise.resolve(new Map()),
      // 夜盘时段：拉取外盘期货 (NQ/ES/YM) 作为指数ETF夜盘代理
      // Yahoo 在国内被阻断(403)时，这是唯一与富途一致的实时夜盘涨跌来源
      usState === 'OVERNIGHT'
        ? fetchSinaFutures(['NQ', 'ES', 'YM']).catch((e) => {
            console.error('[sina-futures]', e.message);
            return {};
          })
        : Promise.resolve({}),
      // 夜盘时段：拉取雪球个股夜盘数据（可能需要会话 cookie，失败时静默回退到 β 代理）
      usState === 'OVERNIGHT' && emSymbols.length
        ? fetchXueqiuQuotes(emSymbols).catch((e) => {
            console.error('[xueqiu bulk]', e.message);
            return new Map();
          })
        : Promise.resolve(new Map()),
    ]);

    // Merge: for symbols that have both eastmoney and sina data,
    // use eastmoney as base but overlay sina data by session:
    // PRE: sina fields[5] 是盘前实时价，EM f2 盘前返回昨收，需用新浪覆盖
    // POST/CLOSED: EM f2 是盘后实时价，比新浪更新更快，优先用 EM
    // （FUTURES_PROXY / STOCK_BETA / stockFuturesProxy 已提到模块作用域，见文件上方）
    const sinaMap = (sinaData && sinaData.map) || {};
    // 期货相对 20:00 ET 的 delta（代理 20:00 之后的夜盘波动）
    // 使用 NQ 和 ES 的当前涨跌幅减去 QQQ/SPY 20:00 盘后涨跌，近似"20:00 以后的增量"
    let nqDelta = null;  // percent, 20:00 之后 NQ 的增量
    let esDelta = null;  // percent, 20:00 之后 ES 的增量
    if (usState === 'OVERNIGHT') {
      const nqNow = futuresData?.NQ?.chgPct;
      const esNow = futuresData?.ES?.chgPct;
      const qqq20 = sinaMap?.QQQ?.postMarketChangePercent;
      const spy20 = sinaMap?.SPY?.postMarketChangePercent;
      if (isFinite(nqNow) && isFinite(qqq20)) nqDelta = nqNow - qqq20;
      if (isFinite(esNow) && isFinite(spy20)) esDelta = esNow - spy20;
    }
    // 本轮夜盘起点 + 雪球夜盘覆盖情况（判定逻辑详见 usOvernightSessionStart 说明）
    const overnightSessionStart = usOvernightSessionStart();
    let xqNightLatestTs = 0;
    let xqInSessionCount = 0;
    if (xueqiuData && xueqiuData.size) {
      for (const v of xueqiuData.values()) {
        if (!v || !v.timestampNight) continue;
        if (v.timestampNight > xqNightLatestTs) xqNightLatestTs = v.timestampNight;
        if (v.timestampNight >= overnightSessionStart - 30 * 60000) xqInSessionCount++;
      }
    }
    if (usState === 'OVERNIGHT') {
      const ageMin = xqNightLatestTs ? Math.round((Date.now() - xqNightLatestTs) / 60000) : -1;
      console.log(
        `[overnight] 雪球夜盘：${xqInSessionCount}/${xueqiuData ? xueqiuData.size : 0} 个标的处于本轮夜盘内` +
        `，最新推送 ${xqNightLatestTs ? new Date(xqNightLatestTs).toISOString() : 'n/a'}（距今 ${ageMin} 分钟）`
      );
    }

    const mergedEmData = emData.map((em) => {
      // 夜盘时段（ET 20:00 - 04:00，个股无盘后交易）：
      //   优先 雪球 current_night_session / percent_night_session（富途同款数据源，个股/ETF 都覆盖）
      //   回退 Yahoo fulldayPrice > 期货代理（指数ETF）> β 近似（个股）
      if (usState === 'OVERNIGHT') {
        const sina = sinaMap[em.symbol];
        const closeForOvernight = sina?.regularMarketPrice || em.regularMarketPrice;
        const emFutSym = FUTURES_PROXY[em.symbol];
        return {
          ...em,
          ...computeOvernightQuote({
            symbol: em.symbol,
            closeForOvernight,
            sina,
            yahoo: yhExtData && yhExtData.get(em.symbol),
            xq: xueqiuData && xueqiuData.get(em.symbol),
            etfFut: emFutSym ? futuresData[emFutSym] : null,
            overnightSessionStart,
            esDelta,
            nqDelta,
          }),
          marketState: 'OVERNIGHT',
          closePrice: closeForOvernight,
          regularMarketPreviousClose: sina?.regularMarketPreviousClose || em.regularMarketPreviousClose,
          postMarketChangePercent: sina?.postMarketChangePercent || 0,
          afterHoursPrice: sina?.afterHoursPrice || null,
        };
      }
      const sina = sinaMap[em.symbol];
      if (sina && sina.postMarketChangePercent !== undefined) {
        // 盘前时段：新浪盘前价(fields[5])更新极慢（滞后可达分钟级），
        // 雅虎链路（直连→代理→Vercel）的 fullday 价为真实盘前价，优先采用
        if (usState === 'PRE') {
          const yhPre = yhExtData && yhExtData.get(em.symbol);
          if (yhPre && isFinite(yhPre.fulldayPrice)) {
            return {
              ...em,
              regularMarketPrice: yhPre.fulldayPrice,
              regularMarketChangePercent: yhPre.fulldayChangePercent,
              preMarketChangePercent: yhPre.fulldayChangePercent,
              closePrice: yhPre.previousClose,
              regularMarketPreviousClose: yhPre.previousClose,
              postMarketChangePercent: sina.postMarketChangePercent || 0,
              afterHoursPrice: sina.afterHoursPrice || null,
            };
          }
          return {
            ...em,
            regularMarketPrice: sina.regularMarketPrice,           // 盘前实时价 (fields[5])
            regularMarketChangePercent: sina.regularMarketChangePercent, // 盘前涨跌幅
            preMarketChangePercent: sina.regularMarketChangePercent,
            closePrice: sina.closePrice,                           // 昨收盘价 (fields[1])
            regularMarketPreviousClose: sina.regularMarketPreviousClose || em.regularMarketPreviousClose,
            postMarketChangePercent: sina.postMarketChangePercent || 0,
            afterHoursPrice: sina.afterHoursPrice || null,
          };
        }
        // 盘后/收盘时段: eastmoney f2 已是实时盘后价，比 sina fields[21] 更新更快。
        // 优先用 eastmoney 的 regularMarketPrice 作为 afterHoursPrice。
        // sina.regularMarketPrice 是收盘价(盘中最后价)，用于24h视图计算盘后涨跌。
        const isPostClosed = (usState === 'POST' || usState === 'CLOSED');
        const emAHP = isPostClosed ? em.regularMarketPrice : null;
        const sinaClose = sina.regularMarketPrice || em.regularMarketPrice;
        return {
          ...em,
          regularMarketPrice: isPostClosed ? sinaClose : em.regularMarketPrice,
          closePrice: sinaClose,
          postMarketChangePercent: sina.postMarketChangePercent,
          afterHoursPrice: emAHP || sina.afterHoursPrice || null,
          regularMarketPreviousClose: sina.regularMarketPreviousClose || em.regularMarketPreviousClose,
        };
      }
      return em;
    });

    // For non-eastmoney symbols, use sina data directly (excluding those already in emData)
    // 排除仅作为 β 代理基准拉取的参考标的 (QQQ/SPY 若调用方未请求)
    const emSymSet = new Set(emSymbols.filter((s) => emMap[s]));
    const requestedSet = new Set(symbols);
    let puresinaData = (sinaData && sinaData.list || []).filter((q) =>
      !emSymSet.has(q.symbol) && requestedSet.has(q.symbol)
    );

    // 夜盘时段：对 sina fallback 的美股数据也注入 overnightChangePercent
    //   注意：当 eastmoney 不可达时（部分海外/受限网络环境），**所有**美股都走这条路径，
    //   所以这里必须与 em 主源路径共用 computeOvernightQuote，否则口径会分叉。
    if (usState === 'OVERNIGHT') {
      puresinaData = puresinaData.map((q) => {
        if (!emSecid(q.symbol)) return q;  // 非美股不覆盖
        const closeForOvernight = q.regularMarketPrice || q.closePrice;
        const futSym = FUTURES_PROXY[q.symbol];
        return {
          ...q,
          ...computeOvernightQuote({
            symbol: q.symbol,
            closeForOvernight,
            sina: q,
            yahoo: yhExtData && yhExtData.get(q.symbol),
            xq: xueqiuData && xueqiuData.get(q.symbol),
            etfFut: futSym ? futuresData[futSym] : null,
            overnightSessionStart,
            esDelta,
            nqDelta,
          }),
          marketState: 'OVERNIGHT',
          closePrice: closeForOvernight,
        };
      });
    }

    // 日/韩/台/港股附加「昨日涨跌幅」(yesterdayChangePercent)：缓存命中同步附加，
    // 未命中后台预取（下一轮行情请求即可带上），绝不阻塞本次响应。
    // puresinaData 里含港股/A股/参考标的，attachIntlYday 按市场集合过滤，非目标市场原样返回
    const data = [
      ...mergedEmData,
      ...puresinaData.map(attachIntlYday),
      ...krData.map(attachIntlYday),
      ...twData.map(attachIntlYday),
      ...jpData.map(attachIntlYday),
      ...yhData,
    ];
    if (data.length === 0) throw new Error('No quotes returned');
    quoteCache.set(cacheKey, { data, ts: Date.now() });
    if (diag) {
      // 诊断模式：GET /api/quotes?symbols=SNDK&diag=1
      // 用于确认各上游数据源谁真正返回了数据（例如 eastmoney 是否可达）
      return res.json({
        success: true,
        data,
        diag: {
          usState,
          eastmoneyRequested: emSymbols.length,
          eastmoneyReturned: Object.keys(emMap).length,
          sinaRequested: sinaAll.length,
          yahooExtCount: yhExtData ? yhExtData.size : 0,
          xueqiuCount: xueqiuData ? xueqiuData.size : 0,
          xqNightLatestTs: xqNightLatestTs ? new Date(xqNightLatestTs).toISOString() : null,
          xqNightInSessionCount: xqInSessionCount,
          overnightSessionStart: new Date(overnightSessionStart).toISOString(),
          xueqiuUsedCount: data.filter((q) => q.overnightSource === 'xueqiu').length,
          futuresKeys: Object.keys(futuresData || {}),
          esDelta,
          nqDelta,
          overnightPaths: {
            viaEm: mergedEmData.length,
            viaSinaFallback: puresinaData.length,
          },
        },
      });
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('[quotes]', err.message);
    const stale = quoteCache.get(cacheKey);
    if (stale) return res.json({ success: true, data: stale.data, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
//  /api/_hist — Yahoo 官方日K代理端点（韩股/台股「昨日涨跌幅」数据源）
//  本地网络出口访问 Yahoo 被墙(403)时，其他实例可通过本端点取数——
//  需本端点部署在可达 Yahoo 的环境（如 Render）。
//  用法: GET /api/_hist?symbol=005930.KS&tz=9 → { symbol, rows:[{date, close}] }
//  本出口被 Yahoo 限流(429)时走二级代理（yahoo-proxy/ 目录的 Vercel 函数，
//  不同平台 IP 池），部署后把其 URL 填入 SECONDARY_HIST_PROXY_URL 或设环境变量。
// ──────────────────────────────────────────
const HIST_API_CACHE = new Map();  // key → { data, ts }
const HIST_API_TTL = 10 * 60_000;
const SECONDARY_HIST_PROXY_URL = process.env.SECONDARY_HIST_PROXY_URL || 'https://qdii-fund-yypz.vercel.app';

app.get('/api/_hist', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const tz = Number(req.query.tz) || 8;
  if (!/^[A-Za-z0-9.\-]{1,20}$/.test(symbol)) return res.status(400).json({ error: 'bad symbol' });
  const key = symbol + ':' + tz;
  const cached = HIST_API_CACHE.get(key);
  if (cached && Date.now() - cached.ts < HIST_API_TTL) {
    return res.json(cached.data);
  }
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=1mo`;
    const text = await httpGetWithStatus(url, { Accept: 'application/json' });
    const rows = parseYahooChart(JSON.parse(text), tz);
    const out = { symbol, rows };
    HIST_API_CACHE.set(key, { data: out, ts: Date.now() });
    res.json(out);
  } catch (err) {
    // 二级代理（防自引用：本端点若被部署在二级代理同一域名上会死循环）
    let secondaryUrl = SECONDARY_HIST_PROXY_URL;
    try {
      if (secondaryUrl && req.headers.host && new URL(secondaryUrl).host === req.headers.host) {
        secondaryUrl = '';
      }
    } catch { /* URL 解析失败则不跳过 */ }
    if (secondaryUrl) {
      try {
        // 注意 Vercel 函数路由是 /api/hist（下划线开头的文件 Vercel 不注册路由）
        const text = await httpGet(
          `${secondaryUrl}/api/hist?symbol=${encodeURIComponent(symbol)}&tz=${tz}`,
          { Accept: 'application/json' }
        );
        const j = JSON.parse(text);
        if (j && Array.isArray(j.rows)) {
          HIST_API_CACHE.set(key, { data: j, ts: Date.now() });
          return res.json(j);
        }
        return res.status(502).json({ error: err.message, secondary: text.slice(0, 200) });
      } catch (e2) {
        return res.status(502).json({ error: err.message, secondary: e2.message });
      }
    }
    if (cached) return res.json({ ...cached.data, stale: true });
    res.status(502).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
//  /api/fullday — 美股夜盘(fulldayPrice)代理端点，链路同 /api/_hist：
//  直连雅虎（本出口 429 时走 Vercel 二级代理），60s 缓存去重。
//  用法: GET /api/fullday?symbol=ASML
// ──────────────────────────────────────────
const FULLDAY_API_CACHE = new Map();  // sym → { data, ts }
const FULLDAY_API_TTL = 60_000;

// 雪球美股夜盘代理 — 本机/其他出口 IP 被雪球反爬拉黑时的兜底数据源。
// 用法: GET /api/night?symbol=MKSI → { symbol, currentNight, percentNight,
//       chgNight, timestampNight }（percentNight 与富途「夜盘」涨幅同源同口径）
// 注意：allowProxy=false —— 本路由只做直连取数，绝不递归调用代理
app.get('/api/night', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!/^[A-Za-z0-9_\-]{1,10}$/.test(symbol)) return res.status(400).json({ error: 'bad symbol' });
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  const d = await fetchXueqiuQuote(symbol, { allowProxy: false });
  if (!d || d.currentNight == null) return res.status(404).json({ error: 'no night data' });
  res.json({
    symbol,
    currentNight: d.currentNight,
    percentNight: d.percentNight,
    chgNight: d.chgNight,
    timestampNight: d.timestampNight,
    // 扩展行情（盘后+夜盘连续报价）与市场状态，供排查口径用
    currentExt: d.currentExt,
    percentExt: d.percentExt,
    timestampExt: d.timestampExt,
    current: d.current,
    status: d.status,
  });
});

app.get('/api/fullday', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!/^[A-Za-z0-9.\-]{1,20}$/.test(symbol)) return res.status(400).json({ error: 'bad symbol' });
  const cached = FULLDAY_API_CACHE.get(symbol);
  if (cached && Date.now() - cached.ts < FULLDAY_API_TTL) {
    return res.json(cached.data);
  }
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&range=1d&includePrePost=true`;
    const text = await httpGetWithStatus(url, { Accept: 'application/json' });
    const j = JSON.parse(text);
    const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!meta) return res.status(502).json({ error: 'empty result' });
    if (!meta.hasPrePostMarketData) {
      const out = { symbol, noPrePost: true };
      FULLDAY_API_CACHE.set(symbol, { data: out, ts: Date.now() });
      return res.json(out);
    }
    const out = {
      symbol,
      fulldayPrice: meta.fulldayPrice,
      fulldayChange: meta.fulldayChange,
      fulldayChangePercent: meta.fulldayChangePercent,
      previousClose: meta.chartPreviousClose || meta.previousClose,
      regularMarketPrice: meta.regularMarketPrice,
    };
    FULLDAY_API_CACHE.set(symbol, { data: out, ts: Date.now() });
    res.json(out);
  } catch (err) {
    // 二级代理（Vercel api/fullday，防自引用同 /api/_hist）
    let secondaryUrl = SECONDARY_HIST_PROXY_URL;
    try {
      if (secondaryUrl && req.headers.host && new URL(secondaryUrl).host === req.headers.host) {
        secondaryUrl = '';
      }
    } catch { /* URL 解析失败则不跳过 */ }
    if (secondaryUrl) {
      try {
        const text = await httpGet(
          `${secondaryUrl}/api/fullday?symbol=${encodeURIComponent(symbol)}`,
          { Accept: 'application/json' }
        );
        const j = JSON.parse(text);
        if (j && (j.fulldayPrice != null || j.noPrePost)) {
          FULLDAY_API_CACHE.set(symbol, { data: j, ts: Date.now() });
          return res.json(j);
        }
        return res.status(502).json({ error: err.message, secondary: text.slice(0, 200) });
      } catch (e2) {
        return res.status(502).json({ error: err.message, secondary: e2.message });
      }
    }
    if (cached) return res.json({ ...cached.data, stale: true });
    res.status(502).json({ error: err.message });
  }
});

// 调试端点：直接调用 Yahoo fullday fetcher 验证夜盘数据源
// 用法: GET /api/_debug/yahoo-ext?symbols=TSM,NVDA,AAPL
if (process.env.DEBUG_YAHOO === '1') {
  app.get('/api/_debug/yahoo-ext', async (req, res) => {
    const symbols = (req.query.symbols || 'TSM,NVDA,AAPL,QQQ')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const map = await fetchYahooExtended(symbols);
    const out = {};
    for (const [sym, data] of map) out[sym] = data;
    res.json({ symbols, result: out, count: map.size });
  });
}

// ═══════════════════════════════════════════════════════
//  /api/ashare-ma — 上证指数 & 创业板指数 MA20 数据
// ═══════════════════════════════════════════════════════
const MA_CACHE = { data: null, ts: 0 };
const MA_TTL = 3600_000; // 1小时缓存

async function fetchKline(sinaSymbol, limit = 25) {
  const url =
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData` +
    `?symbol=${sinaSymbol}&scale=240&ma=no&datalen=${limit}`;
  const txt = await httpGet(url, { Referer: 'https://finance.sina.com.cn/' });
  const arr = JSON.parse(txt);
  return arr.map(k => ({ date: k.day, close: parseFloat(k.close), volume: parseFloat(k.volume) || 0 }));
}

function calcMA(klines, period) {
  if (klines.length < period) return null;
  const recent = klines.slice(-period);
  const sum = recent.reduce((a, k) => a + k.close, 0);
  return sum / period;
}

app.get('/api/ashare-ma', async (req, res) => {
  if (MA_CACHE.data && Date.now() - MA_CACHE.ts < MA_TTL) {
    return res.json({ success: true, ...MA_CACHE.data });
  }
  try {
    const [shKlines, cyKlines, etfKlines] = await Promise.all([
      fetchKline('sh000001', 25),
      fetchKline('sz399006', 25),
      fetchKline('sz159509', 25),
    ]);

    const shPrice = shKlines.length ? shKlines[shKlines.length - 1].close : null;
    const shMa20 = calcMA(shKlines, 20);
    const cyPrice = cyKlines.length ? cyKlines[cyKlines.length - 1].close : null;
    const cyMa20 = calcMA(cyKlines, 20);

    // 159509 ETF: 价格、MA20偏离、成交量比
    const etfPrice = etfKlines.length ? etfKlines[etfKlines.length - 1].close : null;
    const etfMa20 = calcMA(etfKlines, 20);
    const etfVolume = etfKlines.length ? etfKlines[etfKlines.length - 1].volume : null;
    const etfVolMa20 = etfKlines.length >= 20
      ? etfKlines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20
      : null;

    const result = {
      sh: {
        price: shPrice,
        ma20: shMa20 ? +shMa20.toFixed(2) : null,
        aboveMa20: shPrice && shMa20 ? shPrice >= shMa20 : null,
        deviation: shPrice && shMa20 ? +((shPrice - shMa20) / shMa20 * 100).toFixed(2) : null,
      },
      cy: {
        price: cyPrice,
        ma20: cyMa20 ? +cyMa20.toFixed(2) : null,
        aboveMa20: cyPrice && cyMa20 ? cyPrice >= cyMa20 : null,
        deviation: cyPrice && cyMa20 ? +((cyPrice - cyMa20) / cyMa20 * 100).toFixed(2) : null,
      },
      etf159509: {
        price: etfPrice,
        ma20: etfMa20 ? +etfMa20.toFixed(4) : null,
        deviation: etfPrice && etfMa20 ? +((etfPrice - etfMa20) / etfMa20 * 100).toFixed(2) : null,
        volume: etfVolume,
        volMa20: etfVolMa20 ? Math.round(etfVolMa20) : null,
        volRatio: etfVolume && etfVolMa20 ? +(etfVolume / etfVolMa20).toFixed(2) : null,
      },
    };

    MA_CACHE.data = result;
    MA_CACHE.ts = Date.now();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[ashare-ma]', err.message);
    if (MA_CACHE.data) return res.json({ success: true, ...MA_CACHE.data, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  /api/index-ma — 四大指数均线预警
//  上证(新浪) · 创业板(新浪) · 纳指ETF 513100(新浪) · KOSPI(Naver)
// ═══════════════════════════════════════════════════════
const INDEX_MA_CACHE = { data: null, ts: 0 };
const INDEX_MA_TTL = 3600_000; // 1小时缓存

// 新浪日K（已有 fetchKline，复用）
// Naver KOSPI 历史 JSON
async function fetchNaverIndexKline(symbol, startYYYYMMDD) {
  const url =
    `https://api.finance.naver.com/siseJson.naver` +
    `?symbol=${encodeURIComponent(symbol)}&requestType=1` +
    `&startTime=${startYYYYMMDD}&endTime=20501231&timeframe=day`;
  const txt = await httpGet(url, { 'Accept-Language': 'ko-KR,en;q=0.9' });
  const rows = [];
  const re = /\["(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    rows.push({ date: m[1], close: parseFloat(m[5]) });
  }
  return rows;
}

function calcIndexMAs(klines) {
  const periods = [5, 21, 60, 120, 250];
  const result = {};
  for (const p of periods) {
    if (klines.length < p) { result[`ma${p}`] = null; continue; }
    result[`ma${p}`] = klines.slice(-p).reduce((s, k) => s + k.close, 0) / p;
  }
  // 判断 MA5 下穿各均线
  const ma5 = result.ma5;
  result.crossBelow = {
    ma21:  ma5 !== null && result.ma21  !== null && ma5 < result.ma21,
    ma60:  ma5 !== null && result.ma60  !== null && ma5 < result.ma60,
    ma120: ma5 !== null && result.ma120 !== null && ma5 < result.ma120,
    ma250: ma5 !== null && result.ma250 !== null && ma5 < result.ma250,
  };
  result.price = klines.length ? klines[klines.length - 1].close : null;
  return result;
}

app.get('/api/index-ma', async (req, res) => {
  if (INDEX_MA_CACHE.data && Date.now() - INDEX_MA_CACHE.ts < INDEX_MA_TTL) {
    return res.json({ success: true, ...INDEX_MA_CACHE.data });
  }
  try {
    // 需要约2年数据覆盖 MA250，取 startTime = 2年前
    const start = new Date();
    start.setFullYear(start.getFullYear() - 2);
    const startStr = start.toISOString().slice(0, 10).replace(/-/g, '');
    const sinaLimit = 280; // 日K约280条覆盖250日线

    const [shKlines, cyKlines, ndxKlines, kospiKlines] = await Promise.all([
      fetchKline('sh000001', sinaLimit),
      fetchKline('sz399006', sinaLimit),
      fetchKline('sh513100', sinaLimit),   // 纳指100ETF
      fetchNaverIndexKline('KOSPI', startStr),
    ]);

    const result = {
      sh:    { name: '上证',      ...calcIndexMAs(shKlines)    },
      cy:    { name: '创业板',    ...calcIndexMAs(cyKlines)    },
      ndx:   { name: '纳斯达克',  ...calcIndexMAs(ndxKlines)   },
      kospi: { name: 'KOSPI',    ...calcIndexMAs(kospiKlines) },
    };

    INDEX_MA_CACHE.data = result;
    INDEX_MA_CACHE.ts = Date.now();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[index-ma]', err.message);
    if (INDEX_MA_CACHE.data) return res.json({ success: true, ...INDEX_MA_CACHE.data, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  /api/index-macd — 四大指数 MACD 柱状数据
//  上证(sh000001) · 创业板(sz399006) · 纳指100ETF(sh513100) · KOSPI(Naver)
//  日K数据来源：腾讯财经（新浪接口 scale=240 为周K，无日K）
// ═══════════════════════════════════════════════════════

// 判断当前是否在 A 股交易时间（北京时间 9:30~11:30 或 13:00~15:00，周一至周五）
function isAShareTradingTime() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return (t >= 570 && t <= 690) || (t >= 780 && t <= 900);
}

// 判断当前是否在 A 股收盘后的工作日（北京时间 15:00~23:59，周一至周五）
function isAShareAfterHours() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return t >= 900; // 15:00 之后
}

// 获取 Sina 实时行情（用于 MACD 盘中柱），返回 { sinaId: { price, date } }
async function fetchSinaRealtimePrice(sinaIds) {
  const txt = await new Promise((resolve, reject) => {
    const url = `https://hq.sinajs.cn/list=${sinaIds.join(',')}`;
    const req = https.get(url, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  const result = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/hq_str_([^=]+)="([^"]*)"/);
    if (!m) continue;
    const fields = m[2].split(',');
    const price = parseFloat(fields[3]);
    const date = fields[30] && fields[30].trim();
    if (price > 0 && date) result[m[1]] = { price, date };
  }
  return result;
}

// 腾讯财经日K：[日期, 开, 收, 高, 低, 量]
async function fetchTencentDayKline(symbol, limit = 120) {
  const j = await fetchTencentIfzqJson(`/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`);
  const sym = j && j.data && j.data[symbol];
  const rows = (sym && (sym.day || sym.qfqday)) || [];
  // 注意 r[1]=开 r[2]=收（曾误用 r[1]，等于拿开盘价算 MACD）
  return rows.map(r => ({ date: r[0], close: parseFloat(r[2]) }));
}

// 港股日K（腾讯 hk 前缀通道，官方收盘价）
async function fetchTencentHkDaily(symbol, limit = 20) {
  const j = await fetchTencentIfzqJson(`/appstock/app/fqkline/get?param=hk${symbol},day,,,${limit},qfq`);
  const node = j && j.data && j.data[`hk${symbol}`];
  const rows = (node && (node.day || node.qfqday)) || [];
  return rows.map(r => ({ date: r[0], close: parseFloat(r[2]) })).filter(r => r.date && isFinite(r.close));
}
const INDEX_MACD_CACHE = { data: null, ts: 0 };
const INDEX_MACD_TTL_NORMAL  = 3600_000; // 非交易时间：1小时
const INDEX_MACD_TTL_TRADING =  180_000; // 交易时间内：3分钟

// 计算 EMA
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = closes[0];
  result.push(ema);
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// 计算 MACD: 返回最近 N 根柱状值 [{date, bar, dif, dea, signal?, intraday?}]
// 信号算法：金叉/死叉 + 零轴位置 + MA5/MA21 趋势过滤
//   金叉（DIF 上穿 DEA）：
//     零轴上方金叉 + MA5>MA21（多头）→ 强买入 'buy'
//     零轴下方金叉 + MA5<MA21（空头）→ 弱买入 'buy_weak'
//   死叉（DIF 下穿 DEA）：
//     零轴上方死叉 + MA5>MA21（多头）→ 强卖出 'sell'
//     零轴下方死叉 + MA5<MA21（空头）→ 弱卖出忽略（已在跌，意义不大）
function calcMACD(klines, barCount = 26) {
  if (klines.length < 35) return [];
  const closes = klines.map(k => k.close);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEMA(dif, 9);

  // 计算每根柱对应位置的 MA5 / MA21
  const ma5arr  = closes.map((_, i) => i >= 4  ? closes.slice(i - 4,  i + 1).reduce((s, v) => s + v, 0) / 5  : null);
  const ma21arr = closes.map((_, i) => i >= 20 ? closes.slice(i - 20, i + 1).reduce((s, v) => s + v, 0) / 21 : null);

  const bars = [];
  const start = Math.max(0, klines.length - barCount);
  for (let i = start; i < klines.length; i++) {
    const entry = {
      date: klines[i].date,
      close: klines[i].close,   // 供 ETF 跟踪视图标注信号价位
      dif: dif[i],
      dea: dea[i],
      bar: (dif[i] - dea[i]) * 2,
    };
    if (klines[i].intraday) entry.intraday = true;
    bars.push(entry);
  }

  // 标记信号：在完整 klines 上检测所有金叉/死叉（从第1根开始）
  for (let i = 1; i < klines.length; i++) {
    const goldenCross = dif[i - 1] < dea[i - 1] && dif[i] >= dea[i];
    const deathCross  = dif[i - 1] > dea[i - 1] && dif[i] <= dea[i];
    if (!goldenCross && !deathCross) continue;

    const aboveZero = dif[i] > 0;
    const ma5  = ma5arr[i];
    const ma21 = ma21arr[i];
    if (ma5 === null || ma21 === null) continue;
    const bullTrend = ma5 > ma21;
    const bearTrend = ma5 < ma21;

    let sig = null;
    if (goldenCross) {
      if (aboveZero && bullTrend) sig = 'buy';
      else if (!aboveZero && bearTrend) sig = 'buy_weak';
    } else if (deathCross) {
      if (aboveZero && bullTrend) sig = 'sell';
      else if (!aboveZero && bearTrend) sig = 'sell_weak'; // 零轴下方死叉 + 空头：弱卖
    }
    if (!sig) continue;

    if (i >= start) {
      bars[i - start].signal = sig;
    } else {
      bars[0].signal = sig;
    }
  }

  // 跌破 MA21 卖点：收盘价从上方下穿 MA21（前一天>=MA21，当天<MA21）
  for (let i = 1; i < klines.length; i++) {
    const ma21cur  = ma21arr[i];
    const ma21prev = ma21arr[i - 1];
    if (ma21cur === null || ma21prev === null) continue;
    const breakBelow = closes[i - 1] >= ma21prev && closes[i] < ma21cur;
    if (!breakBelow) continue;

    if (i >= start) {
      // sell_ma 优先级最高，直接覆盖同一柱上的其他卖出信号
      const bar = bars[i - start];
      if (!bar.signal || bar.signal.startsWith('sell')) bar.signal = 'sell_ma';
    } else {
      if (!bars[0].signal || bars[0].signal.startsWith('sell')) bars[0].signal = 'sell_ma';
    }
  }

  // 柱子缩量见底预警：在负值区间缩量最小那根打 buy_pre，正值区间同理打 sell_pre
  // 逻辑：遍历每一次从翻负到翻正的完整下行波段，找波段内 bar 绝对值最小的那根（缩量底）
  //        在那根柱上打 buy_pre；sell_pre 同理找正值区间的缩量顶
  const barVals = new Array(klines.length).fill(0);
  for (let i = 0; i < klines.length; i++) barVals[i] = (dif[i] - dea[i]) * 2;
  // 动态阈值：整体均值 * 0.15，避免零轴附近微弱波段
  const absWindow = barVals.slice(Math.max(0, klines.length - 60)).map(Math.abs);
  const avgAbs = absWindow.reduce((s, v) => s + v, 0) / absWindow.length;
  const minAbs = Math.max(avgAbs * 0.15, 0.001);

  // 找负值波段缩量底 → buy_pre（标在翻红前一天，即缩量最小那根）
  let negStart = -1;
  for (let i = 0; i <= klines.length; i++) {
    const val = i < klines.length ? barVals[i] : null;
    if (val !== null && val < 0) {
      if (negStart < 0) negStart = i; // 波段开始
    } else {
      // 波段结束（val >= 0 或越界）
      if (negStart >= 0) {
        const segEnd = i - 1; // 最后一根负值柱
        // 找波段内绝对值最小的那根（即缩量见底）
        let minIdx = negStart;
        for (let j = negStart + 1; j <= segEnd; j++) {
          if (Math.abs(barVals[j]) < Math.abs(barVals[minIdx])) minIdx = j;
        }
        // 波段幅度需超过阈值（排除零轴微弱抖动）
        const waveMax = Math.max(...barVals.slice(negStart, segEnd + 1).map(v => Math.abs(v)));
        if (waveMax >= minAbs && minIdx >= start) {
          const b = bars[minIdx - start];
          if (!b.signal) {
            b.signal = 'buy_pre';
          }
        }
        negStart = -1;
      }
    }
  }

  // 找正值波段缩量顶 → sell_pre（标在翻绿前一天，即缩量最小那根）
  let posStart = -1;
  for (let i = 0; i <= klines.length; i++) {
    const val = i < klines.length ? barVals[i] : null;
    if (val !== null && val > 0) {
      if (posStart < 0) posStart = i;
    } else {
      if (posStart >= 0) {
        const segEnd = i - 1;
        let minIdx = posStart;
        for (let j = posStart + 1; j <= segEnd; j++) {
          if (Math.abs(barVals[j]) < Math.abs(barVals[minIdx])) minIdx = j;
        }
        const waveMax = Math.max(...barVals.slice(posStart, segEnd + 1).map(v => Math.abs(v)));
        if (waveMax >= minAbs && minIdx >= start) {
          const b = bars[minIdx - start];
          if (!b.signal) b.signal = 'sell_pre';
        }
        posStart = -1;
      }
    }
  }

  return bars;
}

app.get('/api/index-macd', async (req, res) => {
  const trading = isAShareTradingTime();
  const afterHours = isAShareAfterHours();
  const ttl = trading ? INDEX_MACD_TTL_TRADING : INDEX_MACD_TTL_NORMAL;
  // 缓存有效性：TTL 未过期，且若当前是交易日则缓存数据必须包含今天的柱
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const cacheHasToday = () => {
    const shBars = INDEX_MACD_CACHE.data && INDEX_MACD_CACHE.data.sh && INDEX_MACD_CACHE.data.sh.bars;
    if (!shBars || !shBars.length) return false;
    return shBars[shBars.length - 1].date === todayStr;
  };
  const needRefresh = !INDEX_MACD_CACHE.data
    || Date.now() - INDEX_MACD_CACHE.ts >= ttl
    || ((trading || afterHours) && !cacheHasToday());
  if (!needRefresh) {
    return res.json({ success: true, ...INDEX_MACD_CACHE.data });
  }
  try {
    const klineLimit = 120; // 足够计算 EMA26 + DEA9（日K）
    const start = new Date();
    start.setFullYear(start.getFullYear() - 1);
    const startStr = start.toISOString().slice(0, 10).replace(/-/g, '');

    const [shKlines, cyKlines, ndxKlines, kospiKlines, goldKlines, kcKlines, ndxTechKlines, nkyKlines, ndxBioKlines, hkInnovKlines] = await Promise.all([
      fetchKline('sh000001', klineLimit),
      fetchKline('sz399006', klineLimit),
      fetchTencentDayKline('usQQQ.OQ', klineLimit),      // 纳斯达克100 QQQ
      fetchNaverIndexKline('KOSPI', startStr),
      fetchKline('sh518880', klineLimit),                  // 黄金ETF
      fetchKline('sh000688', klineLimit),                // 科创50
      fetchKline('sz159509', klineLimit),                // 纳指科技ETF
      fetchKline('sh513520', klineLimit),                // 日经ETF
      fetchKline('sh513290', klineLimit),                // 纳指生物科技ETF
      fetchKline('sh513120', klineLimit),                // 恒生创新药ETF
    ]);

    // 交易时间内或盘后：追加今日实时/收盘柱（上证、创业板、A股ETF）
    // 注：QQQ 为美股，A股交易时段美股休市，日K直接取腾讯最新收盘，无需补柱
    // 盘中标记 intraday，盘后不标（视为已收盘的当日K线）
    if (trading || afterHours) {
      try {
        const rt = await fetchSinaRealtimePrice(['sh000001', 'sz399006', 'sh000688', 'sh518880', 'sz159509', 'sh513520', 'sh513290', 'sh513120']);
        const pairs = [
          { klines: shKlines,   id: 'sh000001' },
          { klines: cyKlines,   id: 'sz399006' },
          { klines: kcKlines,   id: 'sh000688' },
          { klines: goldKlines, id: 'sh518880' },
          { klines: ndxTechKlines, id: 'sz159509' },
          { klines: nkyKlines,  id: 'sh513520' },
          { klines: ndxBioKlines,   id: 'sh513290' },
          { klines: hkInnovKlines, id: 'sh513120' },
        ];
        for (const { klines, id } of pairs) {
          const q = rt[id];
          if (!q) continue;
          const lastDate = klines.length ? klines[klines.length - 1].date : '';
          // 只有当历史K末尾不是今天才追加
          if (q.date === todayStr && lastDate !== todayStr) {
            const entry = { date: todayStr, close: q.price };
            if (trading) entry.intraday = true; // 盘中才标虚线样式
            klines.push(entry);
          }
        }
      } catch (e) {
        console.warn('[index-macd] realtime fetch failed:', e.message);
      }
    }

    // 每个指数只返回最近 21 根柱（足够显示趋势）
    const result = {
      sh:       { name: '上证',       bars: calcMACD(shKlines,       21) },
      cy:       { name: '创业板',     bars: calcMACD(cyKlines,       21) },
      ndx:      { name: '纳斯达克100 QQQ', bars: calcMACD(ndxKlines,      21) },
      kospi:    { name: 'KOSPI',     bars: calcMACD(kospiKlines,    21) },
      gold:     { name: '黄金ETF',    bars: calcMACD(goldKlines,     21) },
      kc:       { name: '科创50',     bars: calcMACD(kcKlines,       21) },
      ndxTech:  { name: '纳指科技',   bars: calcMACD(ndxTechKlines,  21) },
      nky:      { name: '日经',       bars: calcMACD(nkyKlines,      21) },
      ndxBio:   { name: '纳指生物',   bars: calcMACD(ndxBioKlines,   21) },
      hkInnov:  { name: '港股创新药', bars: calcMACD(hkInnovKlines,  21) },
    };

    INDEX_MACD_CACHE.data = result;
    INDEX_MACD_CACHE.ts = Date.now();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[index-macd]', err.message);
    if (INDEX_MACD_CACHE.data) return res.json({ success: true, ...INDEX_MACD_CACHE.data, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  /api/etf-track — 纳指科技ETF(sz159509) 专用跟踪视图
//   · 日K + MACD / 均线指标
//   · 买卖信号清单（复用 MACD 视图同一套算法，附「信号后表现」）
//   · 实时行情（含 IOPV / 溢价率）
//   · 溢价率历史（腾讯日K收盘 ÷ 天天基金单位净值，按日期对齐）
//   · 分时数据 + 盘中提示
//   · 每日操作建议（溢价率 × 技术面 × 持仓）
//  数据源：腾讯财经（日K/实时/分时）· 天天基金（净值历史）
//
//  为什么溢价率是关键：159509 是 QDII ETF，受外汇额度限制长期溢价。
//  实测 2026-09-30 场内 3.194 / IOPV 2.3720 = 溢价 34.65%（基金已发停牌风险提示公告）。
//  溢价是「场内价 − 净值」的差，随情绪扩张/收敛，与指数涨跌无关；
//  高溢价时买入 = 额外承担溢价回落的风险，因此本接口把溢价率作为一级决策变量。
//  策略档位（用户给定，按本 ETF 历史分布标定）：
//    ≤18% 买入 · <15% 多买 · ≥22% 只减不加 · ≥27% 减仓
//  档位会换算成基于 IOPV 的挂单价（加仓价/买入价/警戒价/减仓价）直接给出。
// ═══════════════════════════════════════════════════════
const ETF_CODE = 'sz159509';
const ETF_NAME = '纳指科技ETF';
const ETF_FUND_CODE = '159509';
const ETF_NAV_CACHE = { data: null, ts: 0 };
const ETF_MKT_CACHE = { data: null, ts: 0 };
let ETF_PREM_PREV = null;                   // 上一次请求的溢价率（用于盘中穿越买入线检测）
let ETF_KLINES = [];                        // 最近一次拉取的日K（供盘中柱估算）
const ETF_NAV_TTL = 6 * 3600_000;           // 净值历史：6 小时
const ETF_MKT_TTL_TRADING = 20_000;         // 盘中：20 秒
const ETF_MKT_TTL_IDLE = 180_000;           // 非盘中：3 分钟

// ── 溢价率档位（按本 ETF 自身历史分布标定，不是通用 ETF 标准）──
// 历史 299 个交易日（2025-07-10 ~ 2026-09-29）实测分布：
//   min 3.3% · p10 7.9% · p25 13.7% · 中位数 17.2% · p75 20.6% · max 32.3%
//   低于 18% 的交易日占 58.5%，低于 15% 占 31.8%；长期正溢价是 QDII 外汇额度受限所致。
// 策略阈值（用户给定）：溢价 ≤18% 可买入，<15% 可多买（加仓）。
//   据此把 18% / 15% 定为买入线 / 加仓线，22% / 27% 定为警戒线 / 减仓线。
// 历史上按「溢价 < 阈值」进场后持 20 个交易日的场内价平均收益（含溢价收敛贡献）：
//   <15% → +7.87%（胜率 83%）· <18% → +6.25%（76%）· <25% → +4.02%（64%）
//   即：进场溢价越低，后续收益与胜率越好，价差约 2~4 个百分点来自溢价回归本身。
const PREMIUM_ADD = 15;      // 加仓线（多买）
const PREMIUM_BUY = 18;      // 买入线
const PREMIUM_WATCH = 22;    // 警戒线（高溢价：仓位压到 3 成以内，只少买不追高）
const PREMIUM_DANGER = 27;   // 极高溢价线（仓位压到 2 成以内）
const PREMIUM_ZONES = [
  { key: 'add',   level: 'cheap',   label: '加仓区', lo: -Infinity,      hi: PREMIUM_ADD,    note: `溢价 <${PREMIUM_ADD}%，可多买` },
  { key: 'buy',   level: 'ok',      label: '买入区', lo: PREMIUM_ADD,    hi: PREMIUM_BUY,    note: `溢价 ${PREMIUM_ADD}~${PREMIUM_BUY}%，可买入` },
  { key: 'watch', level: 'warn',    label: '观望区', lo: PREMIUM_BUY,    hi: PREMIUM_WATCH,  note: `溢价 ${PREMIUM_BUY}~${PREMIUM_WATCH}%，略高于买入线，观望` },
  { key: 'avoid', level: 'high',    label: '高溢价', lo: PREMIUM_WATCH,  hi: PREMIUM_DANGER, note: `溢价 ${PREMIUM_WATCH}~${PREMIUM_DANGER}%，不买入，持有者减仓` },
  { key: 'exit',  level: 'extreme', label: '极高',   lo: PREMIUM_DANGER, hi: Infinity,       note: `溢价 >${PREMIUM_DANGER}%，减仓规避溢价回落` },
];
function premiumZone(pct) {
  if (pct == null || !isFinite(pct)) return { key: 'unknown', level: 'neutral', label: '—', note: '溢价数据缺失' };
  for (const z of PREMIUM_ZONES) if (pct < z.hi) return z;
  return PREMIUM_ZONES[PREMIUM_ZONES.length - 1];
}
// 把档位边界翻译成可直接挂单的价格（基于当前 IOPV）
function premiumPriceLadder(iopv) {
  if (!(iopv > 0)) return null;
  return {
    add:   { pct: PREMIUM_ADD,    price: +(iopv * (1 + PREMIUM_ADD / 100)).toFixed(3) },
    buy:   { pct: PREMIUM_BUY,    price: +(iopv * (1 + PREMIUM_BUY / 100)).toFixed(3) },
    watch: { pct: PREMIUM_WATCH,  price: +(iopv * (1 + PREMIUM_WATCH / 100)).toFixed(3) },
    cut:   { pct: PREMIUM_DANGER, price: +(iopv * (1 + PREMIUM_DANGER / 100)).toFixed(3) },
  };
}

// 北京时间日期串（服务端可能跑在 UTC，必须显式换算）
function bjDateStr(ts = Date.now()) {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}

// 腾讯日K（含开/收/高/低/量）——多域名轮询，全失败再退到新浪
async function fetchTencentEtfDayK(symbol, limit = 400) {
  const j = await fetchTencentIfzqJson(`/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`);
  const node = j && j.data && j.data[symbol];
  const rows = (node && (node.day || node.qfqday)) || [];
  const out = rows
    .map(r => ({ date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], volume: +r[5] }))
    .filter(r => r.date && isFinite(r.close));
  if (out.length) return out;
  const alt = await fetchSinaEtfDayK(symbol, Math.min(limit, 1023));
  if (alt.length) console.warn('[etf-kline] 腾讯日K不可用，已切换新浪日K（' + alt.length + ' 根）');
  return alt;
}

// 备用日K源：新浪（scale=240 即日线；volume 单位为股，换算成手以对齐腾讯口径）
// 注：新浪为不复权价，159509 无分红，与腾讯 qfq 一致
async function fetchSinaEtfDayK(symbol, limit = 1023) {
  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
    + `?symbol=${symbol}&scale=240&ma=no&datalen=${limit}`;
  try {
    const txt = await httpGet(url, { Referer: 'https://finance.sina.com.cn/' });
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(r => ({
        date: String(r.day || ''), open: +r.open, close: +r.close, high: +r.high, low: +r.low,
        volume: isFinite(+r.volume) ? Math.round(+r.volume / 100) : null,
      }))
      .filter(r => r.date && isFinite(r.close));
  } catch { return []; }
}

// ETF 汇总数据的磁盘兜底（腾讯限流 / Render 冷启动时仍能出页面）
const ETF_DISK_CACHE = path.join(__dirname, 'data', 'etf-mkt-cache.json');
function loadEtfDiskCache() {
  try {
    const j = JSON.parse(fs.readFileSync(ETF_DISK_CACHE, 'utf8'));
    if (j && j.data && Array.isArray(j.data.signals) && j.data.signals.length) {
      if (!ETF_KLINES.length && Array.isArray(j.klines)) ETF_KLINES = j.klines;   // 盘中柱估算也要能跑
      return { ...j.data, stale: true, diskSavedAt: j.savedAt || null };
    }
  } catch { /* 无缓存 */ }
  return null;
}
function saveEtfDiskCache(data, klines) {
  try {
    if (Date.now() - (saveEtfDiskCache.ts || 0) < 300_000) return;   // 最多 5 分钟写一次
    saveEtfDiskCache.ts = Date.now();
    fs.mkdirSync(path.dirname(ETF_DISK_CACHE), { recursive: true });
    fs.writeFileSync(ETF_DISK_CACHE, JSON.stringify({ savedAt: new Date().toISOString(), data, klines }));
  } catch { /* 忽略 */ }
}

// 腾讯实时行情（含 IOPV / 溢价率）
// 字段下标（实测 sz 前缀 A股/ETF 通道，共 88 段）：
//   [3]现价 [4]昨收 [5]今开 [6]成交量(手) [30]时间戳 [31]涨跌额 [32]涨跌幅%
//   [33]最高 [34]最低 [37]成交额(万元) [77]溢价率% [78]IOPV [81]单位净值 [82]币种
async function fetchTencentEtfQuote(symbol) {
  const txt = await httpGet(`https://qt.gtimg.cn/q=${symbol}`, { Referer: 'https://finance.qq.com/' });
  const m = txt.match(/="([^"]+)"/);
  if (!m) return null;
  const f = m[1].split('~');
  const price = parseFloat(f[3]);
  const prevClose = parseFloat(f[4]);
  if (!isFinite(price) || !isFinite(prevClose) || prevClose <= 0) return null;
  const ts = (f[30] || '').trim();
  return {
    symbol,
    price,
    prevClose,
    open: parseFloat(f[5]) || null,
    high: parseFloat(f[33]) || null,
    low: parseFloat(f[34]) || null,
    volume: parseFloat(f[6]) || null,          // 手
    amount: parseFloat(f[37]) || null,         // 万元
    changePct: (price - prevClose) / prevClose * 100,
    iopv: parseFloat(f[78]) || null,
    nav: parseFloat(f[81]) || null,
    premiumPct: parseFloat(f[77]),
    quoteTime: ts.length >= 14
      ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`
      : null,
    quoteDate: ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null,
  };
}

// 天天基金单位净值历史 → { 'YYYY-MM-DD': nav }
async function fetchEtfNavHistory(fundCode) {
  if (ETF_NAV_CACHE.data && Date.now() - ETF_NAV_CACHE.ts < ETF_NAV_TTL) return ETF_NAV_CACHE.data;
  const txt = await httpGet(`https://fund.eastmoney.com/pingzhongdata/${fundCode}.js`, {
    Referer: 'https://fund.eastmoney.com/',
  });
  const m = txt.match(/var Data_netWorthTrend = (\[[\s\S]*?\]);/);
  if (!m) return ETF_NAV_CACHE.data || {};
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return ETF_NAV_CACHE.data || {}; }
  const nav = {};
  for (const x of arr) {
    if (!x || !isFinite(x.x) || !isFinite(x.y)) continue;
    // 时间戳按北京时间取日期（服务端时区无关）
    nav[new Date(x.x + 8 * 3600_000).toISOString().slice(0, 10)] = x.y;
  }
  ETF_NAV_CACHE.data = nav;
  ETF_NAV_CACHE.ts = Date.now();
  return nav;
}

// 腾讯分时：返回 { date:'YYYY-MM-DD', points:[{t,price,avg}] }
// 走 fetchTencentIfzqJson 多域名轮询（web.ifzq 被 WAF 拦时分时同样会 501）
async function fetchTencentEtfMinute(symbol) {
  const j = await fetchTencentIfzqJson(`/appstock/app/minute/query?code=${symbol}`);
  const node = j && j.data && j.data[symbol];
  const raw = node && node.data && node.data.data;
  if (!raw || !raw.length) return null;
  const dra = String(node.data.date || '');   // YYYYMMDD
  const points = [];
  for (const line of raw) {
    const p = line.split(/\s+/);
    const t = p[0];
    const price = parseFloat(p[1]);
    if (!isFinite(price) || !t || t.length < 4) continue;
    const cumVol = parseFloat(p[2]) || 0;    // 累计成交量（手）
    const cumAmt = parseFloat(p[3]) || 0;    // 累计成交额（元）
    let avg = cumVol > 0 ? cumAmt / (cumVol * 100) : null;
    // 均价合理性护栏：偏离现价 ±20% 视为单位口径异常，丢弃
    if (avg != null && (!isFinite(avg) || avg < price * 0.8 || avg > price * 1.2)) avg = null;
    points.push({ t: `${t.slice(0, 2)}:${t.slice(2)}`, price, avg });
  }
  return {
    date: dra.length === 8 ? `${dra.slice(0, 4)}-${dra.slice(4, 6)}-${dra.slice(6, 8)}` : dra,
    points,
  };
}

// 简单均线（与 closes 等长，不足周期的为 null）
function movingAvgSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ── ETF 额外技术指标 ──
// 依据 scripts/etf-indicator-study.js 对 159509 的 764 日回测：
//   · 摆动指标（RSI / 威廉%R / KDJ / 布林）单独择时全部大幅跑输买入持有——
//     趋势标的上「超买继续涨、超卖继续跌」，按 RSI>70 卖出等于卖在主升浪起点。
//   · 因此这些指标在本项目里只用于「买点确认」（避免在冲高中买入），不用于卖出信号。
//   · 三者作为买点过滤器在回测中表现几乎一致（年化 56.7%~57.6%），此处一并给出、互为参照。

// 威廉%R：取值 -100~0，越接近 -100 表示收盘价越贴近区间低点
function williamsRSeries(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i + 1 - period; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    out[i] = hh === ll ? -50 : +(((hh - closes[i]) / (hh - ll)) * -100).toFixed(2);
  }
  return out;
}

// RSI（Wilder 平滑）
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= period) {
      g += up; l += dn;
      if (i === period) { g /= period; l /= period; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    } else {
      g = (g * (period - 1) + up) / period;
      l = (l * (period - 1) + dn) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

// 布林带（20, 2）
function bollingerSeries(closes, period = 20, mult = 2) {
  const mid = movingAvgSeries(closes, period);
  const up = new Array(closes.length).fill(null);
  const dn = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i + 1 - period; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    up[i] = mid[i] + mult * sd;
    dn[i] = mid[i] - mult * sd;
  }
  return { mid, up, dn };
}

// KDJ（9,3,3）：RSV → K/D 用 2/3 平滑，J = 3K − 2D；与 etf-indicator-study.js 口径一致
function kdjSeries(highs, lows, closes, period = 9) {
  const K = new Array(closes.length).fill(null);
  const D = new Array(closes.length).fill(null);
  const J = new Array(closes.length).fill(null);
  let k = 50, d = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i + 1 < period) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i + 1 - period; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K[i] = +k.toFixed(2); D[i] = +d.toFixed(2); J[i] = +(3 * k - 2 * d).toFixed(2);
  }
  return { K, D, J };
}

// ATR：真实波幅（TR）的 EMA 平滑，用于「波动率止损」
function atrSeries(highs, lows, closes, period = 14) {
  const tr = closes.map((c, i) => i === 0
    ? highs[0] - lows[0]
    : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  return calcEMA(tr, period);
}

const ETF_SIGNAL_META = {
  buy:       { label: '强买',   action: '买入',     side: 'buy'  },
  buy_weak:  { label: '弱买',   action: '小仓试仓', side: 'buy'  },
  buy_pre:   { label: '买预警', action: '准备买入', side: 'buy'  },
  sell:      { label: '强卖',   action: '减仓',     side: 'sell' },
  sell_ma:   { label: '破MA21', action: '减仓',     side: 'sell' },
  sell_weak: { label: '弱卖',   action: '观望',     side: 'sell' },
  sell_pre:  { label: '卖预警', action: '准备减仓', side: 'sell' },
};

// 信号清单：复用 MACD 视图同一套算法（calcMACD），保证两个 Tab 口径一致；
// 并补「信号后表现」——买入信号持有到下一个卖出信号的收益；卖出信号到下一个买入信号之间的涨跌。
function buildEtfSignals(klines) {
  const bars = calcMACD(klines, klines.length);
  if (!bars.length) return { signals: [], bars: [], stats: null };
  const lastIdx = klines.length - 1;
  const sigs = [];
  bars.forEach((b, i) => {
    if (!b.signal) return;
    const meta = ETF_SIGNAL_META[b.signal] || { label: b.signal, action: '观察', side: 'buy' };
    sigs.push({
      idx: i,
      date: b.date,
      close: isFinite(b.close) ? b.close : klines[i].close,
      code: b.signal,
      label: meta.label,
      action: meta.action,
      side: meta.side,
      intraday: !!b.intraday,
    });
  });
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    let nxt = null;
    for (let j = i + 1; j < sigs.length; j++) {
      if (sigs[j].side !== s.side) { nxt = sigs[j]; break; }
    }
    const endIdx = nxt ? nxt.idx : lastIdx;
    const endClose = nxt ? nxt.close : klines[lastIdx].close;
    s.holdDays = endIdx - s.idx;
    s.holdUntil = nxt ? nxt.date : `${klines[lastIdx].date}(至今)`;
    const seg = (endClose / s.close - 1) * 100;
    if (s.side === 'buy') s.holdRetPct = +seg.toFixed(2);        // 持有一段的结果
    else s.avoidPct = +seg.toFixed(2);                            // 卖出后若继续持有会有的结果（负=躲过下跌）
    s.sinceRetPct = +(((klines[lastIdx].close / s.close) - 1) * 100).toFixed(2);
  }
  const buys = sigs.filter(s => s.side === 'buy');
  const wins = buys.filter(s => (s.holdRetPct ?? 0) > 0).length;
  return {
    signals: sigs,
    bars,
    stats: {
      buyCount: buys.length,
      sellCount: sigs.length - buys.length,
      winRate: buys.length ? +(wins / buys.length * 100).toFixed(1) : null,
    },
  };
}

// ── 多指标组合信号（买卖信号清单 v4）──
//  不再以 MACD 为唯一标准。依据 764 日回测结论（scripts/etf-indicator-study.js）：
//  · 溢价率是一级变量——但只决定「仓位上限」与「能不能加仓」，不直接产生清仓：
//    <15 重仓区 / 15~18 买入区 / 18~22 观望区 / 22~27 高溢价（≤3 成）/ ≥27 极高（≤2 成）
//  · 「不追高」过滤器（威廉%R≤-60 / 收盘<MA21 / 收盘<布林中轨，任一命中）显著改善买点质量
//  · 高溢价区仍保留 MACD 级别的离散买卖点（v4 新增，避免整段被「持有不加仓」吞掉）：
//      死叉 → 减仓；死叉后首次跌破 MA21 → 确认减仓（一轮空头只确认一次）；
//      金叉 → 少量买入（溢价偏高，仓位不超过 3 成）
//  · 布林上轨/威廉超买（≥-10）作为高位过热信号，在「持有不加仓」段里提示别追高
//  输出按「连续同类型合并为段」，每段带证据列表与信号后 20 日涨跌
function buildEtfCompositeSignals(klines, navMap, panic, usIdx) {
  const n = klines.length;
  if (n < 40) return { signals: [], stats: null, backtest: null };
  const C = klines.map(k => k.close);
  const highs = klines.map(k => k.high ?? k.close);
  const lows = klines.map(k => k.low ?? k.close);

  const willR = williamsRSeries(highs, lows, C, 14);
  const boll = bollingerSeries(C, 20, 2);
  const ma21 = movingAvgSeries(C, 21);
  const ma60 = movingAvgSeries(C, 60);
  const bars = calcMACD(klines, klines.length);
  const goldenCross = i => i > 0 && bars[i - 1] && bars[i - 1].dif < bars[i - 1].dea && bars[i].dif >= bars[i].dea;
  const deathCross = i => i > 0 && bars[i - 1] && bars[i - 1].dif > bars[i - 1].dea && bars[i].dif <= bars[i].dea;
  const premAt = i => {
    const v = navMap[klines[i].date];
    return v > 0 ? C[i] / v * 100 - 100 : null;
  };
  // 趋势破坏：连续 3 日收在 MA21 缓冲带下方，或跌破 MA60（与「仓位建议」同一套判定）
  const trendBroken = new Array(n).fill(false);
  { let below = 0; for (let i = 0; i < n; i++) { if (ma21[i] == null) continue; if (C[i] < ma21[i] * (1 - POS_MA_BUF)) below++; else below = 0; trendBroken[i] = below >= POS_BELOW_N || (ma60[i] != null && C[i] < ma60[i]); } }
  // 段内建议仓位（复用仓位建议的逐日目标仓位；已含「美股趋势确认」门控）
  const posSeries = buildEtfPositionSeries(klines, navMap, null, panic && panic.active, usIdx) || [];
  const posAt = i => (posSeries[i] && posSeries[i].target != null) ? posSeries[i].target : null;
  // 美股趋势状态（逐日）：低溢价只在美股确认（usOk）时才够格叫「重仓买入」
  const usTrend = buildUsTrendState(klines, usIdx);
  const usAt = i => usTrend[i] || null;

  const META = {
    buy_strong: { label: '重仓买入', action: '分批重仓', side: 'buy' },
    buy:        { label: '买入',     action: '分批买入', side: 'buy' },
    buy_weak:   { label: '试仓',     action: '小仓试仓', side: 'buy' },
    buy_small:  { label: '少量买入', action: '小仓 ≤3成', side: 'buy' },
    sell_weak:  { label: '持有不加仓', action: '持仓不动', side: 'hold' },
    wait_us:    { label: '等美股确认', action: '暂缓加仓', side: 'hold' },
    panic_wait: { label: '抄底未确认', action: '撤回防守仓', side: 'hold' },
    sell:       { label: '减仓',     action: '减仓',     side: 'sell' },
    sell_clear: { label: '清仓/减半', action: '清仓或减半', side: 'sell' },
  };

  const sigs = [];
  let breakArmed = false;   // 死叉后是否还允许一次「跌破 MA21」确认减仓
  for (let i = 35; i < n; i++) {
    const p = premAt(i);
    if (p == null) continue;
    const fWill = willR[i] != null && willR[i] <= -60;
    const fMa = ma21[i] != null && C[i] < ma21[i];
    const fBoll = boll.mid[i] != null && C[i] < boll.mid[i];
    const fHit = fWill || fMa || fBoll;
    const bollUp = boll.mid[i] != null && boll.up[i] != null && C[i] > boll.up[i];
    const willHot = willR[i] != null && willR[i] >= -10;

    let code = null, ev = [], tag = null;
    // 美股趋势确认：溢价低只说明「有性价比」，美股趋势没好转就不构成抄底/重仓的理由
    //（2026-01~03 一路按「低溢价 → 重仓」加仓，跟着美股跌 3 个月）。
    const usRow = usAt(i);
    const usOk = !usRow || usRow.ok;
    const usHint = `美股（纳指 ${usRow ? usRow.close.toFixed(0) : '—'}）仍在 MA50 ${usRow && usRow.ma50 != null ? usRow.ma50.toFixed(0) : '—'} 下方且 MA50 下行`
      + `（自近 20 日低点 ${usRow && usRow.rebound != null ? (usRow.rebound >= 0 ? '+' : '') + usRow.rebound : '—'}%）`
      + ` —— 便宜 ≠ 该买，等纳指自 20 日低点反弹 ≥${US_TREND_REPAIR_PCT}% 确认止跌再抬仓`;
    // 恐慌抄底窗口：这是系统里最严格的底部条件（7 项共振），可比「溢价<15」更值得重仓。
    // 否则会出现「7/8 溢价 14.87% 给重仓、7/30 溢价 15.58% 只给买入」这种被 0.7pp 卡出来的倒挂。
    const isPanic = !!(panic && panic.active && panic.active.has(klines[i].date));
    // 恐慌下限已失效（触发后超过 PANIC_US_GRACE_DAYS 个交易日仍站不回 MA21）：
    // 说明是下跌中继而非恐慌底（2026-01-21、2025-03-04 两次各亏 6.1%/5.4%），
    // 清单不能再喊「分批重仓」，否则就是用户说的「一路加仓一路亏」。
    const panicLapsed = !!(posSeries[i] && posSeries[i].panicLapsed);
    if (isPanic && panicLapsed && p <= PREMIUM_WATCH) {
      code = 'panic_wait';
      ev = [`溢价 ${p.toFixed(1)}%（${premiumZone(p).label}）`,
        `恐慌抄底已触发超过 ${PANIC_US_GRACE_DAYS} 个交易日，价格始终站不回 MA21 ${ma21[i] != null ? ma21[i].toFixed(3) : ''}`,
        usHint,
        '判断被证伪：这是下跌中继而非恐慌底 → 撤回 65% 下限，按防守仓位执行'];
    } else if (isPanic && p <= PREMIUM_WATCH) {
      code = 'buy_strong';
      ev = [`溢价 ${p.toFixed(1)}%（${premiumZone(p).label}）`, '恐慌抄底信号触发：隔夜外盘重挫 + 极限超卖共振（利空集中兑现，非基本面转坏）'];
      if (fWill) ev.push(`威廉%R ${willR[i].toFixed(0)} 超卖（≤-60）`);
      if (fMa) ev.push('收盘 < MA21（回调中）');
      if (fBoll) ev.push('收盘 < 布林中轨');
      ev.push('分批重仓：触发日先建 65%，重新站上 MA21 补到 85%');
    } else if (p < 15 && fHit) {
      code = 'buy_strong';
      ev = [`溢价 ${p.toFixed(1)}%（<15 重仓区）`];
      if (fWill) ev.push(`威廉%R ${willR[i].toFixed(0)} 超卖（≤-60）`);
      if (fMa) ev.push('收盘 < MA21（回调中）');
      if (fBoll) ev.push('收盘 < 布林中轨');
    } else if (p >= 15 && p <= 18 && fHit) {
      code = 'buy';
      ev = [`溢价 ${p.toFixed(1)}%（15~18 买入区）`];
      if (fWill) ev.push(`威廉%R ${willR[i].toFixed(0)} 超卖（≤-60）`);
      if (fMa) ev.push('收盘 < MA21（回调中）');
      if (fBoll) ev.push('收盘 < 布林中轨');
    } else if (p <= 18 && goldenCross(i)) {
      code = 'buy_weak';
      ev = [`溢价 ${p.toFixed(1)}%（≤18）`, 'MACD 零轴下金叉（无回调确认，试仓）'];
    } else if (p >= PREMIUM_WATCH) {
      // 高溢价本身不是「清仓」理由，但它一定是「仓位上限」：统一压到 3 成以内
      // （≥27 压到 2 成）。高溢价区里仍然保留 MACD 级别的离散买卖点——
      //   死叉 → 减仓；死叉后的首次跌破 MA21 → 确认减仓（一次死叉只确认一次，
      //   避免同一轮空头里反复重复输出）；金叉 → 少量买入。
      const broke = trendBroken[i];
      const dead = deathCross(i);
      const brokeMa21 = ma21[i] != null && C[i] < ma21[i];
      if (goldenCross(i)) breakArmed = false;
      if (broke && p >= PREMIUM_DANGER) {
        code = 'sell_clear';
        ev = [`溢价 ${p.toFixed(1)}%（≥${PREMIUM_DANGER} 极高区）`, '趋势破坏（连续 3 日破 MA21 缓冲带或跌破 MA60）', '溢价回落 + 趋势转弱双杀，减半至 3 成以内'];
      } else if (broke) {
        code = 'sell';
        ev = [`溢价 ${p.toFixed(1)}%（高溢价区）`, '趋势破坏：连续 3 日收在 MA21 缓冲带下或跌破 MA60', '按仓位建议降到 30% 以内'];
      } else if (dead) {
        code = 'sell'; tag = 'dead';
        breakArmed = true;
        ev = [`溢价 ${p.toFixed(1)}%（≥${PREMIUM_WATCH} 高溢价区）`, 'MACD 死叉（DIF 下穿 DEA），动能转弱', '高溢价 + 动能转弱 → 减仓，仓位压到 3 成以内'];
      } else if (brokeMa21 && breakArmed) {
        code = 'sell'; tag = 'ma';
        breakArmed = false;
        ev = [`溢价 ${p.toFixed(1)}%（≥${PREMIUM_WATCH} 高溢价区）`, `收盘 ${C[i].toFixed(3)} 跌破 MA21 ${ma21[i].toFixed(3)}（死叉后首次破位确认）`, '高溢价 + 破位 → 减仓，仓位压到 3 成以内'];
      } else if (goldenCross(i)) {
        code = 'buy_small';
        ev = [`溢价 ${p.toFixed(1)}%（≥${PREMIUM_WATCH} 高溢价区）`, 'MACD 金叉（DIF 上穿 DEA），动能转强', `但溢价偏高，只可少量买入：仓位不超过 3 成，不追高`];
      } else {
        code = 'sell_weak';
        ev = [`溢价 ${p.toFixed(1)}%（≥${PREMIUM_WATCH} 高溢价区）`, '趋势仍在 MA21 上方，仅停止加仓'];
        if (willHot) ev.push(`威廉%R ${willR[i].toFixed(0)} 超买（≥-10），别追高`);
        if (bollUp) ev.push('触及布林上轨，别追高');
        const tp = posAt(i);
        if (tp != null) ev.push(`建议仓位上限 ${Math.round(tp * 100)}%（持有，不减仓）`);
      }
    }
    // 美股未确认止跌（!usOk）时，把所有「买入/加仓」降级为「等美股确认」——
    // 恐慌抄底属更严格的极端条件，不受此门限制（保持与仓位规则的豁免一致）。
    if (code && !usOk && !isPanic && (code === 'buy_strong' || code === 'buy' || code === 'buy_weak')) {
      ev.push(usHint);
      code = 'wait_us';
      tag = 'us';
    }
    if (code) sigs.push({ idx: i, date: klines[i].date, close: C[i], premium: +p.toFixed(2), code, tag: tag || code, ev });
  }

  // 连续同类型合并为段（隔一天以上视为新段；理由不同也拆开，如 8/21 死叉与 8/24 破位）
  const segs = [];
  for (const s of sigs) {
    const last = segs[segs.length - 1];
    if (last && last.code === s.code && last.tag === s.tag && s.idx - last.endIdx <= 1) {
      last.endIdx = s.idx; last.endDate = s.date; last.endClose = s.close;
    } else {
      segs.push({ ...s, endIdx: s.idx, endDate: s.date, endClose: s.close });
    }
  }

  // 段后表现：段首后 20 日收益（买点看涨、卖点看跌）
  const fwd20 = i => (i + 20 < n) ? +(((C[i + 20] / C[i]) - 1) * 100).toFixed(1) : null;
  for (const s of segs) {
    const m = META[s.code];
    s.label = m.label; s.action = m.action; s.side = m.side;
    s.dateLabel = s.endDate !== s.date ? `${s.date} ~ ${s.endDate}` : s.date;
    s.fwd20Pct = fwd20(s.idx);
    const tp = posAt(s.idx);
    s.posPct = tp == null ? null : Math.round(tp * 100);
    s.evidence = s.ev; delete s.ev;
  }

  // 分类型统计：买点看段首后 20 日为正的比例；卖点看为负的比例
  const typeStats = {};
  for (const s of segs) {
    (typeStats[s.code] = typeStats[s.code] || []).push(s.fwd20Pct);
  }
  const stats = Object.fromEntries(Object.entries(typeStats).map(([code, arr]) => {
    const ok = arr.filter(v => v != null);
    // 买入段与「持有不加仓 / 等美股确认 / 抄底未确认」段都以「后 20 日为正」为佳；真减仓/清仓段以「后 20 日为负」为佳
    const good = (code.startsWith('buy') || code === 'sell_weak' || code === 'wait_us' || code === 'panic_wait') ? ok.filter(v => v > 0) : ok.filter(v => v < 0);
    return [code, {
      count: arr.length,
      avgFwd20: ok.length ? +(ok.reduce((a, v) => a + v, 0) / ok.length).toFixed(1) : null,
      hitRate: ok.length ? +(good.length / ok.length * 100).toFixed(0) : null,
    }];
  }));

  // 按段操作回测：买入段建仓、卖出段清仓
  let equity = 1, inPos = false, entry = null;
  const trades = [];
  for (const s of segs) {
    if (s.side === 'buy' && !inPos) { inPos = true; entry = s.close; trades.push({ buyDate: s.date, buy: s.close }); }
    else if (s.side === 'sell' && inPos) {
      inPos = false;
      const r = s.endClose / entry - 1;
      equity *= (1 + r);
      Object.assign(trades[trades.length - 1], { sellDate: s.date, sell: s.endClose, retPct: +(r * 100).toFixed(1) });
    }
  }
  if (inPos && trades.length) {
    const r = C[n - 1] / entry - 1;
    equity *= (1 + r);
    Object.assign(trades[trades.length - 1], { sellDate: `${klines[n - 1].date}(至今)`, retPct: +(r * 100).toFixed(1) });
  }
  const wins = trades.filter(t => (t.retPct ?? 0) > 0).length;
  const backtest = trades.length ? {
    trades: trades.length,
    winRate: +(wins / trades.length * 100).toFixed(0),
    totalPct: +((equity - 1) * 100).toFixed(1),
    history: trades.slice(-8).reverse(),
  } : null;

  return { signals: segs, stats, backtest };
}

// ── 仓位建议：把「方向」与「估值」两个维度解耦 ──────────────────────────────
// 起因：溢价长期高于 22% 时，v2 清单整月只能输出「减仓/清仓」，与 MACD 9/18 的强买
// 互相打架；而 9 月场内价仍从 2.825 涨到 3.194（+13.1%）。根源是把溢价（估值/情绪
// 维度）当成了方向信号，且买点条件绑定「溢价≤18%」——一旦在高溢价区被震出就再也
// 无法入场（9 月全程空仓）。
// 修正后的架构：
//   · 方向由趋势决定：收盘在 MA21 上方维持持仓；连续 3 日跌破 MA21×0.98 或跌破
//     MA60 才判定趋势破坏（带缓冲与滞回，避免单日插针把仓位打飞）。
//   · 溢价只决定「仓位上限」与「能不能加仓」，不产生清仓指令。
//   · 低溢价「抄底仓」：趋势破坏时不再一律压到 3 成——溢价 <15% 给 85% 上限、
//     15~18% 给 65% 上限。本 ETF 溢价中位数仅 9.1%、<15% 占 69.8% 的交易日，
//     「便宜」本身就是最好的安全垫；7/8（溢价 14.9%）与 7/30（溢价 15.6%）这类
//     位置旧口径只给 24~30%，明显偏保守。
//   · **低溢价抄底仓必须叠加「美股趋势确认」**（2026-04 修正，v6）：2026-01~03 按
//     「低溢价 → 抄底仓 85%」一路加仓，结果是跟着美股一起跌了 3 个月——跟随者口径
//     （只加不减、现金起步）期间均仓 82%、亏损 -14.4%，用户体感就是「资金很快不够
//     用、一路加仓一路亏、非常难受」。复盘拆出两件事：
//       ① 1 月那波跌根本不是美股跌（纳指 1 月还在高位），而是 ETF 溢价从 23%
//          均值回归到 15%——属估值/情绪维度，所以 18~22% 档的仓位系数由 0.8 压到 0.5；
//       ② 2 月中 ~ 4 月上旬才是美股真跌（纳指 -12.7%）。此时「溢价低」只代表
//          「有性价比」，不构成抄底/重仓的理由——美股趋势没好转就不能一路加仓。
//     于是引入 usOk（见 buildUsTrendState）：纳指走坏且未止跌时，低溢价抄底仓不生效、
//     整体仓位封顶 POS_US_BAD_CAP(40%)，等纳指自近 20 日低点反弹 ≥3%（止跌确认）
//     再把仓位抬起来。实测正好命中「把抬仓集中在 3/30 ~ 4/3」的诉求：3 月全程封顶、
//     4/1 触发止跌确认 → 4/2~4/3 抬到 85%，而 7/30 的恐慌抄底不受影响。
// 回测（159509，764 个交易日，2023-08-08 ~ 2026-09-30，逐日按目标仓位再平衡）：
//   买入持有   累计 +224%   · 年化 47.1% · 最大回撤 -30.5%
//   旧口径     累计 +339%   · 年化 62.6% · 最大回撤 -23.1%（2026-01~03 跟随者 -14.4%、均仓 82%）
//   本方案     累计 +337%   · 年化 62.3% · 最大回撤 -15.2%（2026-01~03 跟随者 -12.8%、均仓 75%）
//   分年：2024 68% / 2025 64% / 2026 52%（买入持有 49% / 42% / 39%）。
// 即：收益基本持平（-2pp）、回撤显著收敛（-23.1% → -15.2%）、牛市里的仓位反而更高。
const POS_MA_BUF = 0.02;      // MA21 缓冲带：跌破 MA21×0.98 才计为「线下」
const POS_BELOW_N = 3;        // 连续 3 日线下才判定趋势破坏
// 低溢价「抄底仓」：趋势状态破位时，便宜本身就是最好的安全垫。
// 不再被趋势状态一刀切到 3 成——溢价 <15% 给 85% 上限，15~18% 给 65% 上限。
// **但必须叠加美股趋势确认（usOk）**：美股走坏且未止跌时这两个上限不生效（见 buildEtfPositionSeries）。
const POS_DIP_CAP_CHEAP = 0.85;   // 溢价 <15%（需 usOk）
const POS_DIP_CAP_BUY = 0.65;     // 溢价 15~18%（需 usOk）
// 溢价 → 仓位系数（趋势向上时仍保留仓位，不做清仓）
// 档位按本 ETF 自身历史校准：溢价中位数仅 9.1%（<15% 占 69.8% 的交易日），
// 所以 18~22% 已经是偏高位置（约 85 分位），不该再给 80% 仓位——2026-01 的下跌
// 就是「溢价从 23% 压缩到 15%」造成的，当时 80% 仓位明显过高。
function premiumPositionFactor(pct) {
  if (pct == null || !isFinite(pct)) return 0.3;   // 溢价未知时按「高溢价」防守处理
  if (pct < PREMIUM_ADD) return 1.0;      // <15%
  if (pct < PREMIUM_BUY) return 0.9;      // 15~18%
  if (pct < PREMIUM_WATCH) return 0.5;    // 18~22% 偏贵：半仓为限
  if (pct < PREMIUM_DANGER) return 0.25;  // 22~27% 高溢价：两成半为限
  return 0.15;                            // ≥27% 极高溢价：一成半为限
}
const POS_FACTOR_TABLE = [
  { pct: `<${PREMIUM_ADD}%`, factor: 1.0, note: '加仓区，可满仓' },
  { pct: `${PREMIUM_ADD}~${PREMIUM_BUY}%`, factor: 0.9, note: '买入区，接近满仓' },
  { pct: `${PREMIUM_BUY}~${PREMIUM_WATCH}%`, factor: 0.5, note: '偏贵区，半仓为限' },
  { pct: `${PREMIUM_WATCH}~${PREMIUM_DANGER}%`, factor: 0.25, note: '高溢价，两成半为限（只少买，不追高）' },
  { pct: `>${PREMIUM_DANGER}%`, factor: 0.15, note: '极高溢价，一成半为限（只减不加）' },
];

// ── 外围情绪源：纳指综合 / 费城半导体 日K（新浪美股）──
// 「恐慌抄底」信号的外盘输入。抓取失败时静默降级（信号自动退化为 6 项技术评分）。
const US_IDX_CACHE = { data: null, ts: 0 };
const US_IDX_TTL = 6 * 3600e3;
async function fetchUsIndexHistory() {
  if (US_IDX_CACHE.data && Date.now() - US_IDX_CACHE.ts < US_IDX_TTL) return US_IDX_CACHE.data;
  const out = {};
  await Promise.all([['ixic', '.IXIC'], ['sox', '.SOX']].map(async ([key, sym]) => {
    try {
      const txt = await httpGet(
        `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/x/US_MinKService.getDailyK?symbol=${encodeURIComponent(sym)}&___qn=3`,
        { Referer: 'https://finance.sina.com.cn/' }
      );
      const m = txt.match(/x\((\[[\s\S]*\])\)/);
      if (!m) return;
      const arr = JSON.parse(m[1]).map(r => ({ d: r.d, c: +r.c })).filter(r => r.d && isFinite(r.c));
      const dates = arr.map(r => r.d), closes = arr.map(r => r.c), ret = {}, ret5 = {};
      for (let i = 1; i < arr.length; i++) ret[dates[i]] = +((arr[i].c / arr[i - 1].c - 1) * 100).toFixed(2);
      for (let i = 5; i < arr.length; i++) ret5[dates[i]] = +((arr[i].c / arr[i - 5].c - 1) * 100).toFixed(2);
      // closes 供「美股趋势状态」使用（MA50 / 20 日低点）
      out[key] = { dates, closes, ret, ret5 };
    } catch (e) { console.error('[us-index]', key, e.message); }
  }));
  if (out.ixic) { US_IDX_CACHE.data = out; US_IDX_CACHE.ts = Date.now(); }
  return US_IDX_CACHE.data;
}

// ── 美股趋势状态：低溢价能不能加仓，最终要看美股有没有止跌 ──────────────────────
// 起因（2026-01 ~ 03）：ETF 溢价从 23% 一路压缩到 9.7%，同期纳指自 23850 跌到 20795
// （-12.7%）。旧规则「低溢价 → 抄底仓 85%」不看美股，在下跌段被反复触发：
// 跟随者口径（只加不减）期间均仓 82%、亏损 -14.4%，用户体感就是「一路加仓、一路亏、
// 资金很快不够用」。而 1 月的下跌其实不是美股跌（纳指 1 月还在高位），是溢价均值回归
// ——所以「溢价低」只能说明「有性价比」，不能单独作为抄底/重仓的理由。
// 两个判定（均以纳指 IXIC 为准；对齐到 A 股交易日，取「美股日期 < ETF 日期」的最后一根，
// 因为 A 股 d 日收盘时可见的最新美股收盘就是 ET d-1）：
//   · usDown   纳指 < MA50 且 MA50 较 5 个 ETF 交易日前下行  → 美股确认走坏（真下跌）
//   · usRepair 纳指距近 20 个美股交易日收盘低点 ≥ +3%        → 美股止跌确认（反弹）
//   · usOk     = !usDown || usRepair                          → 允许正常买入/加仓
// 规则：低溢价抄底仓（85%/65%）只在 usOk 时生效；美股走坏且未止跌时整体仓位封顶
// POS_US_BAD_CAP（只留底仓）。「恐慌抄底」是更严格的极端条件，不受此门限制。
// 实测：usDown 恰好覆盖 2 月中下旬 ~ 4 月上旬的下跌段（3 月 100%），并在 4/1 因纳指自
// 20 日低点反弹 3.8% 触发 usRepair 而解除——正好命中「3/30 ~ 4/3 抬仓」的需求；
// 2025 年的正常回调基本不触发（1 月/7 月/10 月均 0%），所以不会误伤牛市里的回调买点。
// 回测（764 日）：累计 +337%（旧 +339%）、年化 62.3%（62.6%），但最大回撤 -15.2%（旧 -23.1%）、
// 2026-01~03 跟随者亏损 -12.8%（旧 -14.4%）、期间均仓 75%（旧 82%），2025 年 64%（旧 55%）。
const US_TREND_MA50_WIN = 50;
const US_TREND_REPAIR_PCT = 3;
const POS_US_BAD_CAP = 0.4;      // 美股走坏且未止跌：整体仓位上限（只留底仓）
function buildUsTrendState(klines, usIdx) {
  const n = klines.length;
  const out = new Array(n).fill(null);
  const ix = usIdx && usIdx.ixic;
  if (!ix || !ix.dates || !ix.closes || ix.dates.length < US_TREND_MA50_WIN + 5) return out;
  const ma50 = movingAvgSeries(ix.closes, US_TREND_MA50_WIN);
  const idxAt = new Array(n).fill(-1);
  let p = -1;
  for (let i = 0; i < n; i++) {
    const d = klines[i].date;
    while (p + 1 < ix.dates.length && ix.dates[p + 1] < d) p++;
    idxAt[i] = p;
  }
  for (let i = 0; i < n; i++) {
    const ui = idxAt[i];
    if (ui < 20 || ma50[ui] == null) continue;
    const c = ix.closes[ui], m = ma50[ui];
    const pi = i >= 5 ? idxAt[i - 5] : -1;
    const pm = pi >= 0 ? ma50[pi] : null;
    const down = c < m && pm != null && m < pm;
    let lo = Infinity;
    for (let k = Math.max(0, ui - 19); k <= ui; k++) lo = Math.min(lo, ix.closes[k]);
    const rebound = lo > 0 ? (c / lo - 1) * 100 : 0;
    const repair = rebound >= US_TREND_REPAIR_PCT;
    out[i] = { close: +c.toFixed(2), ma50: +m.toFixed(2), down, repair, ok: !down || repair, rebound: +rebound.toFixed(2) };
  }
  return out;
}

// ── 「恐慌抄底」信号 ──
// 为什么不能只看技术超卖：764 日回测里，单纯用 %R/布林/RSI 超卖抄底会在趋势下跌中反复接飞刀
// （2025-01、2026-01 各一次，20 日后 -5% ~ -6%）。真正区分「恐慌底」与「半山腰」的是
// **外围情绪**：隔夜外盘重挫说明利空在集中兑现，而不是基本面在恶化。
// 2026-07-30 实测：隔夜纳指 -1.74% / 费半 -5.33% + %R -98 + 布林 2% + 溢价 15.6% → 触发，
// 4 个交易日 +8.8%（同期价格 +9.4%），而基准仓位只给 59%。
// 触发条件：7 项共振 ≥5 项。仓位分两段（「分批重仓」）：
//   · 触发日起 → 仓位下限 65%（POS_PANIC_CAP），不追高、不赌单日反转；
//   · 收盘重新站上 MA21（确认止跌）→ 下限补到 85%（POS_PANIC_CAP_ADD）。
// 为什么不一上来就给 85%：11 次历史触发 7 胜 4 负，且事前无法区分「恐慌底」与「半山腰」
// ——2025-01-13、2025-03-04、2026-01-21 三次是趋势下跌中继，20 日后 -5% ~ -6%。
// 回测对比（764 日）：触发即 85% → 累计 +285%；统一 65% → +310%；65% 站上 MA21 再补 85% → +313%。
// 「等价格确认再加」既满足了重仓诉求，又不为假底买单。
const POS_PANIC_CAP = 0.65;
const POS_PANIC_CAP_ADD = 0.85;
// 恐慌下限的「有效期」：美股仍在走坏且未止跌时，触发后这么多交易日仍未站上 MA21 就撤掉下限。
// 10 天的依据是两次扛满 30 天的失败案例（2026-01-21 -6.1%、2025-03-04 -5.4%）在第 10 天
// 前后就已显形，而所有成功案例（4/10/12 天退出）都在 10 天内完成确认，不受影响。
const PANIC_US_GRACE_DAYS = 10;
const PANIC_TRIGGER = 5;
const PANIC_HOLD_DAYS = 30;
const PANIC_TAKE_PROFIT = 0.12;
const PANIC_MA21_BAND = 1.02;
const PANIC_LEVELS = [
  { min: 6, label: '极度恐慌', note: '利空集中兑现，可分批重仓抄底' },
  { min: 5, label: '恐慌抄底窗口', note: '外盘重挫 + 极限超卖，分批建仓' },
  { min: 4, label: '接近抄底', note: '已具备多数条件，等外盘配合' },
  { min: 3, label: '偏超卖', note: '仅止跌特征，暂不加仓' },
  { min: 0, label: '正常', note: '无恐慌特征' },
];

function buildEtfPanicSignal(klines, navMap, usIdx) {
  const n = klines.length;
  if (n < 40) return null;
  const C = klines.map(k => k.close);
  const H = klines.map(k => (isFinite(k.high) ? k.high : k.close));
  const L = klines.map(k => (isFinite(k.low) ? k.low : k.close));
  const ma21 = movingAvgSeries(C, 21);
  const R = rsiSeries(C, 14);
  const W = williamsRSeries(H, L, C, 14);
  const B = bollingerSeries(C, 20, 2);
  const navKeys = Object.keys(navMap || {}).sort();
  let kp = 0;
  const prem = [];
  for (let i = 0; i < n; i++) {
    while (kp + 1 < navKeys.length && navKeys[kp + 1] <= klines[i].date) kp++;
    const v = navKeys.length && navKeys[kp] <= klines[i].date ? navMap[navKeys[kp]] : null;
    prem.push(v > 0 ? C[i] / v * 100 - 100 : null);
  }
  // 隔夜外盘：美股日期 < ETF 交易日 的最后一根（北京时间当日凌晨收盘）
  const ovAt = d => {
    if (!usIdx || !usIdx.ixic) return null;
    const ds = usIdx.ixic.dates;
    let lo = 0, hi = ds.length - 1, r = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ds[mid] < d) { r = mid; lo = mid + 1; } else hi = mid - 1; }
    if (r < 0) return null;
    const dd = ds[r];
    return { date: dd, ixic: usIdx.ixic.ret[dd] ?? null, ixic5: usIdx.ixic.ret5[dd] ?? null, sox: usIdx.sox ? (usIdx.sox.ret[dd] ?? null) : null };
  };
  const rows = [];
  for (let i = 21; i < n; i++) {
    const hits = []; let s = 0;
    const bp = B.up[i] != null ? (C[i] - B.dn[i]) / (B.up[i] - B.dn[i]) : null;
    if (W[i] != null && W[i] <= -95) { s++; hits.push({ key: '威廉%R', value: W[i].toFixed(0), why: '≤ -95 极限超卖' }); }
    if (bp != null && bp <= 0.10) { s++; hits.push({ key: '布林位置', value: (bp * 100).toFixed(0) + '%', why: '贴近下轨' }); }
    if (R[i] != null && R[i] <= 40) { s++; hits.push({ key: 'RSI14', value: R[i].toFixed(0), why: '≤ 40 弱势区' }); }
    if (prem[i] != null && prem[i] <= PREMIUM_BUY) { s++; hits.push({ key: '溢价', value: prem[i].toFixed(1) + '%', why: '≤ 18% 便宜区' }); }
    const r5 = i >= 5 ? (C[i] / C[i - 5] - 1) * 100 : null;
    if (r5 != null && r5 <= -4) { s++; hits.push({ key: '5日跌幅', value: r5.toFixed(1) + '%', why: '≤ -4% 急跌' }); }
    const hi20 = Math.max(...C.slice(Math.max(0, i - 19), i + 1));
    const dd20 = (C[i] / hi20 - 1) * 100;
    if (dd20 <= -6) { s++; hits.push({ key: '距20日高', value: dd20.toFixed(1) + '%', why: '≤ -6% 回撤' }); }
    const ov = ovAt(klines[i].date);
    if (ov) {
      if ((ov.ixic != null && ov.ixic <= -1.5) || (ov.sox != null && ov.sox <= -3)) {
        s++;
        hits.push({ key: '隔夜外围', value: `纳指 ${ov.ixic == null ? '—' : ov.ixic.toFixed(2) + '%'} · 费半 ${ov.sox == null ? '—' : ov.sox.toFixed(2) + '%'}`, why: `外盘重挫（美股 ${ov.date}）` });
      } else if (ov.ixic5 != null && ov.ixic5 <= -5) {
        s++;
        hits.push({ key: '纳指5日', value: ov.ixic5.toFixed(1) + '%', why: '≤ -5% 外盘连跌' });
      }
    }
    const lv = PANIC_LEVELS.find(x => s >= x.min);
    rows.push({
      date: klines[i].date, close: +C[i].toFixed(3), premium: prem[i] == null ? null : +prem[i].toFixed(2),
      score: s, hits, level: lv.label, levelNote: lv.note, overnight: ov,
      ma21: ma21[i] == null ? null : +ma21[i].toFixed(3),
    });
  }
  // 触发 → 维持 → 退出
  const active = new Set(); const events = [];
  let on = false, cost = 0, cnt = 0, cur = null;
  for (const r of rows) {
    if (!on && r.score >= PANIC_TRIGGER) { on = true; cost = r.close; cnt = 0; cur = { date: r.date, score: r.score, px: r.close, hits: r.hits, level: r.level }; }
    if (on) {
      cnt++; active.add(r.date);
      const exit = (r.ma21 != null && r.close > r.ma21 * PANIC_MA21_BAND) || cnt >= PANIC_HOLD_DAYS || (cost > 0 && r.close / cost - 1 >= PANIC_TAKE_PROFIT);
      if (exit) { on = false; Object.assign(cur, { exitDate: r.date, exitPx: r.close, days: cnt, ret: +((r.close / cost - 1) * 100).toFixed(1) }); events.push(cur); cur = null; }
    }
  }
  if (on && cur) { const lr = rows[rows.length - 1]; Object.assign(cur, { open: true, days: cnt, ret: +((lr.close / cost - 1) * 100).toFixed(1) }); events.push(cur); }
  const closed = events.filter(e => !e.open);
  const wins = closed.filter(e => e.ret > 0).length;
  const last = rows[rows.length - 1];
  const recent = events.slice(-8).reverse();
  return {
    active, events, recent, current: last,
    levels: PANIC_LEVELS,
    config: { trigger: PANIC_TRIGGER, cap: POS_PANIC_CAP, capAdd: POS_PANIC_CAP_ADD, holdDays: PANIC_HOLD_DAYS, takeProfit: PANIC_TAKE_PROFIT },
    stats: {
      total: closed.length, wins,
      winRate: closed.length ? Math.round(wins / closed.length * 100) : null,
      avgRet: closed.length ? +(closed.reduce((a, e) => a + e.ret, 0) / closed.length).toFixed(1) : null,
      bestRet: closed.length ? Math.max(...closed.map(e => e.ret)) : null,
      worstRet: closed.length ? Math.min(...closed.map(e => e.ret)) : null,
    },
    isActive: active.has(last.date),
    hasOvernightData: !!(usIdx && usIdx.ixic),
  };
}

// 生成逐日趋势状态（带滞回）与目标仓位；endIdx 为可选的实时覆盖点
function buildEtfPositionSeries(klines, navMap, live, panicActive, usIdx) {
  const rows = klines.map(k => ({ date: k.date, close: k.close }));
  if (live && live.price > 0) {
    const last = rows[rows.length - 1];
    if (!last || last.date !== live.date) rows.push({ date: live.date || 'now', close: live.price, intraday: true });
    else last.close = live.price;
  }
  const n = rows.length;
  if (n < 70) return null;
  const C = rows.map(r => r.close);
  const ma21 = movingAvgSeries(C, 21);
  const ma60 = movingAvgSeries(C, 60);
  const bars = calcMACD(rows.map(r => ({ date: r.date, close: r.close })), n);
  const navKeys = Object.keys(navMap || {}).sort();
  let kp = 0;
  const fn = [];
  for (let i = 0; i < n; i++) {
    while (kp + 1 < navKeys.length && navKeys[kp + 1] <= rows[i].date) kp++;
    const v = navKeys.length && navKeys[kp] <= rows[i].date ? navMap[navKeys[kp]] : null;
    fn.push(v > 0 ? C[i] / v * 100 - 100 : null);
  }
  const out = [];
  // 美股趋势状态：逐日对齐（rows 含盘中实时那一行；按「美股日期 < 交易日」取最新一根收盘）
  const usTrend = buildUsTrendState(rows, usIdx);
  let below = 0, state = 'UP', bull = false;
  let panicOn = false, panicAdded = false, panicStartIdx = -1;
  for (let i = 0; i < n; i++) {
    if (ma21[i] == null) { out.push(null); continue; }
    if (C[i] < ma21[i] * (1 - POS_MA_BUF)) below++; else below = 0;
    if (state === 'UP' && below >= POS_BELOW_N) state = 'DOWN';
    else if (state === 'DOWN' && C[i] > ma21[i] * (1 + POS_MA_BUF)) { state = 'UP'; below = 0; }
    const bar = bars[i] || {};
    bull = bar.dif != null && bar.dea != null && bar.dif > bar.dea;
    const brokeMa60 = ma60[i] != null && C[i] < ma60[i];
    const p = live && i === n - 1 && live.premiumPct != null ? live.premiumPct : fn[i];
    const usRow = usTrend[i];
    // 无外盘数据时静默降级为旧口径（usOk=true），保证「抓取失败」不等于「不让买」
    const usOk = !usRow || usRow.ok;
    let cap = state === 'UP' ? (brokeMa60 ? 0.6 : 1.0) : 0.3;
    // 抄底仓：溢价便宜只说明「有性价比」，能不能抬仓最终要看美股趋势。美股确认走坏
    // 且未止跌（!usOk）时不给低溢价抄底仓，并把整体仓位封顶 POS_US_BAD_CAP——
    // 这就是 2026-01~03「一路加仓一路亏」的修正点。
    if (p != null && usOk) {
      if (p < PREMIUM_ADD) cap = Math.max(cap, POS_DIP_CAP_CHEAP);
      else if (p < PREMIUM_BUY) cap = Math.max(cap, POS_DIP_CAP_BUY);
    }
    if (!usOk) cap = Math.min(cap, POS_US_BAD_CAP);
    // 零轴下死叉：趋势转弱再压一档
    if (state === 'UP' && i > 0 && bars[i - 1] && bars[i - 1].dif >= bars[i - 1].dea && bar.dif != null && bar.dif <= bar.dea && bar.dif < 0) cap *= 0.7;
    const pf = premiumPositionFactor(p);
    let target = Math.max(0, Math.min(1, cap * pf));
    // 恐慌抄底：隔夜外盘重挫 + 极限超卖共振时，仓位下限抬到 65%（不再被溢价系数打折）；
    // 收盘重新站上 MA21 后再补到 85%——「分批重仓」，不为假底一次性买单。
    const panic = !!(panicActive && panicActive.has(rows[i].date));
    if (panic) { if (!panicOn) { panicOn = true; panicAdded = false; panicStartIdx = i; } }
    else { panicOn = false; panicStartIdx = -1; }
    if (panicOn && !panicAdded && C[i] > ma21[i]) panicAdded = true;
    // 恐慌下限的「有效期」：11 次历史触发里，站上 MA21 快的（4 天、10 天、12 天）都是好底
    // （+8.8% / +6.2% / +8.4%），而 2026-01-21、2025-03-04 两次扛满 30 天都站不回 MA21，
    // 各亏 6.1% / 5.4%——那是下跌中继，不是恐慌底。所以：美股仍在走坏且未止跌（!usOk）时，
    // 触发后超过 PANIC_US_GRACE_DAYS 个交易日仍未站上 MA21，就撤掉 65% 下限、回到防守仓位。
    // 注意不能反过来「美股走坏就不让恐慌抄底」——实测 usOk=false 的 6 次反而更准
    // （平均 +2.7%、胜率 67%，2026-07-30 的最佳案例正是此状态），门控的是「扛多久」。
    const panicLapsed = panicOn && !panicAdded && !usOk && panicStartIdx >= 0 && (i - panicStartIdx) >= PANIC_US_GRACE_DAYS;
    // 恐慌下限只在高溢价（≥22%）以内生效——溢价极高时仍让「高溢价压仓」规则优先，避免自相矛盾
    if (panicOn && !panicLapsed && (p == null || p <= PREMIUM_WATCH)) target = Math.max(target, panicAdded ? POS_PANIC_CAP_ADD : POS_PANIC_CAP);
    out.push({
      date: rows[i].date, close: +C[i].toFixed(3), premium: p == null ? null : +p.toFixed(2),
      state, bull, ma21: ma21[i] == null ? null : +ma21[i].toFixed(3), ma60: ma60[i] == null ? null : +ma60[i].toFixed(3),
      cap: +cap.toFixed(2), factor: pf, target: +target.toFixed(2), belowDays: below, intraday: !!rows[i].intraday,
      panic, panicAdded: panicOn && panicAdded, panicLapsed,
      // 美股趋势（同日的确认状态）：供前端仓位卡与「买卖信号清单」说明为何不加仓
      usOk, usDown: usRow ? usRow.down : null, usRepair: usRow ? usRow.repair : null,
      usClose: usRow ? usRow.close : null, usMa50: usRow ? usRow.ma50 : null, usRebound: usRow ? usRow.rebound : null,
    });
  }
  return out;
}

function buildEtfPositionPlan(klines, navMap, live, panic, usIdx) {
  const series = buildEtfPositionSeries(klines, navMap, live, panic && panic.active, usIdx);
  if (!series) return null;
  const last = series[series.length - 1];
  if (!last) return null;
  const up = last.state === 'UP';
  const p = last.premium;
  const posPct = Math.round(last.target * 100);
  const zone = premiumZone(p);
  const iopv = live && live.iopv > 0 ? live.iopv : null;

  // 美股趋势确认：低溢价能不能抬仓的前提（见 buildUsTrendState）
  const usOk = last.usOk !== false;
  const usPct = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
  const usInfo = {
    ok: usOk,
    down: !!last.usDown,
    repair: !!last.usRepair,
    close: last.usClose != null ? last.usClose : null,
    ma50: last.usMa50 != null ? last.usMa50 : null,
    rebound: last.usRebound != null ? last.usRebound : null,
    repairPct: US_TREND_REPAIR_PCT,
    badCap: POS_US_BAD_CAP,
    label: usOk ? (last.usDown ? '美股走坏后已止跌确认' : '美股趋势正常') : '美股走坏且未止跌',
    note: usOk
      ? (last.usDown
        ? `纳指自近 20 日低点已反弹 ${usPct(last.usRebound)}（≥${US_TREND_REPAIR_PCT}%），止跌确认 → 低溢价抄底仓恢复生效`
        : '纳指在 MA50 上方或 MA50 未下行，趋势健康 → 低溢价抄底仓正常生效')
      : `纳指 ${last.usClose != null ? last.usClose.toFixed(0) : '—'} 收在 MA50 ${last.usMa50 != null ? last.usMa50.toFixed(0) : '—'} 下方且 MA50 下行（自近 20 日低点 ${usPct(last.usRebound)}）→ 低溢价抄底仓不生效，整体仓位封顶 ${Math.round(POS_US_BAD_CAP * 100)}%`,
  };

  // 动作措辞：趋势破坏 → 真的减；否则即使溢价极高也只是「持有不加仓」
  let action, tone, headline;
  const prev = series[series.length - 2];
  const changed = prev && Math.abs(last.target - prev.target) >= 0.049;
  if (last.panic && last.panicLapsed) {
    // 触发后超过 PANIC_US_GRACE_DAYS 个交易日仍站不回 MA21 → 这是下跌中继，不是恐慌底
    action = `抄底未确认 · 撤回 ${posPct}%`;
    tone = 'warn';
    headline = `恐慌抄底信号已触发超过 ${PANIC_US_GRACE_DAYS} 个交易日，但价格始终站不回 MA21（约 ${last.ma21 != null ? last.ma21.toFixed(3) : 'MA21'}）——`
      + `「利空集中兑现」的判断被证伪，这更像下跌中继（历史上 2026-01-21、2025-03-04 两次各亏 6.1% / 5.4%）。`
      + `撤回 ${Math.round(POS_PANIC_CAP * 100)}% 的仓位下限，按 ${posPct}% 的防守仓位执行${usInfo.ok ? '' : '（美股仍未止跌，整体封顶 ' + Math.round(POS_US_BAD_CAP * 100) + '%）'}；`
      + `等重新站上 MA21 或美股止跌确认再补回。`;
  } else if (last.panic) {
    const panicFloorPct = Math.round((last.panicAdded ? POS_PANIC_CAP_ADD : POS_PANIC_CAP) * 100);
    const lv = panic && panic.current && panic.current.level && panic.current.level !== '正常' ? `（${panic.current.level}）` : '';
    const ma21Txt = last.ma21 != null ? last.ma21.toFixed(3) : 'MA21';
    action = last.panicAdded ? `分批重仓 · ${posPct}%` : `恐慌抄底 · 先建 ${posPct}%`;
    tone = 'buy';
    const addPct = Math.round(POS_PANIC_CAP_ADD * 100);
    const tailTxt = posPct >= addPct ? `已到 ${addPct}% 上限，不再追加。` : `等重新站上 MA21（约 ${ma21Txt}）确认止跌，再补到 ${addPct}%。`;
    headline = last.panicAdded
      ? `恐慌抄底信号已获价格确认（重新站上 MA21 ${ma21Txt}）——按「分批重仓」把仓位补到 ${posPct}%。`
      : `触发「恐慌抄底」信号${lv}：隔夜外盘重挫 + 极限超卖共振，属利空集中兑现、而非基本面转坏。`
        + (posPct > panicFloorPct
          ? `叠加${last.usRepair ? '美股止跌确认与' : ''}溢价${zone.label}，仓位可直接给到 ${posPct}%（高于 ${panicFloorPct}% 的恐慌下限）；${tailTxt}`
          : `先建 ${posPct}% 打底，${tailTxt}`);
    // 美股仍在下跌通道时，把「有效期」讲清楚——这正是 2026-01~03 一路扛仓的教训
    if (!last.panicAdded && !usInfo.ok) {
      headline += ` 注意：美股仍在下跌通道，若 ${PANIC_US_GRACE_DAYS} 个交易日内仍站不回 MA21，就撤回 ${Math.round(POS_PANIC_CAP * 100)}% 下限、按防守仓位执行（2026-01-21 触发的那次就是这样，最终扛满 30 天亏 6.1%）。`;
    }
  } else if (!usOk) {
    // 2026-01~03 的教训：只盯「溢价低」会一路加仓、跟不上美股的跌。
    action = `等美股确认 · 仓位压到 ${posPct}%`; tone = 'warn';
    headline = `A股这边${up ? '趋势尚可' : '趋势已破坏'}，但美股还没好转：${usInfo.note}。`
      + `溢价${p == null ? '偏低' : ` ${p.toFixed(1)}%（${zone.label}）`}只说明「有性价比」，`;
    headline += `不能作为抄底/重仓的理由——先按 ${posPct}% 持有，等纳指自近 20 日低点反弹 ≥${US_TREND_REPAIR_PCT}% 或收复 MA50，再把仓位抬回 ${Math.round(POS_DIP_CAP_BUY * 100)}~${Math.round(POS_DIP_CAP_CHEAP * 100)}%。`;
  } else if (!up) {
    const cheapDip = p != null && p < PREMIUM_BUY;
    action = cheapDip && posPct >= 50 ? `留 ${posPct}% 抄底仓` : `减仓至 ${posPct}%`;
    tone = cheapDip && posPct >= 50 ? 'buy' : 'danger';
    headline = `趋势已破坏（连续 ${last.belowDays} 日收在 MA21 缓冲带下方${last.ma60 != null && last.close < last.ma60 ? '，且跌破 MA60' : ''}）`
      + (cheapDip
        ? `，但溢价只有 ${p.toFixed(1)}%（${zone.label}）——便宜本身就是安全垫，可以留 ${posPct}% 抄底仓，等重新站回 MA21 上方再补。`
        : `，先把仓位降到 ${posPct}% 以内，等重新站回 MA21 上方再考虑加回。`);
  } else if (changed && last.target > prev.target) {
    action = `加仓至 ${posPct}%`; tone = 'buy';
    headline = `趋势向上 + 溢价落到 ${zone.label}，仓位上限放开到 ${posPct}%，可分批补到该仓位。`;
  } else if (changed && last.target < prev.target) {
    action = `减仓至 ${posPct}%`; tone = 'warn';
    headline = `溢价升到 ${zone.label}，仓位上限下调到 ${posPct}%；趋势未破坏，减的是仓位不是清仓。`;
  } else if (posPct >= 95) {
    action = '维持满仓'; tone = 'hold';
    headline = `趋势向上、溢价 ${zone.label}，维持满仓；跌破 MA21 缓冲带连续 3 日再减。`;
  } else {
    action = `持有 ${posPct}%`; tone = 'hold';
    headline = `趋势向上但溢价 ${zone.label}（${p == null ? '—' : p.toFixed(1) + '%'}），仓位上限 ${posPct}%：持有不加仓，跌只加不追涨。`;
  }

  // 空仓者入场节奏：目标仓位 ≠ 一次性满上。高溢价区买入的 20 日期望为负
  //（本 ETF 高溢价段后 20 日平均 -3.8%），所以高溢价时只「分批建仓 + 等回调」。
  let entryNote;
  if (p != null && p >= PREMIUM_DANGER) {
    entryNote = `若当前空仓：溢价 ${p.toFixed(1)}% 属历史极高区，不建议一次性买入。以「每次 1 成、逢回调加一次」分批建立，等溢价回落到 ${PREMIUM_WATCH}% 以下（约 ${iopv ? (iopv * (1 + PREMIUM_WATCH / 100)).toFixed(3) + ' 元' : '按 IOPV 折算'}）或价格回踩 MA21，再把仓位补到 ${posPct}%。`;
  } else if (p != null && p >= PREMIUM_WATCH) {
    entryNote = `若当前空仓：溢价 ${p.toFixed(1)}% 偏高，可按 ${posPct}% 上限分 2~3 批建仓，别一次打满；溢价回落到 ${PREMIUM_WATCH}% 以下再加。`;
  } else {
    entryNote = `若当前空仓：溢价 ${zone.label}，可直接按 ${posPct}% 上限建仓。`;
  }

  // 触发价位
  const triggers = [];
  if (last.ma21 != null) {
    triggers.push({
      label: `减仓线 · 连续 ${POS_BELOW_N} 日收在 MA21 缓冲带下`,
      price: +(last.ma21 * (1 - POS_MA_BUF)).toFixed(3),
      note: `MA21 ${last.ma21.toFixed(3)} × ${(1 - POS_MA_BUF).toFixed(2)}；触发即按当时仓位上限执行（溢价 <18% 且美股确认止跌时上限 65~85%，否则 30%）`,
      tone: 'sell',
    });
    triggers.push({ label: 'MA21（多空分界）', price: last.ma21, note: '站回上方则恢复向上状态', tone: 'ref' });
  }
  if (last.ma60 != null) triggers.push({ label: 'MA60（趋势生命线）', price: last.ma60, note: '跌破则趋势上限降到 60%（再乘溢价系数）', tone: 'warn' });
  if (iopv) {
    triggers.push({
      label: `加仓价 · 溢价 ${PREMIUM_ADD}%`,
      price: +(iopv * (1 + PREMIUM_ADD / 100)).toFixed(3),
      note: usOk ? '低于此价可加满（已含美股趋势确认）' : `低于此价也先别满仓：美股未止跌，整体封顶 ${Math.round(POS_US_BAD_CAP * 100)}%`,
      tone: usOk ? 'buy' : 'warn',
    });
    triggers.push({
      label: `买入价 · 溢价 ${PREMIUM_BUY}%`,
      price: +(iopv * (1 + PREMIUM_BUY / 100)).toFixed(3),
      note: usOk ? '低于此价可加到九成（已含美股趋势确认）' : '美股未止跌 → 加到 4 成为限，等止跌确认再补',
      tone: usOk ? 'buy' : 'warn',
    });
  }
  // 美股趋势线：低溢价能不能抬仓，最终看这里
  if (usInfo.close != null && usInfo.ma50 != null) {
    triggers.push({
      label: '纳斯达克（美股风向 · 非本 ETF 价位）',
      price: usInfo.close,
      note: usOk
        ? `MA50 ${usInfo.ma50.toFixed(0)}；趋势健康/已止跌 → 低溢价抄底仓生效（自近 20 日低点 ${usPct(usInfo.rebound)}）`
        : `MA50 ${usInfo.ma50.toFixed(0)}；收在下方且 MA50 下行 → 抄底仓不生效，整体封顶 ${Math.round(POS_US_BAD_CAP * 100)}%，需自近 20 日低点反弹 ≥${US_TREND_REPAIR_PCT}%（现 ${usPct(usInfo.rebound)}）`,
      tone: usOk ? 'ref' : 'warn',
    });
  }
  if (last.close && last.ma21) {
    triggers.push({ label: '现价', price: last.close, note: `${last.intraday ? '盘中' : last.date}`, tone: 'ref' });
  }

  // 「如果只按仓位执行」的回测：全区间与最近 250 日
  let eq = 1, pk = 1, mdd = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (!a || !b) continue;
    eq *= (1 + a.target * (b.close / a.close - 1));
    if (eq > pk) pk = eq; mdd = Math.min(mdd, eq / pk - 1);
  }
  const first = series.find(x => x) || last;
  const years = (series.length - 21) / 244;
  const backtest = {
    totalPct: +((eq - 1) * 100).toFixed(1),
    annualPct: years > 0.5 ? +(((eq) ** (1 / years) - 1) * 100).toFixed(1) : null,
    maxDrawdownPct: +(mdd * 100).toFixed(1),
    from: first.date,
  };

  // 趋势上限的构成说明（含低溢价抄底仓的抬高；抄底仓必须叠加美股趋势确认）
  const baseCap = last.cap;
  const trendCap = up ? (last.ma60 != null && last.close < last.ma60 ? 0.6 : 1.0) : 0.3;
  const dipLiftBase = p != null && p < PREMIUM_ADD ? POS_DIP_CAP_CHEAP : (p != null && p < PREMIUM_BUY ? POS_DIP_CAP_BUY : null);
  const dipLift = usOk ? dipLiftBase : null;   // 美股走坏且未止跌 → 抄底仓不生效
  const capNote = last.panic
    ? (last.panicLapsed
        ? `恐慌抄底已触发超过 ${PANIC_US_GRACE_DAYS} 个交易日但仍站不回 MA21 → 撤回 ${Math.round(POS_PANIC_CAP * 100)}% 下限，按 ${posPct}% 的防守仓位执行`
        : last.panicAdded
          ? `恐慌抄底信号已确认（重新站上 MA21）→ 仓位下限从 ${Math.round(POS_PANIC_CAP * 100)}% 补到 ${Math.round(POS_PANIC_CAP_ADD * 100)}%`
          : `触发恐慌抄底信号 → 仓位下限 ${Math.round(POS_PANIC_CAP * 100)}%（不被溢价系数打折）；重新站上 MA21 补到 ${Math.round(POS_PANIC_CAP_ADD * 100)}%`)
    : !usOk
      ? `美股走坏且未止跌 → 整体封顶 ${Math.round(POS_US_BAD_CAP * 100)}%：溢价${dipLiftBase != null ? ` ${p.toFixed(1)}% 虽属便宜区（抄底仓上限 ${Math.round(dipLiftBase * 100)}%）` : '再低'}，${dipLiftBase != null ? '但' : ''}美股趋势没好转就不抬仓`
      : (dipLift != null && dipLift > trendCap)
        ? `趋势基准上限 ${Math.round(trendCap * 100)}%，溢价 ${p.toFixed(1)}% 属便宜区 + 美股趋势正常/已止跌 → 抬高到 ${Math.round(dipLift * 100)}% 的抄底仓`
        : `${up ? '趋势向上' : '趋势破坏'} → 基准上限 ${Math.round(trendCap * 100)}%`;

  return {
    action, tone, headline, entryNote, capNote, panic: last.panic,
    state: last.state, stateLabel: up ? '趋势向上' : '趋势破坏',
    bull: last.bull, posPct, target: last.target,
    capTrend: baseCap, premiumFactor: last.factor, premium: p, premiumZone: zone,
    ma21: last.ma21, ma60: last.ma60, close: last.close, belowDays: last.belowDays, intraday: last.intraday,
    factorTable: POS_FACTOR_TABLE.map(x => ({ ...x, active: last.factor === x.factor })),
    // 美股趋势确认（低溢价能否抬仓的前提）：供前端仓位卡直接展示
    usTrend: usInfo,
    triggers, backtest,
    // 逐日序列：供前端「仓位阶梯图」与历史查看（近 120 个交易日）
    history: series.slice(-120),
  };
}

// 历史回溯：全区间最佳买卖点 + 多指标策略对比（含每套策略的实际交易日期）
//  · bestBuys/bestSells：事后最优（后视镜视角，用于看清「什么样的位置才是好位置」）
//  · signalBuys：策略可捕捉的买点（MACD 买入信号 ∩ 溢价 ≤18%）
//  · backtest：覆盖 溢价 / MACD / RSI / KDJ / 威廉%R / 布林带 / 均线 / ATR 止损 / 仓位分级
//    共 20+ 套规则；每套附 tradeLog —— 真正出手的日期、价格、单笔收益、持有天数，
//    前端可点击策略行展开「符合条件交易的所有日期」。
//  · 指标口径与 scripts/etf-indicator-study.js 完全一致（同一套 RSI/WR/KDJ/BOLL/ATR/MACD 算法）。
function buildEtfHistoryReview(klines, navMap, signals) {
  const n = klines.length;
  if (n < 30) return null;
  const C = klines.map(k => k.close);
  const H = klines.map(k => (isFinite(k.high) ? k.high : k.close));
  const L = klines.map(k => (isFinite(k.low) ? k.low : k.close));
  const premAt = i => {
    const nav = navMap[klines[i].date];
    return nav > 0 ? +((klines[i].close / nav - 1) * 100).toFixed(2) : null;
  };
  const prem = klines.map((_, i) => premAt(i));

  // ── 指标序列（全历史，各规则共用）──
  const ma5 = movingAvgSeries(C, 5), ma10 = movingAvgSeries(C, 10), ma20 = movingAvgSeries(C, 20);
  const ma21 = movingAvgSeries(C, 21), ma60 = movingAvgSeries(C, 60);
  const rsi = rsiSeries(C, 14);
  const willR = williamsRSeries(H, L, C, 14);
  const kdj = kdjSeries(H, L, C, 9);
  const K = kdj.K, D = kdj.D;
  const boll = bollingerSeries(C, 20, 2);
  const atr = atrSeries(H, L, C, 14);
  const vol = klines.map(k => (isFinite(k.volume) ? k.volume : 0));
  const volMa5 = movingAvgSeries(vol, 5);
  const ema12 = calcEMA(C, 12), ema26 = calcEMA(C, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEMA(dif, 9);

  const crossUp = (a, b, i) => i > 0 && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
  const crossDn = (a, b, i) => i > 0 && a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];

  // MACD 视图信号（强买/弱买/强卖/破MA21…）→ 按日索引，保证与「买卖信号清单」口径一致
  const sigAt = new Map();
  (signals || []).forEach(s => sigAt.set(s.idx, s));
  const isBuySigAt = i => { const s = sigAt.get(i); return !!s && s.side === 'buy'; };
  const isSellSigAt = i => { const s = sigAt.get(i); return !!s && s.side === 'sell'; };

  const fwdRet = (i, d) => (i + d < n) ? +((klines[i + d].close / klines[i].close - 1) * 100).toFixed(2) : null;
  const fwdExt = (i, d, mode) => {
    let v = mode === 'low' ? Infinity : -Infinity;
    for (let j = i + 1; j <= Math.min(n - 1, i + d); j++) {
      v = mode === 'low' ? Math.min(v, klines[j].close) : Math.max(v, klines[j].close);
    }
    if (!isFinite(v)) return null;
    return +((v / klines[i].close - 1) * 100).toFixed(2);
  };
  const rows = klines.map((k, i) => ({
    i, date: k.date, close: k.close, premium: premAt(i),
    r5: fwdRet(i, 5), r20: fwdRet(i, 20), r60: fwdRet(i, 60),
    low20: fwdExt(i, 20, 'low'), high20: fwdExt(i, 20, 'high'),
  }));

  // 去重挑选：同一波低点只保留最有代表性的一天
  const pickSpread = (arr, key, dir, limit, gap = 8) => {
    const sorted = [...arr].filter(r => r[key] != null).sort((a, b) => dir === 'desc' ? b[key] - a[key] : a[key] - b[key]);
    const out = [];
    for (const r of sorted) {
      if (out.some(o => Math.abs(o.i - r.i) < gap)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out.map(r => ({ date: r.date, close: r.close, premium: r.premium, r20: r.r20, r60: r.r60, low20: r.low20, high20: r.high20 }));
  };
  const risk = rows.filter(r => r.low20 != null);
  const bestBuys = pickSpread(rows, 'r20', 'desc', 5);
  const bestSells = pickSpread(risk, 'low20', 'asc', 5);
  const worstBuys = pickSpread(rows, 'r20', 'asc', 3);

  const minRow = rows.reduce((a, b) => (b.close < a.close ? b : a));
  const maxRow = rows.reduce((a, b) => (b.close > a.close ? b : a));
  const premSorted = rows.map(r => r.premium).filter(v => v != null).sort((a, b) => a - b);
  const pq = q => premSorted.length ? premSorted[Math.min(premSorted.length - 1, Math.round(q * (premSorted.length - 1)))] : null;

  // 策略可捕捉的买点：MACD 买入信号且当时溢价 ≤18%
  const signalBuys = (signals || [])
    .filter(s => s.side === 'buy' && s.idx < n && premAt(s.idx) != null && premAt(s.idx) <= PREMIUM_BUY)
    .map(s => ({ date: s.date, close: s.close, label: s.label, premium: premAt(s.idx), r20: fwdRet(s.idx, 20), r60: fwdRet(s.idx, 60) }))
    .slice(-8);

  // ── 回测引擎（收盘价成交，不含手续费/溢价滑点）──
  // binary：全仓进 / 全仓出，记录每一笔买卖日期
  const runBinary = (name, group, buyFn, sellFn, opt = {}) => {
    let cash = 1, shares = 0, entry = 0, entryIdx = -1, peak = 0, wins = 0, exposure = 0;
    const curve = [], tradeLog = [];
    for (let i = 0; i < n; i++) {
      const k = klines[i], p = prem[i];
      if (shares === 0) {
        if (buyFn(i, p)) {
          shares = cash / k.close; cash = 0; entry = k.close; entryIdx = i; peak = k.close;
          tradeLog.push({ date: k.date, side: 'buy', price: +k.close.toFixed(3), pos: 1, retPct: null, holdDays: null, label: '买入' });
        }
      } else {
        if (isFinite(k.high)) peak = Math.max(peak, k.high);
        const trail = opt.trailAtr && atr[i] != null && k.close <= peak - opt.trailAtr * atr[i];
        const hard = opt.hardStopPct && k.close <= entry * (1 - opt.hardStopPct);
        if (trail || hard || sellFn(i, p)) {
          const ret = (k.close / entry - 1) * 100;
          if (k.close > entry) wins++;
          tradeLog.push({
            date: k.date, side: 'sell', price: +k.close.toFixed(3), pos: 0,
            retPct: +ret.toFixed(2), holdDays: i - entryIdx,
            label: trail ? 'ATR 止损' : hard ? '硬止损' : '卖出',
          });
          cash = shares * k.close; shares = 0;
        }
      }
      if (shares > 0) exposure++;
      curve.push(shares > 0 ? shares * k.close : cash);
    }
    let peakV = curve[0], mdd = 0;
    for (const v of curve) { peakV = Math.max(peakV, v); mdd = Math.min(mdd, (v / peakV - 1) * 100); }
    const equity = shares > 0 ? shares * klines[n - 1].close : cash;
    const yrs = n / 252;
    const buyCount = tradeLog.filter(t => t.side === 'buy').length;
    const sellCount = tradeLog.filter(t => t.side === 'sell').length;
    return {
      name, group, kind: 'binary',
      totalPct: +((equity - 1) * 100).toFixed(1),
      annualPct: +((Math.pow(equity, 1 / yrs) - 1) * 100).toFixed(1),
      // 交易次数 = 已了结的完整买卖对（卖出次数）；胜率 = 盈利卖出 / 已了结交易
      trades: sellCount, winPct: sellCount ? +(wins / sellCount * 100).toFixed(0) : null,
      mddPct: +mdd.toFixed(1), exposurePct: +(exposure / n * 100).toFixed(0), holding: shares > 0,
      buyCount, sellCount, entryCount: buyCount,
      tradeLog,
    };
  };

  // graded：按目标仓位（0~100%）在收盘调仓，可表达「重仓 / 加仓 / 减仓 / 清仓」
  const runGraded = (name, group, targetFn) => {
    let shares = 0, cash = 1, exposure = 0, rebal = 0;
    const curve = [], tradeLog = [];
    for (let i = 0; i < n; i++) {
      const k = klines[i], p = prem[i];
      const total = cash + shares * k.close;
      const cur = total > 0 ? (shares * k.close) / total : 0;
      let tgt = targetFn(i, p);
      tgt = tgt == null ? cur : Math.max(0, Math.min(1, tgt));
      if (Math.abs(tgt - cur) > 0.02) {
        const up = tgt > cur;
        const act = tgt >= 0.99 ? '重仓' : tgt <= 0.01 ? '清仓' : up ? '加仓' : '减仓';
        tradeLog.push({
          date: k.date, side: up ? 'buy' : 'sell', price: +k.close.toFixed(3),
          pos: +tgt.toFixed(2), retPct: null, holdDays: null,
          label: `${act}至 ${Math.round(tgt * 100)}%`,
        });
        shares = (total * tgt) / k.close; cash = total * (1 - tgt);
        rebal++;
      }
      if (tgt > 0.01) exposure++;
      curve.push(cash + shares * k.close);
    }
    let peakV = curve[0], mdd = 0;
    for (const v of curve) { peakV = Math.max(peakV, v); mdd = Math.min(mdd, (v / peakV - 1) * 100); }
    const equity = curve[curve.length - 1];
    const yrs = n / 252;
    return {
      name, group, kind: 'graded',
      totalPct: +((equity - 1) * 100).toFixed(1),
      annualPct: +((Math.pow(equity, 1 / yrs) - 1) * 100).toFixed(1),
      trades: rebal, winPct: null,
      mddPct: +mdd.toFixed(1), exposurePct: +(exposure / n * 100).toFixed(0), holding: shares > 0,
      buyCount: tradeLog.filter(t => t.side === 'buy').length,
      sellCount: tradeLog.filter(t => t.side === 'sell').length,
      tradeLog,
    };
  };

  const P = PREMIUM_BUY, PA = PREMIUM_ADD, PW = PREMIUM_WATCH, PD = PREMIUM_DANGER;
  const bt = [];

  // ① 基准
  bt.push((() => {
    const g = klines[n - 1].close / klines[0].close;
    const yrs = n / 252;
    let pk = klines[0].close, mdd = 0;
    for (const k of klines) { pk = Math.max(pk, k.close); mdd = Math.min(mdd, (k.close / pk - 1) * 100); }
    return {
      name: '买入持有（基准）', group: '基准', kind: 'hold',
      totalPct: +((g - 1) * 100).toFixed(1),
      annualPct: +((Math.pow(g, 1 / yrs) - 1) * 100).toFixed(1),
      trades: 1, winPct: null, mddPct: +mdd.toFixed(1), exposurePct: 100, holding: true,
      buyCount: 1, sellCount: 0,
      tradeLog: [
        { date: klines[0].date, side: 'buy', price: +klines[0].close.toFixed(3), pos: 1, retPct: null, holdDays: null, label: `期初买入 · 持有至今（${n - 1} 个交易日）` },
      ],
    };
  })());

  // ② MACD 系
  bt.push(runBinary('MACD 金叉买 / 死叉卖（不看溢价）', 'MACD',
    (i) => isBuySigAt(i), (i) => isSellSigAt(i)));
  bt.push(runBinary(`MACD 买点 ∩ 溢价 ≤${P}%`, 'MACD',
    (i, p) => isBuySigAt(i) && p != null && p <= P, (i) => isSellSigAt(i)));
  bt.push(runBinary(`MACD 买点 ∩ 溢价 <${PA}%（重仓买）`, 'MACD',
    (i, p) => isBuySigAt(i) && p != null && p < PA, (i) => isSellSigAt(i)));
  bt.push(runBinary(`MACD 金叉 ∩ RSI<60 ∩ 溢价≤${P}% 买 / MACD 死叉 ∪ 溢价≥${PW}% 卖`, 'MACD',
    (i, p) => crossUp(dif, dea, i) && rsi[i] != null && rsi[i] < 60 && p != null && p <= P,
    (i, p) => crossDn(dif, dea, i) || (p != null && p >= PW)));

  // ③ 溢价系
  bt.push(runBinary(`纯溢价：<${P}% 买 / ≥${PW}% 卖`, '溢价',
    (i, p) => p != null && p < P, (i, p) => p != null && p >= PW));
  bt.push(runBinary(`溢价 ≤${P}% 买 / 溢价 ≥${PD}% 才卖（拉长持有）`, '溢价',
    (i, p) => p != null && p <= P, (i, p) => p != null && p >= PD));
  bt.push(runBinary(`溢价 ≤${P}% ∩ 收盘<MA21 买 / 溢价 ≥${PW}% 卖`, '溢价',
    (i, p) => p != null && p <= P && ma21[i] != null && C[i] < ma21[i], (i, p) => p != null && p >= PW));
  bt.push(runBinary(`溢价 ≤${P}% ∩ 威廉%R≤-60 买 / 溢价 ≥${PW}% 卖`, '溢价',
    (i, p) => p != null && p <= P && willR[i] != null && willR[i] <= -60, (i, p) => p != null && p >= PW));
  bt.push(runBinary(`溢价 ≤${P}% ∩ 布林下半区买 / 溢价 ≥${PW}% 卖`, '溢价',
    (i, p) => p != null && p <= P && boll.mid[i] != null && C[i] < boll.mid[i], (i, p) => p != null && p >= PW));
  bt.push(runBinary(`溢价 ≤${P}% 买入 · 跌破 MA21 减仓（持有为主）`, '溢价',
    (i, p) => p != null && p <= P, (i, p) => ma21[i] != null && C[i] < ma21[i]));

  // ④ RSI 系
  bt.push(runBinary('RSI(14)<30 买 / >70 卖', 'RSI',
    (i) => rsi[i] != null && rsi[i] < 30, (i) => rsi[i] != null && rsi[i] > 70));
  bt.push(runBinary(`RSI<35 ∩ 溢价≤${P}% 买 / RSI>70 ∪ 溢价≥${PW}% 卖`, 'RSI',
    (i, p) => rsi[i] != null && rsi[i] < 35 && p != null && p <= P,
    (i, p) => (rsi[i] != null && rsi[i] > 70) || (p != null && p >= PW)));

  // ⑤ KDJ 系
  bt.push(runBinary('KDJ：K<30 金叉买 / K>70 死叉卖', 'KDJ',
    (i) => crossUp(K, D, i) && K[i] < 30, (i) => crossDn(K, D, i) && K[i] > 70));
  bt.push(runBinary(`KDJ 金叉 ∩ 溢价≤${P}% 买 / KDJ 死叉 ∪ RSI>75 卖`, 'KDJ',
    (i, p) => crossUp(K, D, i) && p != null && p <= P,
    (i) => crossDn(K, D, i) || (rsi[i] != null && rsi[i] > 75)));

  // ⑥ 威廉%R 系
  bt.push(runBinary('威廉%R(14) ≤-80 买 / ≥-20 卖', '威廉%R',
    (i) => willR[i] != null && willR[i] <= -80, (i) => willR[i] != null && willR[i] >= -20));

  // ⑦ 布林带系
  bt.push(runBinary('布林带：触下轨买 / 触上轨卖', '布林带',
    (i) => boll.dn[i] != null && C[i] <= boll.dn[i], (i) => boll.up[i] != null && C[i] >= boll.up[i]));
  bt.push(runBinary(`布林下轨 ∩ RSI<35 买 / 上轨 ∪ 溢价≥${PW}% 卖`, '布林带',
    (i) => boll.dn[i] != null && C[i] <= boll.dn[i] && rsi[i] != null && rsi[i] < 35,
    (i, p) => (boll.up[i] != null && C[i] >= boll.up[i]) || (p != null && p >= PW)));

  // ⑧ 均线系
  bt.push(runBinary('MA5/MA21 金叉买 / 死叉卖', '均线',
    (i) => crossUp(ma5, ma21, i), (i) => crossDn(ma5, ma21, i)));
  bt.push(runBinary('收盘上穿 MA21 买 / 跌破 MA21 卖', '均线',
    (i) => i > 0 && ma21[i - 1] != null && C[i - 1] <= ma21[i - 1] && C[i] > ma21[i],
    (i) => i > 0 && ma21[i - 1] != null && C[i - 1] >= ma21[i - 1] && C[i] < ma21[i]));
  bt.push(runBinary('多头排列（MA5>MA21>MA60）买 / 跌破 MA21 卖', '均线',
    (i) => ma5[i] != null && ma21[i] != null && ma60[i] != null && ma5[i] > ma21[i] && ma21[i] > ma60[i],
    (i) => ma21[i] != null && C[i] < ma21[i]));

  // ⑨ 量能系
  bt.push(runBinary('放量突破：上穿 MA21 ∩ 量>1.5×5日均量 买 / 跌破 MA21 卖', '量能',
    (i) => i > 0 && ma21[i - 1] != null && C[i - 1] <= ma21[i - 1] && C[i] > ma21[i]
      && volMa5[i] > 0 && vol[i] > volMa5[i] * 1.5,
    (i) => ma21[i] != null && C[i] < ma21[i]));
  bt.push(runBinary('价涨量增确认：MACD 金叉 ∩ 量>5日均量 买 / MACD 死叉卖', '量能',
    (i) => crossUp(dif, dea, i) && volMa5[i] > 0 && vol[i] > volMa5[i],
    (i) => crossDn(dif, dea, i)));

  // ⑩ 多指标共振（高成功率组合：溢价 + RSI + KDJ + MA21 四重确认）
  bt.push(runBinary(`多指标共振：溢价≤${P}% ∩ RSI<50 ∩ KDJ多头(K>D) ∩ 站上MA21 买 / 溢价≥${PW}% ∪ MACD死叉 卖`, '共振',
    (i, p) => p != null && p <= P && rsi[i] != null && rsi[i] < 50
      && K[i] != null && D[i] != null && K[i] > D[i] && ma21[i] != null && C[i] > ma21[i],
    (i, p) => crossDn(dif, dea, i) || (p != null && p >= PW)));

  // ⑪ 止损 / 仓位管理系
  bt.push(runBinary(`溢价 ≤${P}% 买 + 3×ATR 跟踪止损`, '止损/仓位',
    (i, p) => p != null && p <= P, () => false, { trailAtr: 3 }));
  bt.push(runBinary(`溢价 ≤${P}% 买 + 固定 -7% 硬止损`, '止损/仓位',
    (i, p) => p != null && p <= P, () => false, { hardStopPct: 0.07 }));

  // ⑫ 多级仓位（重仓 / 减仓 / 清仓）
  bt.push(runGraded('仓位分级：溢价档位 × RSI（低价重仓 · 高溢价清仓）', '仓位分级',
    (i, p) => {
      if (p == null) return null;
      const r = rsi[i];
      if (p >= PD || (p >= PW && r != null && r > 75)) return 0;    // 清仓：极高溢价 / 高位超买
      if (p >= PW) return 0.3;                                      // 减仓：只留三成
      if (p <= PA && r != null && r < 45) return 1;                 // 重仓：加仓线以下且未超买
      if (p <= P) return 0.6;                                       // 建仓：买入线以下六成
      return 0.3;                                                   // 观望：三成底仓
    }));
  bt.push(runGraded('仓位分级：溢价档位 × KDJ × MA21（趋势跟随）', '仓位分级',
    (i, p) => {
      if (p == null) return null;
      const bull = ma21[i] != null && C[i] > ma21[i];
      const kd = K[i] != null && D[i] != null;
      if (p >= PD) return 0;                                        // 清仓
      if (p <= PA && bull) return 1;                                // 重仓
      if (p <= P && (!kd || K[i] > D[i])) return 0.6;               // 建仓（KDJ 多头）
      if (p >= PW || (kd && K[i] < D[i] && !bull)) return 0.3;      // 减仓
      return 0.6;
    }));

  // ── 汇总：交易日期统计 ──
  const tradeDateStats = (() => {
    let buys = 0, sells = 0, events = 0;
    for (const b of bt) { buys += b.buyCount || 0; sells += b.sellCount || 0; events += (b.tradeLog || []).length; }
    return { strategies: bt.length, buyEvents: buys, sellEvents: sells, events };
  })();

  // ── 自动结论：性价比最高 / 胜率最高 ──
  const rankedByCalmar = bt
    .filter(b => b.kind !== 'hold' && b.mddPct < -0.5 && b.trades >= 2)
    .map(b => ({ name: b.name, calmar: +(b.annualPct / Math.abs(b.mddPct)).toFixed(2), annualPct: b.annualPct, mddPct: b.mddPct, winPct: b.winPct, trades: b.trades }))
    .sort((a, b) => b.calmar - a.calmar);
  const topByCalmar = rankedByCalmar[0] || null;
  const topByWin = bt
    .filter(b => b.winPct != null && b.trades >= 2)
    .map(b => ({ name: b.name, winPct: b.winPct, trades: b.trades, totalPct: b.totalPct }))
    .sort((a, b) => b.winPct - a.winPct || b.trades - a.trades)[0] || null;

  return {
    start: klines[0].date,
    end: klines[n - 1].date,
    days: n,
    firstClose: klines[0].close,
    lastClose: klines[n - 1].close,
    buyHoldPct: +((klines[n - 1].close / klines[0].close - 1) * 100).toFixed(1),
    rangeLow: { date: minRow.date, close: minRow.close, premium: minRow.premium },
    rangeHigh: { date: maxRow.date, close: maxRow.close, premium: maxRow.premium },
    premiumDist: {
      days: premSorted.length, min: pq(0), p10: pq(0.1), p25: pq(0.25), median: pq(0.5), p75: pq(0.75), max: pq(1),
      belowBuy: +(premSorted.filter(v => v <= PREMIUM_BUY).length / (premSorted.length || 1) * 100).toFixed(1),
      belowAdd: +(premSorted.filter(v => v < PREMIUM_ADD).length / (premSorted.length || 1) * 100).toFixed(1),
      aboveWatch: +(premSorted.filter(v => v >= PREMIUM_WATCH).length / (premSorted.length || 1) * 100).toFixed(1),
      aboveDanger: +(premSorted.filter(v => v >= PREMIUM_DANGER).length / (premSorted.length || 1) * 100).toFixed(1),
      aboveWatchDays: premSorted.filter(v => v >= PREMIUM_WATCH).length,
      aboveDangerDays: premSorted.filter(v => v >= PREMIUM_DANGER).length,
    },
    bestBuys, bestSells, worstBuys, signalBuys,
    backtest: bt,
    tradeDateStats,
    topByCalmar, topByWin,
    signalStats: (() => {
      const buys = (signals || []).filter(s => s.side === 'buy');
      const wins = buys.filter(s => (s.holdRetPct ?? 0) > 0).length;
      return { total: (signals || []).length, buyCount: buys.length, sellCount: (signals || []).length - buys.length, winRate: buys.length ? +(wins / buys.length * 100).toFixed(1) : null };
    })(),
  };
}

// 用当前价估算「今日这根 MACD 柱」，用于盘中翻红/翻绿提示
function etfIntradayBar(klines, price, todayStr) {
  if (!klines.length || !isFinite(price)) return null;
  const k = klines.map(x => ({ date: x.date, close: x.close }));
  const last = k[k.length - 1];
  if (last.date === todayStr) last.close = price;
  else k.push({ date: todayStr, close: price });
  const closes = k.map(x => x.close);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEMA(dif, 9);
  const n = closes.length - 1;
  return {
    bar: (dif[n] - dea[n]) * 2,
    prevBar: (dif[n - 1] - dea[n - 1]) * 2,
    dif: dif[n],
    dea: dea[n],
    isToday: last.date === todayStr,
  };
}

// 每日操作建议：溢价率档位（一级决策变量）× 技术面 × 持仓
// 决策顺序：① 溢价减仓区（>27%）→ ② 技术面转空 → ③ 加仓/买入区 → ④ 观望区 → ⑤ 兜底
function buildEtfAdvice(ctx) {
  const { quote, ind, lastSignal, pos, todayBar, signals } = ctx;
  const premium = quote.premiumPct;
  const zone = premiumZone(premium);
  const iopv = quote.iopv;
  const price = quote.price != null ? quote.price : ind.price;
  const reasons = [];

  const techBull = ind.price > ind.ma21 && ind.bar > 0;
  const techBear = ind.price < ind.ma21 && ind.bar < 0;
  const buySide = lastSignal && lastSignal.side === 'buy';
  const sellSide = lastSignal && lastSignal.side === 'sell';

  // 溢价档位对应的挂单价 + 现价距买入线还有多远
  const ladder = premiumPriceLadder(iopv);
  const buyPrice = ladder ? ladder.buy.price : null;
  const addPrice = ladder ? ladder.add.price : null;
  const toBuyPct = (buyPrice && price) ? (price / buyPrice - 1) * 100 : null;
  const toAddPct = (addPrice && price) ? (price / addPrice - 1) * 100 : null;

  reasons.push({
    tone: (zone.key === 'add' || zone.key === 'buy') ? 'good' : zone.key === 'watch' ? 'neutral' : zone.key === 'unknown' ? 'neutral' : 'bad',
    label: `溢价 ${zone.label}`,
    text: premium != null
      ? `场内价 ${price.toFixed(3)} / IOPV ${iopv != null ? iopv.toFixed(4) : '—'} = 溢价 ${premium.toFixed(2)}%（买入线 ${PREMIUM_BUY}% · 加仓线 ${PREMIUM_ADD}%）`
      : '溢价数据缺失',
  });
  if (toBuyPct != null && toBuyPct > 0) {
    reasons.push({
      tone: 'neutral',
      label: '距买入线',
      text: `现价 ${price.toFixed(3)} 比买入价 ${buyPrice.toFixed(3)}（溢价 ${PREMIUM_BUY}%）贵 ${toBuyPct.toFixed(2)}%`
        + (toAddPct != null && toAddPct > 0 ? `，比加仓价 ${addPrice.toFixed(3)}（溢价 ${PREMIUM_ADD}%）贵 ${toAddPct.toFixed(2)}%` : '')
        + '；要么等价格回落，要么等溢价收敛',
    });
  } else if (toBuyPct != null) {
    reasons.push({
      tone: 'good',
      label: '已达买入线',
      text: `现价 ${price.toFixed(3)} 低于买入价 ${buyPrice.toFixed(3)}（溢价 ${PREMIUM_BUY}%）${Math.abs(toBuyPct).toFixed(2)}%`
        + (toAddPct != null && toAddPct <= 0 ? `，且已低于加仓价 ${addPrice.toFixed(3)}（溢价 ${PREMIUM_ADD}%），可加大买入力度` : ''),
    });
  }
  reasons.push({
    tone: techBull ? 'good' : techBear ? 'bad' : 'neutral',
    label: '技术面',
    text: `价格${ind.price > ind.ma21 ? '站上' : '跌破'} MA21(${ind.ma21 != null ? ind.ma21.toFixed(3) : '—'})，MACD ${ind.bar >= 0 ? '红柱 +' : '绿柱 '}${ind.bar.toFixed(3)}`,
  });
  if (lastSignal) {
    reasons.push({
      tone: buySide ? 'good' : 'bad',
      label: `最近信号 ${lastSignal.label}`,
      text: `${lastSignal.date} @ ${lastSignal.close.toFixed(3)}，建议${lastSignal.action}；此后${lastSignal.sinceRetPct >= 0 ? '涨' : '跌'} ${Math.abs(lastSignal.sinceRetPct).toFixed(2)}%`,
    });
  }
  if (todayBar && todayBar.isToday) {
    const flip = todayBar.prevBar <= 0 && todayBar.bar > 0 ? '翻红'
      : todayBar.prevBar >= 0 && todayBar.bar < 0 ? '翻绿' : '延续';
    reasons.push({
      tone: flip === '翻红' ? 'good' : flip === '翻绿' ? 'bad' : 'neutral',
      label: '盘中柱',
      text: `现价估算今日 MACD 柱 ${todayBar.bar >= 0 ? '+' : ''}${todayBar.bar.toFixed(3)}（${flip}）`,
    });
  }

  // 关键价位：把溢价档位翻译成可直接挂单的价格
  const levels = [];
  if (ladder) {
    levels.push({ label: `加仓价 · 溢价 ${PREMIUM_ADD}%`, price: ladder.add.price, note: '低于此价可多买', tone: 'buy' });
    levels.push({ label: `买入价 · 溢价 ${PREMIUM_BUY}%`, price: ladder.buy.price, note: '低于此价可买入', tone: 'buy' });
    levels.push({ label: `警戒价 · 溢价 ${PREMIUM_WATCH}%`, price: ladder.watch.price, note: '高于此位只减不加', tone: 'warn' });
    levels.push({ label: `减仓价 · 溢价 ${PREMIUM_DANGER}%`, price: ladder.cut.price, note: '溢价极高，减仓避险', tone: 'sell' });
    levels.push({ label: '净值参考价 IOPV', price: +iopv.toFixed(4), note: '溢价 0% 的理论价', tone: 'ref' });
  }
  if (ind.ma21 != null) levels.push({ label: 'MA21', price: +ind.ma21.toFixed(3), note: '多空分界，跌破减仓', tone: 'ref' });
  if (ind.ma5 != null) levels.push({ label: 'MA5', price: +ind.ma5.toFixed(3), note: '短线强弱', tone: 'ref' });
  const lastBuy = [...(signals || [])].reverse().find(s => s.side === 'buy');
  const lastSell = [...(signals || [])].reverse().find(s => s.side === 'sell');
  if (lastBuy) levels.push({ label: '最近买点', price: +lastBuy.close.toFixed(3), note: lastBuy.date, tone: 'buy' });
  if (lastSell) levels.push({ label: '最近卖点', price: +lastSell.close.toFixed(3), note: lastSell.date, tone: 'sell' });

  // ── 买点确认：溢价达标之外，再确认「没有在冲高」──
  // 回测依据（scripts/etf-indicator-study.js，764 个交易日）：
  //   · 溢价 ≤18% 单独用 → 年化 56.1% / Calmar 1.84；
  //   · 叠加一个「不追高」过滤（威廉%R≤-60 / 价格<MA21 / 价格<布林中轨，三者效果几乎一致）
  //     → 年化 57.6% / Calmar 1.89，且 3 年只交易 6 次（不增加操作频率）。
  //   · 溢价 18~22% 区间买入的未来 20 日期望收益为 -0.91%（胜率 39%），故溢价未达标时不谈买点。
  //   · 这些指标只用来过滤买点，不生成卖出信号——回测中按 RSI>70 等卖出会卖飞主升浪。
  const filterDefs = [
    {
      key: 'willr', label: '威廉%R ≤ -60', ok: ind.willR != null && ind.willR <= -60,
      value: ind.willR != null ? ind.willR.toFixed(1) : '—', hint: '14 日，≤-60 说明已回调到区间下沿',
    },
    {
      key: 'ma21', label: '价格 < MA21', ok: ind.ma21 != null && price < ind.ma21,
      value: ind.ma21 != null ? `${price.toFixed(3)} vs ${ind.ma21.toFixed(3)}` : '—', hint: '21 日均线下方，属回调而非追高',
    },
    {
      key: 'boll', label: '价格 < 布林中轨', ok: ind.bollMid != null && price < ind.bollMid,
      value: ind.bollMid != null ? `${price.toFixed(3)} vs ${ind.bollMid.toFixed(3)}` : '—', hint: '20 日均线中轨下方',
    },
  ];
  const premiumOk = premium != null && premium <= PREMIUM_BUY;
  const hitFilters = filterDefs.filter(f => f.ok);
  const confirm = {
    premiumOk,
    filters: filterDefs,
    hit: hitFilters.map(f => f.label),
    hitCount: hitFilters.length,
    level: !premiumOk ? 'none' : hitFilters.length ? 'good' : 'chasing',
    note: !premiumOk
      ? '溢价未达买入线，先等价格回落或溢价收敛（历史分档：溢价 18~22% 区间买入的未来 20 日期望收益为 -0.91%）'
      : hitFilters.length
        ? `溢价已达标，且「${hitFilters.map(f => f.label).join('、')}」命中——回测中期望收益最好的买点形态，可分批买入`
        : '溢价已达标，但价格仍在冲高（三项过滤器均未命中）；回测显示此时买入的短期期望收益偏低，建议先下一笔、留足子弹',
  };

  let level = 'wait';
  let action = '观望';
  let headline = '';
  const held = !!(pos && pos.shares > 0);
  const inBuyZone = zone.key === 'add' || zone.key === 'buy';
  const pctTxt = premium != null ? premium.toFixed(1) : '—';
  const buyTxt = buyPrice ? buyPrice.toFixed(3) : '—';
  const addTxt = addPrice ? addPrice.toFixed(3) : '—';

  if (zone.key === 'exit') {
    // 溢价 >27%：溢价风险压倒一切
    if (held) {
      level = 'danger'; action = '减仓';
      headline = `溢价 ${pctTxt}% 已进「极高」区（>${PREMIUM_DANGER}%），建议减仓，规避溢价回落`;
    } else {
      level = 'wait'; action = '观望（不买入）';
      headline = `溢价 ${pctTxt}% 属极高区间，坚决不追高；等回到 ${buyTxt} 以下再谈买入`;
    }
  } else if (held && sellSide && ind.price < ind.ma21) {
    level = 'danger'; action = '减仓 / 清仓';
    headline = `技术面转空（${lastSignal.label}）且跌破 MA21，建议减仓`
      + (inBuyZone ? `（溢价 ${pctTxt}% 虽已达标，但趋势先破位，先减仓等企稳）` : '');
  } else if (zone.key === 'avoid') {
    if (held) {
      level = 'warn'; action = '减仓（暂停加仓）';
      headline = `溢价 ${pctTxt}% 高于警戒线 ${PREMIUM_WATCH}%，持有者可分批减仓，不宜再加仓`;
    } else {
      level = 'wait'; action = '观望（不买入）';
      headline = `溢价 ${pctTxt}% 高于警戒线 ${PREMIUM_WATCH}%，等回落至 ${buyTxt}（溢价 ${PREMIUM_BUY}%）再买入`;
    }
  } else if (inBuyZone) {
    const strong = zone.key === 'add';
    if (held) {
      level = 'buy';
      action = strong ? '加仓（多买）' : '持有 / 小幅加仓';
      headline = strong
        ? `溢价 ${pctTxt}% 已低于加仓线 ${PREMIUM_ADD}%（对应价 ${addTxt}），可加大买入力度`
        : `溢价 ${pctTxt}% 在买入区（${PREMIUM_ADD}~${PREMIUM_BUY}%），持有并可小幅加仓`;
    } else if (techBear) {
      level = 'warn'; action = '小仓试探';
      headline = `溢价 ${pctTxt}% 已到${strong ? '加仓线' : '买入线'}以下，但技术面偏空（跌破 MA21 且绿柱），建议首笔半仓、留足子弹`;
    } else if (!techBull && !buySide) {
      level = 'warn'; action = '分批建仓';
      headline = `溢价 ${pctTxt}% 已进${zone.label}，趋势未确认，建议分批小仓介入`;
    } else {
      level = 'buy';
      action = strong ? '多买（加仓）' : '分批买入';
      headline = strong
        ? `溢价 ${pctTxt}% 已低于加仓线 ${PREMIUM_ADD}%（对应价 ${addTxt}），可加大买入力度`
        : `溢价 ${pctTxt}% 低于买入线 ${PREMIUM_BUY}%（对应价 ${buyTxt}），技术面配合，可分批买入`;
    }
  } else if (zone.key === 'watch') {
    if (held) {
      level = 'hold'; action = '持有（不加仓）';
      headline = `溢价 ${pctTxt}% 略高于买入线 ${PREMIUM_BUY}%，持有不加仓，等回到 ${buyTxt} 以下`;
    } else {
      level = 'wait'; action = '观望';
      headline = `溢价 ${pctTxt}% 仍高于买入线 ${PREMIUM_BUY}%，等跌到 ${buyTxt}（或溢价收敛）再买`;
    }
  } else {
    // 溢价数据缺失：退回纯技术面判断
    if (held && techBull) {
      level = 'hold'; action = '持有';
      headline = '多头趋势延续，继续持有（溢价数据缺失，注意自行核对溢价）';
    } else if (held && techBear) {
      level = 'warn'; action = '减仓';
      headline = '价格跌破 MA21 且 MACD 绿柱，建议逐步减仓';
    } else if (held) {
      level = 'hold'; action = '持有观察';
      headline = '趋势未明确，持有并关注 MA21 与溢价变化';
    } else if (sellSide) {
      level = 'wait'; action = '观望';
      headline = '技术面偏空，等待新的买入信号';
    } else {
      level = 'wait'; action = '观望';
      headline = '溢价数据缺失，暂不判断';
    }
  }

  return { level, action, headline, reasons, levels, held, zone: zone.key, confirm };
}

// 盘中提示：状态型条件（每次请求重算，前端按 key 去重后只提示新增项）
function buildEtfAlerts(ctx) {
  const { quote, ind, todayBar, signals } = ctx;
  const out = [];
  const add = (key, level, title, text, pri) => out.push({ key, level, title, text, pri });
  const zone = premiumZone(quote.premiumPct);
  const pz = quote.premiumPct;
  const ladder = premiumPriceLadder(quote.iopv);

  // 溢价穿越买入线 / 加仓线（盘中对比上一次请求，真正的「该出手了」提示）
  const pc = ctx.premCross;
  if (pc && pc.crossedDown && pc.crossedDown.length) {
    for (const line of pc.crossedDown) {
      const isAdd = line === PREMIUM_ADD;
      const isBuy = line === PREMIUM_BUY;
      add(`premium_cross_dn_${line}`, 'good', `溢价跌破 ${line}%${isAdd ? '加仓线' : isBuy ? '买入线' : '档位线'}`,
        `溢价由 ${pc.from.toFixed(2)}% 收敛至 ${pc.to.toFixed(2)}%`
        + (ladder ? `，加仓价 ${ladder.add.price} / 买入价 ${ladder.buy.price}` : '')
        + (isAdd ? '；已进入加仓区，按策略可多买' : isBuy ? '；已进入买入区，可分批买入' : ''));
    }
  }
  if (pc && pc.crossedUp && pc.crossedUp.length) {
    for (const line of pc.crossedUp) {
      const isDanger = line === PREMIUM_DANGER;
      add(`premium_cross_up_${line}`, isDanger ? 'danger' : 'warn', `溢价升破 ${line}%${isDanger ? '减仓线' : '警戒线'}`,
        `溢价由 ${pc.from.toFixed(2)}% 扩张至 ${pc.to.toFixed(2)}%`
        + (isDanger ? '；溢价风险显著，持有者考虑减仓，不追高' : '；买入性价比下降'));
    }
  }

  if (zone.key === 'add') {
    add('premium_zone_add', 'good', '溢价进入加仓区',
      `当前溢价 ${pz.toFixed(2)}%（<${PREMIUM_ADD}%），按策略可多买；IOPV ${quote.iopv != null ? quote.iopv.toFixed(4) : '—'}${ladder ? `，加仓价 ${ladder.add.price}` : ''}`);
  } else if (zone.key === 'buy') {
    add('premium_zone_buy', 'good', '溢价进入买入区',
      `当前溢价 ${pz.toFixed(2)}%（${PREMIUM_ADD}~${PREMIUM_BUY}%），可分批买入${ladder ? `，买入价 ${ladder.buy.price}` : ''}`);
  } else if (zone.key === 'avoid') {
    add('premium_zone_avoid', 'warn', '溢价高于警戒线',
      `当前溢价 ${pz.toFixed(2)}% 高于 ${PREMIUM_WATCH}%，只减不加，等回落到 ${ladder ? ladder.buy.price : '买入价'} 以下`);
  } else if (zone.key === 'exit') {
    add('premium_zone_exit', 'danger', '溢价极高',
      `场内价较净值溢价 ${pz.toFixed(2)}%，追高买入风险极大；该基金曾因高溢价申请停牌警示`);
  } else if (zone.key === 'watch') {
    add('premium_zone_watch', 'info', '溢价略高于买入线',
      `当前溢价 ${pz.toFixed(2)}% 高于买入线 ${PREMIUM_BUY}%，等回落至 ${ladder ? ladder.buy.price : '买入价'} 再介入`);
  }

  // ── 可执行的「买入机会」：溢价进区 且 技术面未破位（与建议卡同一套判定）──
  const adv = ctx.advice;
  if (adv && adv.level === 'buy') {
    const strong = adv.zone === 'add';
    add(strong ? 'buy_opportunity_strong' : 'buy_opportunity', 'good',
      strong ? '★ 加仓机会（按策略可多买）' : '★ 买入机会（可分批买入）',
      `溢价 ${pz.toFixed(2)}% 已进入${strong ? `加仓区（<${PREMIUM_ADD}%）` : `买入区（${PREMIUM_ADD}~${PREMIUM_BUY}%）`}，`
      + `现价 ${quote.price.toFixed(3)}`
      + (ladder ? `／买入价 ${ladder.buy.price}${strong ? `／加仓价 ${ladder.add.price}` : ''}` : '')
      + (adv.held ? '；已有持仓，按计划执行加仓' : '；建议分 2~3 笔建仓，先半仓'),
      -1);
  } else if (adv && adv.level === 'warn' && /试探|建仓/.test(adv.action || '')) {
    // 价位到了但技术面偏空 / 趋势未确认：降级为小仓试探，同样值得提醒
    add('buy_probe', 'warn', '价位已到，可小仓试探',
      `溢价 ${pz.toFixed(2)}% 已满足买入线，但${adv.headline.replace(/^溢价[^，]*，?/, '').replace(/^但/, '')}`,
      1);
  }
  // 还要再跌一点点：提前挂单提醒（IOPV 盘中会变，触发价也会跟着动）
  if (pz != null && ladder && pz >= PREMIUM_BUY && pz - PREMIUM_BUY <= 1.5) {
    add('near_buy_line', 'info', '接近买入线',
      `溢价 ${pz.toFixed(2)}% 距买入线 ${PREMIUM_BUY}% 仅 ${(pz - PREMIUM_BUY).toFixed(2)}pp；`
      + `现价跌到 ${ladder.buy.price} 即触发买入（按当前 IOPV ${quote.iopv != null ? quote.iopv.toFixed(4) : '—'} 折算）`);
  } else if (pz != null && ladder && pz >= PREMIUM_ADD && pz - PREMIUM_ADD <= 1.5 && zone.key === 'buy') {
    add('near_add_line', 'info', '接近加仓线',
      `溢价 ${pz.toFixed(2)}% 距加仓线 ${PREMIUM_ADD}% 仅 ${(pz - PREMIUM_ADD).toFixed(2)}pp；跌到 ${ladder.add.price} 可多买`);
  }

  if (ind.ma21 != null && ind.prevClose != null) {
    if (ind.price < ind.ma21 && ind.prevClose >= ind.ma21) {
      add('break_ma21', 'danger', '跌破 MA21',
        `现价 ${ind.price.toFixed(3)} 跌破 MA21(${ind.ma21.toFixed(3)})，按规则应减仓`);
    } else if (ind.price > ind.ma21 && ind.prevClose < ind.ma21) {
      add('reclaim_ma21', 'good', '站回 MA21',
        `现价 ${ind.price.toFixed(3)} 重新站上 MA21(${ind.ma21.toFixed(3)})，短线转强`);
    }
  }

  if (todayBar && todayBar.isToday) {
    if (todayBar.prevBar <= 0 && todayBar.bar > 0) {
      add('macd_flip_pos', 'good', 'MACD 柱翻红',
        `现价估算今日柱由 ${todayBar.prevBar.toFixed(3)} 转为 +${todayBar.bar.toFixed(3)}，金叉临近`);
    } else if (todayBar.prevBar >= 0 && todayBar.bar < 0) {
      add('macd_flip_neg', 'danger', 'MACD 柱翻绿',
        `现价估算今日柱由 +${todayBar.prevBar.toFixed(3)} 转为 ${todayBar.bar.toFixed(3)}，死叉临近`);
    }
    if (quote.prevClose) {
      const lim = +(quote.prevClose * 1.1).toFixed(3);
      const dn = +(quote.prevClose * 0.9).toFixed(3);
      if (quote.price >= lim - 0.001) add('limit_up', 'warn', '触及涨停', `现价 ${quote.price.toFixed(3)} 达涨停价 ${lim}，溢价可能进一步冲高`);
      if (quote.price <= dn + 0.001) add('limit_dn', 'good', '触及跌停', `现价 ${quote.price.toFixed(3)} 达跌停价 ${dn}，情绪极度悲观，留意折价机会`);
    }
  }

  const chg = quote.changePct;
  // 休市/周末时行情源返回的是上一交易日涨跌，措辞要标明日期，避免被当成今日盘中
  const liveToday = !(ctx.session && ctx.session.realtime === false);
  const chgTitle = liveToday ? '日内' : '上一交易日';
  const chgDay = liveToday ? '今日' : (quote.quoteDate || '上一交易日');
  if (isFinite(chg)) {
    if (chg >= 3) add('up3', 'warn', `${chgTitle}大涨`, `${chgDay}已涨 ${chg.toFixed(2)}%，注意溢价同步扩张与追高风险`);
    else if (chg >= 1.5) add('up15', 'info', `${chgTitle}走强`, `${chgDay}涨 ${chg.toFixed(2)}%`);
    if (chg <= -3) add('dn3', 'good', `${chgTitle}大跌`, `${chgDay}已跌 ${chg.toFixed(2)}%，若溢价同时收敛可留意分批机会`);
    else if (chg <= -1.5) add('dn15', 'info', `${chgTitle}走弱`, `${chgDay}跌 ${chg.toFixed(2)}%`);
  }

  // 接近最近买点
  const lastBuy = [...(signals || [])].reverse().find(s => s.side === 'buy');
  if (lastBuy && lastBuy.close > 0) {
    const dev = (quote.price / lastBuy.close - 1) * 100;
    if (Math.abs(dev) <= 1) {
      add('near_last_buy', 'good', '回踩最近买点',
        `现价距 ${lastBuy.date} 买点 ${lastBuy.close.toFixed(3)} 仅 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%`);
    }
  }

  const rank = { danger: 0, warn: 1, good: 2, info: 3 };
  out.sort((a, b) => ((a.pri ?? rank[a.level] ?? 9) - (b.pri ?? rank[b.level] ?? 9)));
  return out;
}

// 汇总市场数据（带缓存），建议/提示按请求实时计算
async function getEtfMarketData() {
  // 时钟口径的「交易时段」只用来决定缓存 TTL（节假日多拉几次无害，反而能在开盘瞬间拿到第一笔）
  const clockTrading = isAShareTradingTime();
  const ttl = clockTrading ? ETF_MKT_TTL_TRADING : ETF_MKT_TTL_IDLE;
  if (ETF_MKT_CACHE.data && Date.now() - ETF_MKT_CACHE.ts < ttl) return ETF_MKT_CACHE.data;

  const todayStr = bjDateStr();
  const [klines, quote, minute] = await Promise.all([
    fetchTencentEtfDayK(ETF_CODE, 1000).catch(() => []),
    fetchTencentEtfQuote(ETF_CODE).catch(() => null),
    fetchTencentEtfMinute(ETF_CODE).catch(() => null),
  ]);
  let navMap = {};
  try { navMap = await fetchEtfNavHistory(ETF_FUND_CODE); } catch { /* 净值缺失不阻断 */ }

  if (!klines.length) {
    if (ETF_MKT_CACHE.data) return ETF_MKT_CACHE.data;
    const disk = loadEtfDiskCache();
    if (disk) {
      // 用磁盘缓存顶住，同时把内存缓存时间戳清零 → 下次请求立即重试上游，自愈
      ETF_MKT_CACHE.data = disk;
      ETF_MKT_CACHE.ts = 0;
      console.warn('[etf-track] 上游日K不可用，使用磁盘缓存（' + disk.diskSavedAt + '）');
      return disk;
    }
    throw new Error('日K数据获取失败');
  }

  const closes = klines.map(k => k.close);
  const ma = {
    ma5: movingAvgSeries(closes, 5),
    ma10: movingAvgSeries(closes, 10),
    ma20: movingAvgSeries(closes, 20),
    ma21: movingAvgSeries(closes, 21),
    ma60: movingAvgSeries(closes, 60),
  };
  const { signals, bars, stats } = buildEtfSignals(klines);

  // 恐慌抄底信号：外盘情绪（纳指/费半）+ 极限超卖 + 溢价压缩 多条件共振
  //  先于清单与仓位建议计算，供两者共用同一份「恐慌窗口」判定
  // 美股指数（纳指/费半）：既作「恐慌抄底」的外盘输入，也作「美股趋势确认」的门控输入
  // （低溢价能不能抬仓、要不要把整体仓位压到 40% 以下，都看它）
  let usIdx = null;
  try { usIdx = await fetchUsIndexHistory(); } catch (e) { console.error('[us-index]', e.message); }

  let panicSignal = null;
  try {
    panicSignal = buildEtfPanicSignal(klines, navMap, usIdx);
  } catch (e) { console.error('[etf-panic]', e.message); }

  // 多指标组合信号（买卖信号清单 v6）：溢价为主 + 威廉%R/MA21/布林/MACD 共振，
  // 且美股未确认止跌时不给「重仓买入/买入/试仓」，统一降级为「等美股确认」
  let comboSignals = { signals: [], stats: null, backtest: null };
  try { comboSignals = buildEtfCompositeSignals(klines, navMap, panicSignal, usIdx); } catch (e) { console.error('[etf-combo]', e.message); }

  // 仓位建议：趋势定方向、溢价定仓位、美股趋势定「低溢价能不能抬仓」（盘中用实时价与实时溢价覆盖）
  let positionPlan = null;
  try {
    positionPlan = buildEtfPositionPlan(klines, navMap, (quote && quote.price > 0) ? {
      price: quote.price, premiumPct: quote.premiumPct, iopv: quote.iopv, date: todayStr,
    } : null, panicSignal, usIdx);
  } catch (e) { console.error('[etf-pos]', e.message); }

  // 买点确认用指标（威廉%R / RSI / 布林带）；仅作买点过滤与展示，不生成卖出信号
  const highs = klines.map(k => (isFinite(k.high) ? k.high : k.close));
  const lows = klines.map(k => (isFinite(k.low) ? k.low : k.close));
  const willR = williamsRSeries(highs, lows, closes, 14);
  const rsi14 = rsiSeries(closes, 14);
  const boll = bollingerSeries(closes, 20, 2);

  // 溢价率历史：日K收盘 ÷ 同日单位净值
  const premiumHist = [];
  for (const k of klines) {
    const nav = navMap[k.date];
    if (nav > 0) premiumHist.push({ date: k.date, premium: +((k.close / nav - 1) * 100).toFixed(2), close: k.close, nav });
  }
  const recent = premiumHist.slice(-250);   // 近 250 日用于分位统计
  const p20 = recent.slice(-20).map(x => x.premium);
  const premiumStats = p20.length ? {
    avg20: +(p20.reduce((s, v) => s + v, 0) / p20.length).toFixed(2),
    min20: +Math.min(...p20).toFixed(2),
    max20: +Math.max(...p20).toFixed(2),
    latest: recent[recent.length - 1] ? recent[recent.length - 1].premium : null,
  } : null;

  // 溢价率历史分布（近 250 个交易日），用于判断当前溢价在历史中的位置
  const sortedP = recent.map(x => x.premium).sort((a, b) => a - b);
  const qAt = q => sortedP.length ? +sortedP[Math.min(sortedP.length - 1, Math.max(0, Math.round(q * (sortedP.length - 1))))].toFixed(2) : null;
  const belowPct = t => sortedP.length ? +(sortedP.filter(v => v < t).length / sortedP.length * 100).toFixed(1) : null;
  const premiumDist = sortedP.length ? {
    days: sortedP.length,
    min: qAt(0), p10: qAt(0.1), p25: qAt(0.25), median: qAt(0.5), p75: qAt(0.75), max: qAt(1),
    belowBuy: belowPct(PREMIUM_BUY),      // 低于买入线的交易日占比
    belowAdd: belowPct(PREMIUM_ADD),      // 低于加仓线的交易日占比
    pctRank: belowPct(quote ? quote.premiumPct : sortedP[0]),  // 当前溢价的历史分位（越低越便宜）
  } : null;

  const lastIdx = klines.length - 1;
  const lastBar = bars[bars.length - 1] || {};
  const lastSignal = signals.length ? signals[signals.length - 1] : null;
  const realtime = !!(quote && quote.quoteDate === todayStr);
  // 「盘中」必须同时满足：A 股交易时段 + 行情源确实返回了今日数据。
  // 否则节假日的工作日（如 10/2 国庆）会被误判成盘中，用冻结行情算出假的「盘中柱」与穿越提示。
  const trading = clockTrading && realtime;
  const holidayClosed = clockTrading && !realtime;   // 工作日的节假日休市

  const high20 = Math.max(...closes.slice(-20));
  const low20 = Math.min(...closes.slice(-20));
  const rets = [];
  for (let i = Math.max(1, closes.length - 20); i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((s, v) => s + v, 0) / (rets.length || 1);
  const vol20 = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length || 1)) * Math.sqrt(252) * 100;

  ETF_KLINES = klines;

  const data = {
    code: ETF_CODE,
    fundCode: ETF_FUND_CODE,
    name: ETF_NAME,
    asOf: new Date().toISOString(),
    today: todayStr,
    session: { trading, realtime, holidayClosed, lastTradingDate: klines[lastIdx] ? klines[lastIdx].date : null },
    quote,
    klineLast: klines[lastIdx] || null,
    ind: {
      price: quote ? quote.price : (klines[lastIdx] ? klines[lastIdx].close : null),
      prevClose: quote ? quote.prevClose : null,
      ma5: ma.ma5[lastIdx], ma10: ma.ma10[lastIdx], ma20: ma.ma20[lastIdx],
      ma21: ma.ma21[lastIdx], ma60: ma.ma60[lastIdx],
      dif: lastBar.dif, dea: lastBar.dea, bar: lastBar.bar,
      // 买点确认辅助指标（仅用于「别在冲高中买入」，不用于卖出）
      willR: willR[lastIdx], rsi14: rsi14[lastIdx],
      bollMid: boll.mid[lastIdx], bollUp: boll.up[lastIdx], bollDn: boll.dn[lastIdx],
      high20, low20,
      drawdownFromHigh20: +(((closes[lastIdx] - high20) / high20) * 100).toFixed(2),
      vol20: +vol20.toFixed(1),
    },
    bars: bars.slice(-60).map(b => ({
      date: b.date, close: b.close, dif: b.dif, dea: b.dea, bar: b.bar,
      signal: b.signal || null, intraday: !!b.intraday,
    })),
    signals: signals.map(s => ({
      date: s.date, close: s.close, code: s.code, label: s.label, action: s.action,
      side: s.side, holdUntil: s.holdUntil, holdDays: s.holdDays,
      holdRetPct: s.holdRetPct, avoidPct: s.avoidPct, sinceRetPct: s.sinceRetPct,
    })),
    // 买卖信号清单 v3：溢价不再单独构成卖出理由（趋势先破坏才减仓），并附段内建议仓位
    comboSignals,
    // 仓位建议：趋势（MA21/MA60/MACD）定方向，溢价档位定仓位上限
    positionPlan,
    // 恐慌抄底：外盘重挫 + 极限超卖 + 溢价压缩 共振时的加仓窗口（含历史触发胜率）
    panicSignal,
    stats,
    premium: {
      current: quote ? quote.premiumPct : null,
      band: premiumZone(quote ? quote.premiumPct : null),
      iopv: quote ? quote.iopv : null,
      nav: quote ? quote.nav : null,
      history: premiumHist,          // 全历史（用于回溯；前端默认只画近 120 日）
      stats20: premiumStats,
      // 策略阈值（前端画档位条 / 挂单价用）
      rules: {
        add: PREMIUM_ADD, buy: PREMIUM_BUY, watch: PREMIUM_WATCH, danger: PREMIUM_DANGER,
        zones: PREMIUM_ZONES.map(z => ({
          key: z.key, level: z.level, label: z.label, note: z.note,
          lo: isFinite(z.lo) ? z.lo : null, hi: isFinite(z.hi) ? z.hi : null,
        })),
      },
      prices: quote ? premiumPriceLadder(quote.iopv) : null,
      // 溢价率历史分布（近 250 个交易日）
      dist: premiumDist,
    },
    intraday: minute,
    lastSignal,
    // 全历史回溯：最佳买卖点 + 策略对比
    review: (() => { try { return buildEtfHistoryReview(klines, navMap, signals); } catch (e) { console.error('[etf-review]', e.message); return null; } })(),
  };

  ETF_MKT_CACHE.data = data;
  ETF_MKT_CACHE.ts = Date.now();
  saveEtfDiskCache(data, klines);
  return data;
}

app.get('/api/etf-track', async (req, res) => {
  try {
    const data = await getEtfMarketData();
    const todayStr = bjDateStr();

    // 持仓（查询参数由前端从 localStorage 带入，仅用于生成建议，不落库）
    const cost = parseFloat(req.query.cost);
    const shares = parseFloat(req.query.shares);
    let pos = null;
    if (isFinite(cost) && isFinite(shares) && shares > 0) {
      const price = data.quote ? data.quote.price : data.ind.price;
      const marketValue = shares * price;
      const costValue = cost * shares;
      pos = {
        cost, shares, marketValue,
        costValue,
        pnl: marketValue - costValue,
        pnlPct: costValue > 0 ? (marketValue - costValue) / costValue * 100 : 0,
      };
    }

    // 盘中 MACD 柱估算（仅 A 股交易时段有意义）
    const todayBar = data.session.trading
      ? etfIntradayBar(ETF_KLINES, data.quote ? data.quote.price : null, todayStr)
      : null;

    // 盘中溢价穿越检测：对比上一次请求的溢价率，判断是否跌破买入线 / 加仓线
    const curPrem = data.quote ? data.quote.premiumPct : null;
    let premCross = null;
    if (isFinite(curPrem)) {
      if (ETF_PREM_PREV && isFinite(ETF_PREM_PREV.pct) && data.session.trading) {
        const lines = [PREMIUM_ADD, PREMIUM_BUY, PREMIUM_WATCH, PREMIUM_DANGER];
        const crossedDown = lines.filter(x => ETF_PREM_PREV.pct >= x && curPrem < x);
        const crossedUp = lines.filter(x => ETF_PREM_PREV.pct < x && curPrem >= x);
        if (crossedDown.length || crossedUp.length) {
          premCross = {
            from: ETF_PREM_PREV.pct, to: curPrem, crossedDown, crossedUp,
            at: new Date().toISOString(),
          };
        }
      }
      ETF_PREM_PREV = { pct: curPrem, ts: Date.now() };
    }

    const ctx = {
      quote: data.quote || {},
      ind: data.ind,
      lastSignal: data.lastSignal,
      signals: data.signals,
      pos,
      todayBar,
      premCross,
      session: data.session,
    };
    const advice = buildEtfAdvice(ctx);
    ctx.advice = advice;
    const alerts = buildEtfAlerts(ctx);

    const payload = { success: true, ...data, pos, advice, alerts, todayBar, premCross };
    if (req.query.diag === '1') {
      payload.diag = {
        klineCount: ETF_KLINES.length,
        navDates: Object.keys(ETF_NAV_CACHE.data || {}).length,
        premiumHistLen: data.premium.history.length,
        signalCount: data.signals.length,
        cachedAgoMs: Date.now() - ETF_MKT_CACHE.ts,
      };
    }
    res.json(payload);
  } catch (err) {
    console.error('[etf-track]', err.message);
    if (ETF_MKT_CACHE.data) return res.json({ success: true, ...ETF_MKT_CACHE.data, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  /api/fund-history — 基金近15/30/60天净值涨跌幅
//  数据来源：天天基金净值历史 API
// ═══════════════════════════════════════════════════════
const HISTORY_CACHE = new Map(); // code → { data, ts }
const HISTORY_TTL = 3600_000;   // 1小时缓存
const DRAWDOWN_CACHE = new Map(); // code → { data, ts }
const DRAWDOWN_TTL = 6 * 3600_000; // 6小时缓存

// 天天基金净值 API 每页最多 20 条，拉取多页合并
async function fetchFundNavPage(code, pageIndex) {
  const url =
    `https://api.fund.eastmoney.com/f10/lsjz` +
    `?callback=&fundCode=${code}&pageIndex=${pageIndex}&pageSize=20&startDate=&endDate=&_=${Date.now()}`;
  const text = await httpGet(url, {
    Referer: 'https://fund.eastmoney.com/',
    'Accept': 'application/json, text/javascript, */*',
  });
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  return (j && j.Data && j.Data.LSJZList) || [];
}

async function fetchFundNav(code) {
  // 拉取前4页（共80条记录，约60个交易日）
  const pages = await Promise.all([1, 2, 3, 4].map(p => fetchFundNavPage(code, p)));
  const all = pages.flat();
  if (all.length === 0) return null;
  // 按日期升序排列（最新在后）
  all.sort((a, b) => a.FSRQ < b.FSRQ ? -1 : 1);
  return all; // [{ FSRQ: '2025-01-01', DWJZ: '1.2345', ... }]
}

async function fetchFundNavYear(code) {
  // 拉取约一年净值数据（约250个交易日，每页20条需13页）
  const pages = await Promise.all(
    [1,2,3,4,5,6,7,8,9,10,11,12,13].map(p => fetchFundNavPage(code, p))
  );
  const all = pages.flat();
  if (all.length === 0) return null;
  all.sort((a, b) => a.FSRQ < b.FSRQ ? -1 : 1);
  return all;
}

function calcNavChg(list, days) {
  if (!list || list.length < 2) return null;
  const latest = list[list.length - 1];
  const latestNav = parseFloat(latest.DWJZ);
  if (isNaN(latestNav)) return null;

  // 找到 days 个交易日前的净值（往前找最近的那个）
  const latestDate = new Date(latest.FSRQ);
  // 按自然日往前推，不是交易日数——找列表里距今约 days 个自然日的最早点
  // 策略：在列表中找日期差 >= days 的最接近那条
  const targetDate = new Date(latestDate.getTime() - days * 24 * 3600 * 1000);
  // 找到第一条 FSRQ >= targetDate 的前一条，即距今 ~days 天的数据
  let prevNav = null;
  for (let i = 0; i < list.length - 1; i++) {
    const d = new Date(list[i].FSRQ);
    if (d >= targetDate) {
      // 用前一条（更早的）作为基准，若 i===0 则直接用它
      const baseIdx = i === 0 ? 0 : i;
      prevNav = parseFloat(list[baseIdx].DWJZ);
      break;
    }
  }
  if (prevNav === null) prevNav = parseFloat(list[0].DWJZ);
  if (isNaN(prevNav) || prevNav === 0) return null;
  return (latestNav - prevNav) / prevNav * 100;
}

function calcMaxDrawdown(list) {
  if (!list || list.length < 2) return null;
  const latest = new Date(list[list.length - 1].FSRQ);
  const oneYearAgo = new Date(latest.getTime() - 365 * 24 * 3600 * 1000);
  const yearList = list.filter(r => new Date(r.FSRQ) >= oneYearAgo);
  if (yearList.length < 2) return null;
  let peak = -Infinity, maxDD = 0;
  for (const r of yearList) {
    const nav = parseFloat(r.DWJZ);
    if (isNaN(nav)) continue;
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD < 0.01 ? null : -maxDD; // 返回负数如 -40.75
}

app.get('/api/fund-history', async (req, res) => {
  try {
    const results = await Promise.all(
      FUND_LIST.map(async ({ name, code }) => {
        const cached = HISTORY_CACHE.get(code);
        if (cached && Date.now() - cached.ts < HISTORY_TTL) {
          return cached.data;
        }
        try {
          const list = await fetchFundNav(code);
          const d15  = calcNavChg(list, 15);
          const d30  = calcNavChg(list, 30);
          const d60  = calcNavChg(list, 60);
          // 计算近一年最大回撤（独立缓存，TTL 6小时）
          const cachedDD = DRAWDOWN_CACHE.get(code);
          let maxDD;
          if (cachedDD && Date.now() - cachedDD.ts < DRAWDOWN_TTL) {
            maxDD = cachedDD.data;
          } else {
            const yearList = await fetchFundNavYear(code);
            maxDD = calcMaxDrawdown(yearList);
            DRAWDOWN_CACHE.set(code, { data: maxDD, ts: Date.now() });
          }
          const item = { code, name, d15, d30, d60, maxDD };
          HISTORY_CACHE.set(code, { data: item, ts: Date.now() });
          return item;
        } catch (e) {
          console.error(`[fund-history] ${code}`, e.message);
          return { code, name, d15: null, d30: null, d60: null, maxDD: null };
        }
      })
    );
    res.json({ success: true, data: results });
  } catch (err) {
    console.error('[fund-history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  Keep-alive: self-ping every 5 minutes to prevent sleep
// ═══════════════════════════════════════════════════════
function startKeepAlive(port) {
  const selfUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://fund-valuation-m37d.onrender.com';
  const INTERVAL = 5 * 60 * 1000; // 5 minutes

  setInterval(() => {
    const url = selfUrl.startsWith('https') ? selfUrl : selfUrl;
    const mod = selfUrl.startsWith('https') ? https : http;
    const req = mod.get(selfUrl + '/', (res) => {
      console.log(`[keep-alive] ping ${selfUrl} → ${res.statusCode}`);
    });
    req.on('error', (err) => {
      console.warn(`[keep-alive] ping failed: ${err.message}`);
    });
    req.end();
  }, INTERVAL);

  console.log(`[keep-alive] 每5分钟自动访问 ${selfUrl}`);
}

// ═══════════════════════════════════════════════════════
//  Startup
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`美股基金估值服务已启动 → http://localhost:${PORT}`);
  // Warm fund cache in background
  loadHoldingsFromFile();
  // Self-ping to prevent server sleep
  startKeepAlive(PORT);
});
