const express = require('express');
const compression = require('compression');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ 带宽优化：gzip 压缩 + 静态资源强缓存 ═══
app.use(compression({
  level: 6,                    // 压缩等级 6 (速度与压缩率平衡)
  threshold: 1024,             // 仅压缩 >1KB 的响应
  filter: (req, res) => {
    // API 响应和 HTML 都压缩；图片等已是压缩格式则跳过
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// 静态资源强缓存 1 天（HTML/JS/CSS 内容变化不频繁）
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML 每次校验（配 etag 命中就走 304），避免改了前端却仍加载旧页面
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// 轻量健康检查端点（keep-alive 专用，< 100 bytes）
app.get('/api/health', (req, res) => {
  res.json({ ok: 1 });
});

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
  // 基金列表变化不频繁，允许浏览器/中间缓存 5 分钟
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ success: true, funds: fundsCache, loadedAt: fundsCacheTs });
});

// ═══════════════════════════════════════════════════════
//  Sina quotes proxy (real-time prices)
// ═══════════════════════════════════════════════════════
const quoteCache = new Map();
const QUOTE_TTL = 4 * 1000;
const closedQuoteCache = new Map();
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
  if (symbol === 'SSE') return 'sh000001';
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
function yahooExtendedTick(result) {
  const times = result?.timestamp || [], closes = result?.indicators?.quote?.[0]?.close || [];
  for (let i = times.length - 1; i >= 0; i--) {
    if (Number.isFinite(closes[i]) && closes[i] > 0 && times[i] > result.meta.regularMarketTime) {
      return { extendedPrice: closes[i], extendedTime: times[i] };
    }
  }
  return { extendedPrice: null, extendedTime: null };
}

async function fetchYahooFulldayOne(symbol) {
  const cached = yahooExtCache.get(symbol);
  if (cached) {
    // hardUntil: 整链路失败的硬退避截止时间，期间直接返回缓存(null)，不再重试
    if (cached.hardUntil && Date.now() < cached.hardUntil) return cached.data;
    if (Date.now() - cached.ts < YAHOO_EXT_TTL) return cached.data;
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1m&range=1d&includePrePost=true`;
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
          extendedPrice: j.extendedPrice,
          extendedTime: j.extendedTime,
          stale: !!j.stale,
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
    ...yahooExtendedTick(result),
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
    if (c && c.data && Date.now() - c.ts < YAHOO_EXT_TTL) map.set(s, c.data);
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
// 雪球夜盘推送是 ~20 分钟一批刷新 timestampNight（实测 08:10→08:30 批次），
// ETF 若只容忍 5 分钟新鲜度，会在大部分时间里被误判过期而退到期货 β 估算
// （实测偏差：QQQ 期货 -0.32% vs 雪球真实 -0.21%，SPY +0.08% vs +0.20%）。
// 「最近成交价」即使滞后 20+ 分钟也远比期货估算接近真实盘口，且前端已有
// 「数据时间 X 分钟前」标注兜底；无期货映射的 ETF（IWM/SMH 等）更是只有雪球这一条路。
const XUEQIU_ETF_MAX_LAG_MS = 30 * 60_000;

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
    timestampExt: j.timestampExt,
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
    const sourceTimeMs = Date.parse(`${f[12]}T${f[6]}+08:00`);
    map[sym] = { price, prevSettle, chgPct, time: f[6] || '', sourceTimeMs: Number.isFinite(sourceTimeMs) ? sourceTimeMs : null };
  }
  SINA_FUTURES_CACHE.set(cacheKey, { data: map, ts: now });
  recordFuturesHist(map);
  return map;
}

function usMarketClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const localMs = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  return { localMs, offsetMs: localMs - Math.floor(now.getTime() / 1000) * 1000,
    day: new Date(localMs).getUTCDay(), minute: fields.hour * 60 + fields.minute };
}

function getUSMarketState(now = new Date()) {
  const { day, minute } = usMarketClock(now);
  if (day === 6 || (day === 0 && minute < 1200) || (day === 5 && minute >= 1200)) return 'CLOSED';
  if (day === 0 || minute < 240 || minute >= 1200) return 'OVERNIGHT';
  if (minute < 570) return 'PRE';
  if (minute < 960) return 'REGULAR';
  return 'POST';
}

function usOvernightSessionStart(now = new Date()) {
  const { localMs, offsetMs, minute } = usMarketClock(now);
  const midnightUtc = Math.floor(localMs / 86400_000) * 86400_000 - offsetMs;
  return midnightUtc + (minute < 1200 ? -240 : 1200) * 60000;
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

function marketPhase(marketKey) {
  const key = typeof marketKey === 'number' ? 'KR' : marketKey;   // 数字偏移 = 腾讯韩股通道
  const sessions = MARKET_SESSIONS[key];
  if (!sessions) return null;
  const { day, min } = marketClock(MARKET_TZ_OFFSET[key]);
  if (day === 0 || day === 6) return 'HOLIDAY';
  const firstOpen = Math.min(...sessions.map(([a]) => a));
  const lastClose = Math.max(...sessions.map(([, b]) => b));
  if (min < firstOpen) return 'PRE';
  if (min >= lastClose) return 'POST';
  return sessions.some(([a, b]) => min >= a && min < b) ? 'REGULAR' : 'REGULAR';
}

// 该市场此刻是否在交易中：'REGULAR' / 'CLOSED'；未知市场返回 null（不覆盖原值）
function marketSessionState(marketKey) {
  const phase = marketPhase(marketKey);
  if (!phase) return null;
  return phase === 'REGULAR' ? 'REGULAR' : 'CLOSED';
}

function quoteMarketKey(symbol) {
  if (isKoreanSymbol(symbol)) return 'KR';
  if (isTaiwanSymbol(symbol)) return 'TW';
  if (isJapanSymbol(symbol)) return 'JP';
  if (HK_STOCKS_SET.has(symbol) || /^\d{4,5}$/.test(symbol)) return 'HK';
  if (symbol === 'SSE' || /^\d{6}$/.test(symbol)) return 'CN';
  return null;
}

function closedQuoteCacheKey(symbol, quote) {
  if (!quote || !quote.sessionDate || quote.marketState === 'REGULAR') return null;
  const mk = quoteMarketKey(symbol);
  if (!mk || marketSessionState(mk) === 'REGULAR') return null;
  return `${symbol}:${quote.sessionDate}:${quote.marketState}`;
}

function closedQuoteCacheValidForToday(entry, marketKey) {
  if (!entry || !entry.quote || !entry.quote.sessionDate) return false;
  const key = typeof marketKey === 'number' ? 'KR' : marketKey;
  return entry.marketDate === marketToday(MARKET_TZ_OFFSET[key]) && entry.phase === marketPhase(key);
}

function getClosedCachedQuote(symbol) {
  const mk = quoteMarketKey(symbol);
  if (!mk || marketSessionState(mk) === 'REGULAR') return null;
  const entry = closedQuoteCache.get(symbol);
  if (!closedQuoteCacheValidForToday(entry, mk)) {
    closedQuoteCache.delete(symbol);
    return null;
  }
  return entry.quote;
}

function rememberClosedQuote(quote) {
  const mk = quoteMarketKey(quote.symbol);
  const key = closedQuoteCacheKey(quote.symbol, quote);
  if (!key || !mk) return;
  const prev = closedQuoteCache.get(quote.symbol);
  if (prev && prev.key === key) return;
  closedQuoteCache.set(quote.symbol, { key, quote, marketDate: marketToday(MARKET_TZ_OFFSET[mk]), phase: marketPhase(mk) });
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
  IWM:  '107.IWM',             // 罗素2000 ETF（NYSE Arca→107）
  SMH:  '105.SMH',             // 半导体 ETF（NASDAQ→105）
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
      const symbol = id === 'sh000001' && symMap.has('SSE') ? symMap.get('SSE') : symMap.get(ticker) || ticker;
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
        sourceTimeMs: Date.parse(`${fields[30]}T${fields[31]}+08:00`),
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
// IWM 也纳入：罗素夜盘在雪球同样是一批一批推，锚点常年滞后 1 小时，
// 有期货代理才能用增量修正（此前它只能卡在「旧成交 + 滞后」状态）。
const FUTURES_PROXY = { QQQ: 'NQ', IXIC: 'NQ', SPY: 'ES', IWM: 'ES' };

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
//  Alpaca 夜盘（Blue Ocean ATS）直连
//
//  20:00–04:00 ET 的成交只发生在 Blue Ocean / Bruce / MOON 这几个 ATS，
//  交易所和 Yahoo/CNBC/TradingView 的「盘后」都到 20:00 为止。国内只有雪球
//  转售这批数据，且约 20 分钟一批；要拿到分钟级真实成交只能自己接 ATS 源。
//  Alpaca 免费套餐即提供 feed=overnight（BOATS 实时指示报价 + 15 分钟延迟成交），
//  是唯一零成本的自助入口。key 放环境变量或 data/alpaca.json，没配就静默跳过。
// ─────────────────────────────────────────────────────────────
const ALPACA_DATA = 'https://data.alpaca.markets';
let _alpacaCfg;
function alpacaConfig() {
  if (_alpacaCfg !== undefined) return _alpacaCfg;
  let id = (process.env.ALPACA_KEY_ID || '').trim();
  let secret = (process.env.ALPACA_SECRET_KEY || '').trim();
  if (!id || !secret) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'alpaca.json'), 'utf8'));
      id = String(j.keyId || j.key || '').trim();
      secret = String(j.secretKey || j.secret || '').trim();
    } catch { /* 未配置 */ }
  }
  _alpacaCfg = id && secret ? { id, secret } : null;
  if (_alpacaCfg) console.log('[alpaca] 夜盘 ATS 数据源已启用');
  return _alpacaCfg;
}
const ALPACA_OVERNIGHT_CACHE = new Map();   // symbols → { ts, map }
const ALPACA_TTL_MS = 10_000;
// 返回 Map<symbol, { price, at, bid, ask }>。取买卖中价当「当前夜盘价」：
// 免费套餐的 quote 是实时指示价，成交要延迟 15 分钟，用成交价会倒退。
async function fetchAlpacaOvernight(symbols) {
  const cfg = alpacaConfig();
  if (!cfg || !symbols || !symbols.length) return new Map();
  const key = symbols.join(',');
  const hit = ALPACA_OVERNIGHT_CACHE.get(key);
  if (hit && Date.now() - hit.ts < ALPACA_TTL_MS) return hit.map;
  try {
    const url = `${ALPACA_DATA}/v2/stocks/snapshots?symbols=${encodeURIComponent(key)}&feed=overnight`;
    const r = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': cfg.id, 'APCA-API-SECRET-KEY': cfg.secret },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`alpaca ${r.status} ${(await r.text()).slice(0, 120)}`);
    const body = await r.json();
    const src = body.snapshots || body;
    const map = new Map();
    for (const [sym, s] of Object.entries(src || {})) {
      const q = s && s.latestQuote;
      const bid = Number(q && q.bp), ask = Number(q && q.ap);
      const trade = Number(s && s.latestTrade && s.latestTrade.p);
      const barClose = Number(s && s.minuteBar && s.minuteBar.c);
      let price = null;
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        // 买卖价差过大（清淡时段个别报价跳空）时退到成交价，避免中价失真
        const mid = (bid + ask) / 2;
        price = (ask - bid) / mid > 0.01 && Number.isFinite(trade) && trade > 0 ? trade : mid;
      } else if (Number.isFinite(trade) && trade > 0) price = trade;
      else if (Number.isFinite(barClose) && barClose > 0) price = barClose;
      if (!(price > 0)) continue;
      const ts = Date.parse((q && q.t) || (s.latestTrade && s.latestTrade.t) || '');
      map.set(sym, { price, at: Number.isFinite(ts) ? ts : null, bid, ask });
    }
    ALPACA_OVERNIGHT_CACHE.set(key, { ts: Date.now(), map });
    return map;
  } catch (e) {
    console.error('[alpaca]', e.message);
    ALPACA_OVERNIGHT_CACHE.set(key, { ts: Date.now(), map: new Map() });
    return new Map();
  }
}

// ─────────────────────────────────────────────────────────────
//  夜盘涨跌幅统一计算 —— eastmoney 主源路径 与 新浪兜底路径 共用
//
//  口径：以「正股收盘价」为基准（富途/长桥/雪球 percent_night_session 同款）。
//        切勿再用「昨收」做基准，否则会把正股当日涨跌叠加进来，数值系统性偏大。
//  本轮真实报价择新，过期后回退有时效校验的期货估算或标记旧成交
//  返回 { overnightChangePercent, overnightPrice, overnightSource,
//         overnightEstimated, overnightAsOf }
// ─────────────────────────────────────────────────────────────
function computeOvernightQuote({
  symbol,
  closeForOvernight,
  sina,
  yahoo,
  xq,
  alpaca,
  etfFut,
  overnightSessionStart,
  esDelta,
  nqDelta,
}) {
  const now = Date.now();
  const isEtf = !!FUTURES_PROXY[symbol];
  const maxLag = isEtf ? XUEQIU_ETF_MAX_LAG_MS : 30 * 60_000;
  const inSession = at => Number.isFinite(at) && at >= overnightSessionStart && at <= now + 5000;
  const candidates = [];
  const add = (source, price, at, percent) => {
    if (!(Number.isFinite(price) && price > 0 && closeForOvernight > 0 && inSession(at))) return;
    candidates.push({ source, price, at, chg: Number.isFinite(percent) ? percent : (price / closeForOvernight - 1) * 100 });
  };
  // ATS 直连（Alpaca/BOATS）是唯一的一手成交，排在最前：它是真实报价，
  // 不需要漂移修正。没配 key 时 alpaca 为 undefined，行为与之前完全一致。
  add('alpaca', alpaca?.price, alpaca?.at);
  add('xueqiu', xq?.currentNight, xq?.timestampNight, xq?.percentNight);
  add('xueqiu-ext', xq?.currentExt, xq?.timestampExt, xq?.percentExt);
  // 只采信分钟价与其配对时间，不能把不带时间的 fulldayPrice 与日K时间拼接。
  const yahooAt = Number.isFinite(yahoo?.extendedTime) ? yahoo.extendedTime * 1000 : null;
  if (!yahoo?.stale) add('yahoo', yahoo?.extendedPrice, yahooAt);
  candidates.sort((a, b) => b.at - a.at);
  const latest = candidates[0];
  let selected = latest && now - latest.at <= maxLag ? latest : null;
  let stale = false;
  // 雪球夜盘 ~20 分钟一批推送，锚点成交价会滞后于真实盘口；
  // 用「锚点之后的期货增量」修正（QQQ/SPY 与 NQ/ES β≈1；增量口径自洽）。
  // 增量必须用期货「价格比」算：新浪 hf_NQ 的 chgPct 以昨结算为基准，而昨结算
  // 在 17:00 ET 结算后会滚动到当日结算，chgPct 会整体跳一个当日涨跌幅
  // （11-11 实测：NQ 真实 -0.59%，新浪 chgPct 只有 +0.02%）。
  // 价格比与基准无关，任何时候都成立。
  const futSym = isEtf ? FUTURES_PROXY[symbol] : null;
  if (latest && futSym && etfFut && inSession(etfFut.sourceTimeMs)
    && now - etfFut.sourceTimeMs <= XUEQIU_ETF_MAX_LAG_MS
    && now - latest.at > DRIFT_MIN_MS && now - latest.at <= DRIFT_ANCHOR_MAX_MS) {
    // 锚点即使超出常规采信窗（30 分钟）也优先「锚定 + 漂移」，
    // 因为退回纯期货估算要把基准从收盘换成结算，误差比漂移大得多。
    const delta = futuresDeltaSince(futSym, latest.at, etfFut.price);
    if (delta != null) {
      const chg = latest.chg + delta;
      selected = { source: 'xueqiu-drift', chg,
        price: closeForOvernight > 0 ? closeForOvernight * (1 + chg / 100) : null, at: now };
      stale = false;
    }
  }
  // 纯期货估算：基准必须是「20:00 ET 盘后收盘价 + 期货自 20:00 起的增量」。
  // 旧写法直接把期货相对结算的 chgPct 套在正股收盘价上，等于把收盘前
  // 16:00–20:00 那段盘后波动重复加了一次（11-11 实测偏 0.6pp、符号都能错）。
  if (!selected && etfFut && futSym && inSession(etfFut.sourceTimeMs)
    && now - etfFut.sourceTimeMs <= XUEQIU_ETF_MAX_LAG_MS) {
    const delta = futuresDeltaSince(futSym, overnightSessionStart, etfFut.price);
    const post20 = sina?.postMarketChangePercent;
    if (delta != null && Number.isFinite(post20)) {
      const chg = post20 + delta;
      selected = { source: 'futures', chg,
        price: closeForOvernight > 0 ? closeForOvernight * (1 + chg / 100) : null, at: etfFut.sourceTimeMs };
    }
  }
  if (!selected && latest) { selected = latest; stale = true; }
  if (!selected && !isEtf) {
    const post20 = sina?.postMarketChangePercent ?? 0;
    const { beta, futSym } = stockFuturesProxy(symbol);
    const delta = futSym === 'ES' ? esDelta : nqDelta;
    const extra = Number.isFinite(delta) ? beta * delta : 0;
    const chg = post20 + extra;
    selected = { source: 'proxy', chg, price: closeForOvernight > 0 ? closeForOvernight * (1 + chg / 100) : null, at: null };
    stale = !Number.isFinite(delta);
  }
  const { source, price, chg, at } = selected || { source: 'unavailable', price: null, chg: null, at: null };
  return {
    overnightChangePercent: chg,
    overnightPrice: price,
    overnightSource: source,
    overnightEstimated: source === 'futures' || source === 'proxy' || source === 'xueqiu-drift',
    overnightStale: stale || source === 'unavailable',
    overnightAsOf: at,
    overnightLagMin: at != null ? Math.max(0, Math.floor((now - at) / 60000)) : null,
  };
}

// ── 期货历史快照（雪球锚点漂移用）──
// 雪球夜盘 timestampNight 是 ~20 分钟一批推送，批次间隔内夜盘价在动；
// 每次取到新浪期货报价都记录 {报价时间, 成交价}，漂移时取锚点时刻的报价算
// 价格比增量。存价格而不是 chgPct：新浪 chgPct 的基准（昨结算）会在 17:00 ET
// 结算后滚动，跨该时点做差会凭空多出/少掉一个当日涨跌幅。
const SINA_FUTURES_HIST = new Map();   // sym → [{ ts, price }]（ts = 新浪报价时间）
// 锚点滞后超过 90 秒即启用漂移修正。此前 5 分钟门槛导致雪球批次之间（约每 20 分钟
// 一批）有长达 5 分钟的"冻结窗口"：读数一动不动而真实夜盘在走，用户看到明显漂移。
// 90 秒内锚点本身是真实成交价，比期货增量更准；超过后用期货增量连续修正。
const DRIFT_MIN_MS = 90 * 1000;
// 漂移最多能拉多久：雪球在夜盘清淡时段会 1 小时才推一批（11-11 实测 QQQ 滞后 59 分），
// 30 分钟采信窗会把这类锚点整批丢掉、退回纯期货。给到 3 小时，用期货增量兜住。
const DRIFT_ANCHOR_MAX_MS = 3 * 60 * 60_000;
// 期货历史要覆盖整轮夜盘（20:00–04:00 ET），否则「自 20:00 起的增量」没有基点。
// 一分钟一条（4→8 小时约 480 条/标的），避免 5 秒一条把落盘文件撑到几 MB。
const FUT_HIST_TTL_MS = 8 * 60 * 60_000;
const FUT_HIST_MIN_GAP_MS = 60_000;
// 历史快照持久化：内存历史在重启后清零，重启前的雪球锚点（最多 20 分钟一批）
// 找不到基点就会退回"整批冻结"，这是漂移修正失效的主要场景。落盘后重启可续。
const FUT_HIST_FILE = path.join(__dirname, 'data', 'futures-hist.json');
function loadFuturesHist() {
  try {
    const j = JSON.parse(fs.readFileSync(FUT_HIST_FILE, 'utf8'));
    const cutoff = Date.now() - FUT_HIST_TTL_MS;
    for (const [sym, arr] of Object.entries(j || {})) {
      if (!Array.isArray(arr)) continue;
      // 旧格式只有 chgPct，无法做价格比，直接丢弃（一分钟内会重新攒够）
      const clean = arr.filter(e => e && Number.isFinite(e.ts) && Number.isFinite(e.price) && e.price > 0 && e.ts >= cutoff);
      if (clean.length) SINA_FUTURES_HIST.set(sym, clean);
    }
  } catch { /* 首次运行无文件 */ }
}
let _futHistLastSave = 0;
function saveFuturesHist(force) {
  try {
    if (!force && Date.now() - _futHistLastSave < 60_000) return;   // 最多 1 分钟写一次
    _futHistLastSave = Date.now();
    fs.mkdirSync(path.dirname(FUT_HIST_FILE), { recursive: true });
    const obj = {};
    for (const [sym, arr] of SINA_FUTURES_HIST) if (arr.length) obj[sym] = arr;
    fs.writeFileSync(FUT_HIST_FILE, JSON.stringify(obj));
  } catch { /* 忽略 */ }
}
function recordFuturesHist(map) {
  const now = Date.now();
  for (const [sym, f] of Object.entries(map || {})) {
    if (!f || !Number.isFinite(f.price) || f.price <= 0) continue;
    const arr = SINA_FUTURES_HIST.get(sym) || [];
    const ts = Number.isFinite(f.sourceTimeMs) ? f.sourceTimeMs : now;
    const last = arr[arr.length - 1];
    // 降采样到 60 秒一条，间隔内直接丢弃（不覆盖最后一条）。
    // 这里曾经写成「间隔不足就替换最后一条」，而新浪期货每 5 秒刷新一次报价，
    // 于是历史永远只剩 1 条当前报价（11-12 实测 data/futures-hist.json 里
    // NQ/ES 各 1 条、ts 就是当下）。futuresDeltaSince 找不到早于锚点的基点，
    // 退化成 hist[0] 即当前价，增量恒为 0 —— 漂移表面在跑，实际等于没做，
    // 页面上永远是十几分钟前那批雪球价。保留更早的采样才有基点。
    if (!last || ts - last.ts >= FUT_HIST_MIN_GAP_MS) arr.push({ ts, price: f.price });
    while (arr.length && now - arr[0].ts > FUT_HIST_TTL_MS) arr.shift();
    SINA_FUTURES_HIST.set(sym, arr);
  }
  saveFuturesHist();
}
// 期货自 sinceMs 以来的涨跌幅（百分比，按价格比）。用价格比而非 chgPct 差值：
// 新浪的昨结算会在 17:00 ET 结算后滚动，跨该时点做差会带进一个当日涨跌幅。
// nowPrice 传入当前报价（本轮 fetch 的实时值），缺省退回历史最后一条。
function futuresDeltaSince(sym, sinceMs, nowPrice) {
  if (!sym || !Number.isFinite(sinceMs)) return null;
  const hist = SINA_FUTURES_HIST.get(sym) || [];
  if (!hist.length) return null;
  let anchor = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].ts <= sinceMs) { anchor = hist[i]; break; }
  }
  // 重启兜底：历史都晚于基准时间（如停机后重启、历史被裁到 8 小时内）时用最早一条，
  // 误差只剩「基准时刻→最早历史」那段空档的期货波动，远小于放任锚点整批冻结。
  if (!anchor) anchor = hist[0];
  if (!anchor || !(anchor.price > 0)) return null;
  const last = Number.isFinite(nowPrice) && nowPrice > 0 ? nowPrice : hist[hist.length - 1].price;
  if (!(last > 0)) return null;
  return (last / anchor.price - 1) * 100;
}
loadFuturesHist();
// 用新浪自己的期货分钟线补齐历史基点（同源，不会把两家报价差当成波动）。
// 本地采样只能攒「进程活着」那段时间，重启后最早一条就是当下，于是
// 「自 20:00 起的增量」和「锚点前的基点」都缺，漂移要么为 0、要么退化成
// 纯期货估算。分钟线一次能拿到整轮夜盘（北京 07:00 = ET 18:00 期货开盘），
// 重启后 1 秒内就能接着漂。合并按分钟去重，本地实时采样优先。
const SINA_FUT_MINLINE = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{sym}=/GlobalFuturesService.getGlobalFuturesMinLine?symbol={sym}';
let _futSeedAt = 0;
async function seedFuturesHist(force) {
  const now = Date.now();
  if (!force && now - _futSeedAt < 30 * 60_000) return;
  _futSeedAt = now;
  const cutoff = now - FUT_HIST_TTL_MS;
  for (const sym of ['NQ', 'ES', 'YM']) {
    const arr = SINA_FUTURES_HIST.get(sym) || [];
    // 已有覆盖面（最早一条早于 20 分钟前、最后一条是 5 分钟内）就不用重复拉
    if (!force && arr.length && arr[0].ts <= now - 20 * 60_000 && arr[arr.length - 1].ts >= now - 5 * 60_000) continue;
    try {
      const r = await fetch(SINA_FUT_MINLINE.replace(/\{sym\}/g, sym), {
        headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const txt = await r.text();
      const i = txt.indexOf('('), j = txt.lastIndexOf(')');
      if (i < 0 || j <= i) continue;
      const rows = (JSON.parse(txt.slice(i + 1, j)) || {}).minLine_1d || [];
      const pts = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        // 首行 10 列、后续 6 列，价格都紧跟在 "HH:MM" 之后，时间取末尾的 datetime
        const ti = row.findIndex(v => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v));
        const dt = row[row.length - 1];
        if (ti < 0 || typeof dt !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dt)) continue;
        const price = parseFloat(row[ti + 1]);
        const ts = Date.parse(dt.replace(' ', 'T') + '+08:00');
        if (Number.isFinite(ts) && Number.isFinite(price) && price > 0 && ts >= cutoff) pts.push({ ts, price });
      }
      if (!pts.length) continue;
      const byMin = new Map(arr.map(e => [Math.floor(e.ts / 60_000), e]));
      for (const p of pts) {
        const k = Math.floor(p.ts / 60_000);
        if (!byMin.has(k)) byMin.set(k, p);
      }
      const merged = [...byMin.values()].sort((a, b) => a.ts - b.ts);
      SINA_FUTURES_HIST.set(sym, merged);
    } catch { /* 网络失败不影响主流程，本地采样继续 */ }
  }
  saveFuturesHist(true);
}

app.get('/api/quotes', async (req, res) => {
  const diag = req.query.diag === '1';
  const raw = (req.query.symbols || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols required' });
  const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const cacheKey = [...symbols].sort().join(',');
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.usState === getUSMarketState() && Date.now() - cached.ts < QUOTE_TTL) {
    return res.json({ success: true, data: cached.data, cached: true });
  }

  const closedCachedData = [];
  const liveSymbols = [];
  for (const s of symbols) {
    const q = getClosedCachedQuote(s);
    if (q) closedCachedData.push(q);
    else liveSymbols.push(s);
  }
  if (liveSymbols.length === 0 && closedCachedData.length) {
    return res.json({ success: true, data: closedCachedData, cached: true, closedCached: true });
  }

  // Route each symbol: eastmoney(US) → Naver(KR) → TWSE(TW) → Tencent(JP) → Yahoo(SG) → Sina(forex/HK/A股/兜底)
  const krSymbols   = liveSymbols.filter((s) =>  isKoreanSymbol(s));
  const twSymbols   = liveSymbols.filter((s) => !isKoreanSymbol(s) && isTaiwanSymbol(s));
  const jpSymbols   = liveSymbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && isJapanSymbol(s));
  const yhSymbols   = liveSymbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isJapanSymbol(s) && isYahooSymbol(s));
  const emSymbols   = liveSymbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isJapanSymbol(s) && !isYahooSymbol(s) && emSecid(s));
  const sinaSymbols = liveSymbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isJapanSymbol(s) && !isYahooSymbol(s) && !emSecid(s));
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

    const [emData, sinaData, krData, twData, jpData, yhData, yhExtData, futuresData, xueqiuData, alpacaData] = await Promise.all([
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
      // 夜盘时段：Blue Ocean ATS 直连（Alpaca），有 key 才有值
      usState === 'OVERNIGHT' && emSymbols.length
        ? fetchAlpacaOvernight(emSymbols).catch(() => new Map())
        : Promise.resolve(new Map()),
    ]);

    // Merge: for symbols that have both eastmoney and sina data,
    // use eastmoney as base but overlay sina data by session:
    // PRE: sina fields[5] 是盘前实时价，EM f2 盘前返回昨收，需用新浪覆盖
    // POST/CLOSED: EM f2 是盘后实时价，比新浪更新更快，优先用 EM
    // （FUTURES_PROXY / STOCK_BETA / stockFuturesProxy 已提到模块作用域，见文件上方）
    const sinaMap = (sinaData && sinaData.map) || {};
    // 本轮夜盘起点 + 雪球夜盘覆盖情况（判定逻辑详见 usOvernightSessionStart 说明）
    const overnightSessionStart = usOvernightSessionStart();
    // 期货相对 20:00 ET 的增量（个股 β 代理用），按价格比算。
    // 旧写法 `nqNow(chgPct) - QQQ.postMarketChangePercent` 把「期货相对昨结算」
    // 和「ETF 相对收盘」两个不同基准相减，结果没有任何意义。
    let nqDelta = null;  // percent, 20:00 之后 NQ 的增量
    let esDelta = null;  // percent, 20:00 之后 ES 的增量
    if (usState === 'OVERNIGHT') {
      nqDelta = futuresDeltaSince('NQ', overnightSessionStart, futuresData?.NQ?.price);
      esDelta = futuresDeltaSince('ES', overnightSessionStart, futuresData?.ES?.price);
    }
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
            alpaca: alpacaData && alpacaData.get(em.symbol),
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
          if (yhPre && yhPre.fulldayPrice > 0 && yhPre.regularMarketPrice > 0) {
            const preChange = (yhPre.fulldayPrice / yhPre.regularMarketPrice - 1) * 100;
            return {
              ...em,
              regularMarketPrice: yhPre.fulldayPrice,
              regularMarketChangePercent: preChange,
              preMarketChangePercent: preChange,
              closePrice: yhPre.regularMarketPrice,
              regularMarketPreviousClose: yhPre.regularMarketPrice,
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
            alpaca: alpacaData && alpacaData.get(q.symbol),
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
      ...closedCachedData,
      ...mergedEmData,
      ...puresinaData.map(attachIntlYday),
      ...krData.map(attachIntlYday),
      ...twData.map(attachIntlYday),
      ...jpData.map(attachIntlYday),
      ...yhData,
    ];
    for (const q of data) rememberClosedQuote(q);
    if (data.length === 0) throw new Error('No quotes returned');
    quoteCache.set(cacheKey, { data, ts: Date.now(), usState });
    if (diag) {
      // 诊断模式：GET /api/quotes?symbols=SNDK&diag=1
      // 用于确认各上游数据源谁真正返回了数据（例如 eastmoney 是否可达）
      return res.json({
        success: true,
        data,
        diag: {
          usState,
          closedCacheHit: closedCachedData.length,
          liveRequested: liveSymbols.length,
          eastmoneyRequested: emSymbols.length,
          eastmoneyReturned: Object.keys(emMap).length,
          sinaRequested: sinaAll.length,
          yahooExtCount: yhExtData ? yhExtData.size : 0,
          xueqiuCount: xueqiuData ? xueqiuData.size : 0,
          alpacaCount: alpacaData ? alpacaData.size : 0,
          alpacaEnabled: !!alpacaConfig(),
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
  if (!d || (d.currentNight == null && d.currentExt == null)) return res.status(404).json({ error: 'no night data' });
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
      `?interval=1m&range=1d&includePrePost=true`;
    const text = await httpGetWithStatus(url, { Accept: 'application/json' });
    const j = JSON.parse(text);
    const result = j && j.chart && j.chart.result && j.chart.result[0];
    const meta = result && result.meta;
    if (!meta) return res.status(502).json({ error: 'empty result' });
    if (!meta.hasPrePostMarketData) {
      const out = { symbol, noPrePost: true };
      FULLDAY_API_CACHE.set(symbol, { data: out, ts: Date.now() });
      return res.json(out);
    }
    const out = {
      symbol,
      fulldayPrice: meta.fulldayPrice,
      ...yahooExtendedTick(result),
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
  // 边界为有意非对称：早盘含 11:30（690 是早盘最后一分钟），尾盘不含 15:00
  // （900 起即收盘，isAShareTradingTime 用于缓存 TTL/告警开关，15:00 后必须判 false；
  //  分时绘制用 isEtfContinuousMinute，那边才含 15:00 收盘点）
  return (t >= 570 && t <= 690) || (t >= 780 && t < 900);
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

// 新浪美股日K（收盘价）：2026-11 起腾讯 ifzq 的美股K线接口频繁 501 反爬，QQQ 相关
// 数据改以新浪为主源。返回 [{d:'YYYY-MM-DD', c:close}]，limit 为截取的最近根数。
async function fetchSinaUsDaily(symbol, limit = 0) {
  const txt = await httpGet(
    `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/x/US_MinKService.getDailyK?symbol=${encodeURIComponent(symbol)}&___qn=3`,
    { Referer: 'https://finance.sina.com.cn/' }
  );
  const m = txt.match(/x\((\[[\s\S]*\])\)/);
  if (!m) throw new Error('sina us daily: no data');
  const arr = JSON.parse(m[1]).map(r => ({ d: r.d, c: +r.c })).filter(r => r.d && isFinite(r.c));
  return limit > 0 && arr.length > limit ? arr.slice(-limit) : arr;
}

// QQQ 日K：新浪为主（腾讯 ifzq 2026-11 起对美股K线 501 反爬），腾讯 usQQQ.OQ 兜底
async function fetchQqqDayKline(limit = 120) {
  try {
    const arr = await fetchSinaUsDaily('QQQ', limit);
    if (arr.length) return arr.map(r => ({ date: r.d, close: r.c }));
  } catch { /* 落到腾讯 */ }
  return fetchTencentDayKline('usQQQ.OQ', limit);
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
      fetchQqqDayKline(klineLimit),                      // 纳斯达克100 QQQ（腾讯优先，501反爬时回落新浪）
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
//  溢价仅作估值参考，不限制买卖或仓位；趋势与价格风控独立执行。
// ═══════════════════════════════════════════════════════
const ETF_CODE = 'sz159509';
const ETF_NAME = '纳指科技ETF';
const ETF_FUND_CODE = '159509';
const ETF_NAV_CACHE = { data: null, ts: 0 };
const ETF_MKT_CACHE = { data: null, ts: 0 };
let ETF_PREM_PREV = null;                   // 上一次请求的溢价率（用于盘中穿越买入线检测）
let ETF_KLINES = [];                        // 最近一次拉取的日K（供盘中柱估算）
let LAST_PREMARKET_PLAN = null;
let LAST_NEXT_PREMARKET_PLAN = null;
// 全历史回溯（~134KB）只依赖「日K最后日期」：同一交易日内结果不变，
// 按交易日缓存，避免每次 /api/etf-track（盘中 10s 一轮）都重算一遍全历史回测
const ETF_REVIEW_CACHE = { date: null, data: null };
const ETF_NAV_TTL = 6 * 3600_000;           // 净值历史：6 小时
const ETF_MKT_TTL_TRADING = 20_000;         // 盘中：20 秒
const ETF_MKT_TTL_IDLE = 180_000;           // 非盘中：3 分钟
// 日K独立缓存：盘中日K几乎不变（收盘才补最后一根），不必与 20 秒行情同频重抓腾讯 ifzq
const ETF_KLINE_CACHE = { data: null, ts: 0 };
const ETF_KLINE_TTL_TRADING = 120_000;      // 盘中：2 分钟
const ETF_KLINE_TTL_IDLE = 600_000;         // 非盘中：10 分钟
let ETF_KLINE_BACKOFF_UNTIL = 0;            // 日K上游失败退避：60 秒内不再重试
const ETF_KLINE_BACKOFF_MS = 60_000;

// ── 溢价率档位（按本 ETF 自身历史分布标定，不是通用 ETF 标准）──
// 历史 299 个交易日（2025-07-10 ~ 2026-09-29）实测分布：
//   min 3.3% · p10 7.9% · p25 13.7% · 中位数 17.2% · p75 20.6% · max 32.3%
//   低于 18% 的交易日占 58.5%，低于 15% 占 31.8%；长期正溢价是 QDII 外汇额度受限所致。
// 历史上按「溢价 < 阈值」进场后持 20 个交易日的场内价平均收益（含溢价收敛贡献）：
//   <15% → +7.87%（胜率 83%）· <18% → +6.25%（76%）· <25% → +4.02%（64%）
//   即：进场溢价越低，后续收益与胜率越好，价差约 2~4 个百分点来自溢价回归本身。
const PREMIUM_ADD = 15;
const PREMIUM_BUY = 18;
const PREMIUM_WATCH = 22;
const PREMIUM_DANGER = 27;
const PREMIUM_ZONES = [
  { key: 'add',   level: 'cheap',   label: '较低',   lo: -Infinity,      hi: PREMIUM_ADD,    note: `溢价 <${PREMIUM_ADD}%，仅供参考` },
  { key: 'buy',   level: 'ok',      label: '中低',   lo: PREMIUM_ADD,    hi: PREMIUM_BUY,    note: `溢价 ${PREMIUM_ADD}~${PREMIUM_BUY}%，仅供参考` },
  { key: 'watch', level: 'warn',    label: '中等',   lo: PREMIUM_BUY,    hi: PREMIUM_WATCH,  note: `溢价 ${PREMIUM_BUY}~${PREMIUM_WATCH}%，仅供参考` },
  { key: 'avoid', level: 'high',    label: '高溢价', lo: PREMIUM_WATCH,  hi: PREMIUM_DANGER, note: `溢价 ${PREMIUM_WATCH}~${PREMIUM_DANGER}%，注意溢价回落风险，不限制买卖或仓位` },
  { key: 'exit',  level: 'extreme', label: '极高',   lo: PREMIUM_DANGER, hi: Infinity,       note: `溢价 ≥${PREMIUM_DANGER}%，注意溢价回落风险，不限制买卖或仓位` },
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
const ETF_DAY_PLAN_FILE = path.join(__dirname, 'data', 'etf-day-plan.json');
function loadEtfDayPlan(today) {
  try {
    const plan = JSON.parse(fs.readFileSync(ETF_DAY_PLAN_FILE, 'utf8'));
    return plan._date === today ? plan : null;
  } catch { return null; }
}
function saveEtfDayPlan(plan) {
  const signature = JSON.stringify([plan._date, plan.buy, plan.sell, plan.touched, plan.signalEvents]);
  if (saveEtfDayPlan.signature === signature) return;
  try {
    fs.writeFileSync(ETF_DAY_PLAN_FILE, JSON.stringify(plan));
    saveEtfDayPlan.signature = signature;
  } catch (err) { console.error('[etf-day-plan]', err.message); }
}
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

function etfMinuteNumber(t) {
  return /^\d{2}:\d{2}$/.test(t || '') ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : -1;
}

function isEtfContinuousMinute(t) {
  const min = etfMinuteNumber(t);
  return (min >= 570 && min <= 690) || (min >= 780 && min <= 900);
}

function parseEtfMinuteData(data) {
  if (!data || !Array.isArray(data.data) || !data.data.length) return null;
  const dra = String(data.date || '');
  const points = [], inactive = [];
  for (const line of data.data) {
    const parts = String(line).trim().split(/\s+/);
    if (!/^\d{4}$/.test(parts[0])) continue;
    const t = `${parts[0].slice(0, 2)}:${parts[0].slice(2)}`;
    const price = Number(parts[1]), volume = Number(parts[2]), amount = Number(parts[3]);
    if (!isEtfContinuousMinute(t) || !(price > 0) || !Number.isFinite(volume) || volume < 0) continue;
    if (volume === 0) { inactive.push(t); continue; }
    let avg = amount > 0 ? amount / (volume * 100) : null;
    if (avg != null && (!Number.isFinite(avg) || avg < price * 0.8 || avg > price * 1.2)) avg = null;
    points.push({ t, price, avg, volume });
  }
  points.sort((a, b) => a.t.localeCompare(b.t));
  return {
    date: dra.length === 8 ? `${dra.slice(0, 4)}-${dra.slice(4, 6)}-${dra.slice(6, 8)}` : dra,
    points,
    inactiveRange: inactive.length ? `${inactive[0]}–${inactive[inactive.length - 1]}` : null,
    note: inactive.length ? '零成交时段未绘制，可能暂停交易或数据尚未到达；不据此生成信号。' : '',
  };
}

async function fetchTencentEtfMinute(symbol) {
  const j = await fetchTencentIfzqJson(`/appstock/app/minute/query?code=${symbol}`);
  return parseEtfMinuteData(j && j.data && j.data[symbol] && j.data[symbol].data);
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
//  · 「不追高」过滤器（威廉%R≤-60 / 收盘<MA21 / 收盘<布林中轨，任一命中）显著改善买点质量
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
  const ma30 = movingAvgSeries(C, 30);   // v8.1 清仓铁律：跌破 MA21+MA30 清仓、跌破 MA21+MA30+MA60 跑路
  const ma60 = movingAvgSeries(C, 60);
  const bars = calcMACD(klines, klines.length);
  const goldenCross = i => i > 0 && bars[i - 1] && bars[i - 1].dif < bars[i - 1].dea && bars[i].dif >= bars[i].dea;
  const deathCross = i => i > 0 && bars[i - 1] && bars[i - 1].dif > bars[i - 1].dea && bars[i].dif <= bars[i].dea;
  const premAt = i => {
    const v = navMap[klines[i].date];
    return v > 0 ? C[i] / v * 100 - 100 : null;
  };
  // 段内建议仓位（复用仓位建议的逐日目标仓位；已含「美股趋势确认」门控）
  const posSeries = buildEtfPositionSeries(klines, navMap, null, panic && panic.active, usIdx) || [];
  const posAt = i => (posSeries[i] && posSeries[i].target != null) ? posSeries[i].target : null;

  const META = {
    buy_strong: { label: '重仓买入', action: '分批重仓', side: 'buy' },
    buy:        { label: '买入',     action: '分批买入', side: 'buy' },
    buy_weak:   { label: '试仓',     action: '小仓试仓', side: 'buy' },
    buy_small:  { label: '少量买入', action: '小仓 ≤3成', side: 'buy' },
    sell_weak:  { label: '持有不加仓', action: '持仓不动', side: 'hold' },
    wait_us:    { label: '等重仓确认', action: '暂缓加仓/减仓', side: 'hold' },
    panic_wait: { label: '抄底未确认', action: '撤回防守仓', side: 'hold' },
    panic_try:  { label: '恐慌试仓',  action: `小仓试仓 ${Math.round(POS_TRY_CAP * 100)}%`, side: 'buy' },
    weak_warn:  { label: '走弱预警',  action: '停止加仓·准备减仓', side: 'hold' },
    sell:       { label: '减仓',     action: '减仓',     side: 'sell' },
    sell_clear: { label: '清仓/减半', action: '清仓或减半', side: 'sell' },
    sell_run:   { label: '跑路清仓',  action: '立刻清仓·三条均线全破', side: 'sell' },
  };
  // ── v8「走弱就减仓」：卖出侧彻底与溢价解耦 ────────────────────────────────
  // 起因（用户 2026-10-03 复盘）：2025-12-09 起纳指科技开始走弱、2026-01-12 收盘跌破
  // MA21，清单这两天**完全没有减仓/清仓提示**。根因：卖出侧整个长在「高溢价（≥22%）」
  // 分支里，而这两天的溢价是 19.9% / 19.0%，落在中低溢价区 —— 那里只有买入分支，
  // 走弱信号被整个吞掉。v7 铁律明明已把 tier 判成 'run'，却只把「买入」降级成 wait_us
  // （side=hold），从没产生过真正的减仓指令，铁律的下半句（「翻绿或跌破 MA21 都要减仓
  // 清仓跑路」）在清单里是空转的。
  // 修正：把「走弱」提升为**独立于溢价**的判定层，四条各计 1 分，溢价多低都不豁免
  // （低溢价只代表便宜，不代表不会继续跌——2026-01~03 一路「低溢价→加仓」亏 3 个月
  // 就是最好的反例）：
  //   ① 纳指科技跌破 MA21  ② 纳指科技 MACD 翻绿  ③ 纳指100 跌破 MA21  ④ 纳指100 MACD 翻绿
  // 距 MA21 的破位用「裸线」判定（不加 2% 缓冲、不等连续 3 日）：预警的价值就在「早」，
  // 等 trendBroken 确认时 2025-12-16 已经从 2.348 跌到 2.264。
  // 分级（2026-08-19 复盘后改为“动能预警、价格确认”）：
  //   1 走弱预警 = MACD 翻绿 / 红柱缩短 / DIF 拐头，但价格仍在 MA21 上方
  //   2 减仓     = MACD 翻绿 + 跌破 MA21，或纳指100 跌破 MA21
  //   3 清仓     = 任一标的跌破 MA21+MA30
  //   4 跑路清仓 = 任一标的 MA21+MA30+MA60 三线全破（本 ETF 自己没事）
  // 另加一条比死叉更早的前兆（计 1 分）：MACD 红柱连续 2 日缩短 + DIF 拐头向下。
  // 2025-12-12 命中（红柱 0.0125→0.0108→0.0076、DIF 0.0497→0.0484），比 12-16 死叉早 2 日。
  // 恐慌抄底窗口豁免（恐慌底本来就是破位+翻绿，不该再喊减仓）。
  // 2026-08-19~09-17 的关键教训：MACD 翻绿后价格仍在高位震荡并最终向上突破，
  // 所以 MACD 只做预警；是否减仓交给 MA21，是否清仓交给 MA21+MA30。
  //
  // ── v8.1 清仓铁律（用户 2026-10-03）：跌破组合均线 → 立即清仓，不等持续、不看溢价 ──
  // 用户原话：「纳指科技收盘价有一天低于 21、30 均线，马上提示清仓；同时低于 21、30、60，
  //   提示跑路清仓；纳斯达克100 出现这个情况，也提示清仓。」
  // 落地（与 v8 四项计分正交，看「价格相对均线的位置结构」）：
  //   lv4 跑路清仓 sell_run = 任一标的「MA21+MA30+MA60 三条全破」（中期趋势彻底转空）
  //   lv3 清仓   sell_clear = 任一标的「跌破 MA21+MA30」（立即），或 v8 双杀
  //   lv2 减仓   sell       = 只有本 ETF 转弱但已持续 3 日（v8 原样）
  // 实测（764 日）：清仓段后 20 日命中率 37%→**50%**（更准了），但按段回测 +243%→+217%。
  // 用户已确认立场（2026-10-03）：**「三条全破」就是清仓标准，不讨论、不豁免，不能去赌**——
  //   它有时正好出现在阶段底部（14 段只有 21% 后 20 日下跌，2025-04-16、2026-07-17 各反弹
  //   +13%/+12%），但清仓后若重新「翻红 + 站回 MA21」再买回来也不迟。
  //   所以 sell_run 的信号后 20 日正确率偏低（约 21%）是**有意接受的**，不是策略缺陷，
  //   不要再为「优化」这个正确率去放宽/收紧三条全破的判定。
  const WEAK_REPEAT_DAYS = 5;   // 「走弱预警」小字追加到买入行上的最小间隔（交易日）
  let weakCd = 0;

  const sigs = [];
  for (let i = 35; i < n; i++) {
    const p = premAt(i);
    const premTxt = p == null ? '—' : p.toFixed(1) + '%';
    const fWill = willR[i] != null && willR[i] <= -60;
    const fMa = ma21[i] != null && C[i] < ma21[i];
    const fBoll = boll.mid[i] != null && C[i] < boll.mid[i];
    const fHit = fWill || fMa || fBoll;

    let code = null, ev = [], tag = null;
    // 重仓铁律（v7）：MACD 翻红 + 站上 MA21 才允许重仓。溢价低只说明「有性价比」，
    // 不构成抄底/重仓的理由（2026-01~03 一路按「低溢价 → 重仓」加仓，跟着跌了 3 个月）。
    const row = posSeries[i] || null;
    const gtRow = (row && row.gate) || null;
    const tier = (row && row.tier) || 'heavy';
    const heavyOk = tier === 'heavy';
    const gateHint = gtRow && gtRow.miss && gtRow.miss.length
      ? `未满足重仓条件（${gtRow.miss.join('、')}）：溢价再低也只是「有性价比」，不能重仓`
      : '重仓条件已满足（MACD 翻红 + 站上 MA21）';
    const isPanic = !!(panic && panic.active && panic.active.has(klines[i].date));
    // 恐慌下限已失效（触发后超过 PANIC_US_GRACE_DAYS 个交易日仍站不回 MA21）：
    // 说明是下跌中继而非恐慌底（2026-01-21、2025-03-04 两次各亏 6.1%/5.4%），
    // 清单不能再喊「分批重仓」，否则就是用户说的「一路加仓一路亏」。
    const panicLapsed = !!(posSeries[i] && posSeries[i].panicLapsed);
    if (isPanic && panicLapsed) {
      code = 'panic_wait';
      ev = [`溢价 ${premTxt}（仅参考）`,
        `恐慌抄底已触发超过 ${PANIC_US_GRACE_DAYS} 个交易日，价格始终站不回 MA21 ${ma21[i] != null ? ma21[i].toFixed(3) : ''}`,
        gateHint,
        '判断被证伪：这是下跌中继而非恐慌底 → 撤回到试仓/防守档，按当前档位执行'];
    } else if (isPanic) {
      // 恐慌期也守铁律：未满足「MACD 翻红 + 站上 MA21」就只能是「恐慌试仓」，不能喊重仓
      //（2026-01-21 那次清单全程喊「重仓买入」，用户一路加仓亏了 3 个月）
      code = heavyOk ? 'buy_strong' : 'panic_try';
      ev = [`溢价 ${premTxt}（仅参考）`, '买入共振窗口触发：多项超卖、回撤等条件达标，不代表底部或基本面已确认'];
      if (fWill) ev.push(`威廉%R ${willR[i].toFixed(0)} 超卖（≤-60）`);
      if (fMa) ev.push('收盘 < MA21（回调中）');
      if (fBoll) ev.push('收盘 < 布林中轨');
      ev.push(heavyOk
        ? '重仓条件已满足 → 分批重仓到 85%'
        : `尚未满足重仓条件（${gtRow && gtRow.miss && gtRow.miss.length ? gtRow.miss.join('、') : '未确认'}）→ 先按 ${Math.round(POS_TRY_CAP * 100)}% 试仓档小仓分批，站上 MA21 且 MACD 翻红后再补到 65~85%`);
    } else if (fHit) {
      code = heavyOk ? 'buy' : 'buy_weak';
      ev = [`溢价 ${premTxt}（仅参考）`];
      if (fWill) ev.push(`威廉%R ${willR[i].toFixed(0)} 超卖（≤-60）`);
      if (fMa) ev.push('收盘 < MA21（回调中）');
      if (fBoll) ev.push('收盘 < 布林中轨');
    } else if (goldenCross(i)) {
      code = 'buy_weak';
      ev = [`溢价 ${premTxt}（仅参考）`, 'MACD 零轴下金叉（无回调确认，试仓）'];
    } else if (deathCross(i)) {
      code = 'weak_warn'; tag = 'weak';
      ev = ['MACD 死叉（DIF 下穿 DEA），动能转弱', 'MACD 单独翻绿只预警，不直接减仓；若跌破 MA21 再升级为减仓'];
    }
    // ── 走弱层：MACD 单独翻绿只预警；真正减仓看价格破位 ─────────────────────────
    // 2026-08-19 复盘：MACD 先翻绿/红柱缩短后，价格仍可能在强趋势里横盘再上攻。
    // 因此分级改为：MACD 翻绿或红柱缩短 = 预警；MACD 翻绿 + 跌破 MA21 = 减仓；
    // 跌破 MA21+MA30 = 清仓；MA21+MA30+MA60 三线全破 = 跑路清仓。
    if (!isPanic) {
      const gt = gtRow || {};
      const wHit = [];
      const etfBelow = ma21[i] != null && C[i] < ma21[i];
      if (gt.etfRed === false) wHit.push('纳指科技 MACD 翻绿');
      if (etfBelow) wHit.push(`纳指科技跌破 MA21（收 ${C[i].toFixed(3)} < ${ma21[i].toFixed(3)}）`);
      if (gt.usRed === false) wHit.push('纳指100 MACD 翻绿');
      if (gt.usAbove === false) wHit.push(`纳指100 跌破 MA21（${gt.usClose} < ${gt.usMa21}）`);
      const histAt = j => (bars[j] && bars[j].dif != null && bars[j].dea != null) ? bars[j].dif - bars[j].dea : null;
      const h0 = histAt(i), h1 = histAt(i - 1), h2 = histAt(i - 2);
      const d0 = bars[i] ? bars[i].dif : null, d1 = bars[i - 1] ? bars[i - 1].dif : null;
      if (h0 != null && h1 != null && h2 != null && h0 > 0 && h0 < h1 && h1 < h2
          && d0 != null && d1 != null && d0 < d1 && ma21[i] != null && C[i] >= ma21[i]) {
        wHit.push('MACD 红柱连续 2 日缩短且 DIF 拐头（动能衰竭，尚未破位）');
      }

      const etfBelow30 = ma30[i] != null && C[i] < ma30[i];
      const etfBelow60 = ma60[i] != null && C[i] < ma60[i];
      const etfDbl = etfBelow && etfBelow30;
      const etfTpl = etfDbl && etfBelow60;
      const usDbl = gt.usAbove === false && gt.usBelow30 === true;
      const usTpl = usDbl && gt.usBelow60 === true;
      const clearHit = [];
      if (etfBelow) clearHit.push(`纳指科技跌破 MA21（收 ${C[i].toFixed(3)} < ${ma21[i].toFixed(3)}）`);
      if (etfBelow30) clearHit.push(`纳指科技跌破 MA30（收 ${C[i].toFixed(3)} < ${ma30[i].toFixed(3)}）`);
      if (etfBelow60) clearHit.push(`纳指科技跌破 MA60（收 ${C[i].toFixed(3)} < ${ma60[i].toFixed(3)}）`);
      if (gt.usAbove === false) clearHit.push(`纳指100 跌破 MA21（${gt.usClose} < ${gt.usMa21}）`);
      if (gt.usBelow30 === true) clearHit.push(`纳指100 跌破 MA30（${gt.usClose}）`);
      if (gt.usBelow60 === true) clearHit.push(`纳指100 跌破 MA60（${gt.usClose}）`);

      const etfMacdWeak = gt.etfRed === false;
      const usMacdWeak = gt.usRed === false;
      const usWeakBreak = usMacdWeak && gt.usAbove === false;
      const lv = (etfTpl || usTpl) ? 4
        : (etfDbl || usDbl) ? 3
        : ((etfMacdWeak && etfBelow) || usWeakBreak) ? 2
        : (wHit.length > 0 ? 1 : 0);
      if (lv === 0) { weakCd = 0; }
      else if (lv >= 2) {
        code = lv === 4 ? 'sell_run' : (lv === 3 ? 'sell_clear' : 'sell');
        tag = 'weak';
        const extraHit = wHit.filter(x => {
          const k = x.split('（')[0];
          return !clearHit.some(y => y.indexOf(k) >= 0)
            && !(etfMacdWeak && etfBelow && (x === '纳指科技 MACD 翻绿' || x.indexOf('纳指科技跌破 MA21') === 0));
        });
        const hitLine = lv >= 3
          ? `破位命中 —— ${clearHit.join('、')}${extraHit.length ? '；另 ' + extraHit.join('、') : ''}`
          : `减仓触发 —— ${etfMacdWeak && etfBelow ? '纳指科技 MACD 翻绿 + 跌破 MA21' : '纳指100 MACD 翻绿 + 跌破 MA21'}${extraHit.length ? '；另 ' + extraHit.join('、') : ''}`;
        ev = [
          `溢价 ${premTxt}（仅参考）：破位风控独立于溢价`,
          hitLine,
          lv === 4
            ? 'MA21 / MA30 / MA60 三条均线全部跌破 → 中期趋势彻底转空，立刻清仓跑路，不再等确认'
            : (lv === 3
              ? '收盘价已同时跌破 MA21 与 MA30 → 按铁律马上清仓，不等持续、不看溢价'
              : 'MACD 翻绿已经配合 MA21 破位 → 从预警升级为减仓；等重新翻红并站回 MA21 再谈重仓'),
        ];
      } else {
        const wSelf = wHit.some(x => x.indexOf('纳指科技') === 0 || x.indexOf('动能衰竭') >= 0);
        if ((!code || code === 'sell_weak') && wSelf) {
          code = 'weak_warn'; tag = 'weak';
          ev = [
            `溢价 ${premTxt}（仅参考）`,
            `走弱前兆 —— ${wHit.join('、')}`,
            'MACD 单独翻绿/缩短只代表动能降温，不代表价格一定下跌；未跌破 MA21 前只停止加仓，不直接减仓',
          ];
        } else if ((code === 'buy_strong' || code === 'buy' || code === 'buy_weak' || code === 'buy_small') && weakCd === 0) {
          ev.push(`⚠ 已出现走弱征兆（${wHit.join('、')}）：只当预警；若 MACD 翻绿并跌破 MA21，再升级减仓`);
          weakCd = WEAK_REPEAT_DAYS;
        }
      }
      if (weakCd > 0) weakCd--;
    }
    // 非重仓档时把所有「买入/加仓」降级——恐慌抄底属更严格的极端条件，不受此门限制。
    //   run（ETF MACD 翻绿且跌破 MA21，或纳指100 跌破 MA21）→ 等重仓确认：暂缓加仓，按铁律减仓
    //   try（已翻红但价格还没站回 MA21）      → 只给试仓
    if (code && !heavyOk && !isPanic && (code === 'buy_strong' || code === 'buy' || code === 'buy_weak')) {
      ev.push(gateHint);
      if (tier === 'run') { code = 'wait_us'; tag = 'us'; }
      else if (tier === 'watch') code = 'sell_weak';
      else code = 'buy_weak';
    }
    if (code) sigs.push({ idx: i, date: klines[i].date, close: C[i], premium: p == null ? null : +p.toFixed(2), code, tag: tag || code, ev });
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

  // lastDate 给前端判断「最后一段是否仍在进行中」——进行中的段显示「X 起 · 至今」，
  // 不再用「起 ~ 止」区间（区间是事后统计口径，指导当下操作要看的是从哪天开始）。
  return { signals: segs, stats, backtest, lastDate: klines[n - 1].date };
}

const POS_MA_BUF = 0.02;      // MA21 缓冲带：跌破 MA21×0.98 才计为「线下」
const POS_BELOW_N = 3;        // 连续 3 日线下才判定趋势破坏
const POS_FACTOR_TABLE = [
  { pct: '全部溢价', factor: 1, note: '仅供参考，不限制仓位' },
];

// ── 外围情绪源：纳指综合 / 费城半导体 日K（新浪美股）──
// 「恐慌抄底」信号的外盘输入；抓取失败时仅使用其余技术评分。
const US_IDX_CACHE = { data: null, ts: 0, state: null };
let US_IDX_BACKOFF_UNTIL = 0;               // 全部源失败退避：30 秒内直接回旧缓存，不再重抓
const US_IDX_TTL = 10 * 60e3;
async function fetchUsIndexHistory() {
  const usState = getUSMarketState();
  const staleAcrossClose = US_IDX_CACHE.state === 'REGULAR' && usState !== 'REGULAR';
  if (Date.now() < US_IDX_BACKOFF_UNTIL) return US_IDX_CACHE.data;
  if (US_IDX_CACHE.data && !staleAcrossClose && Date.now() - US_IDX_CACHE.ts < US_IDX_TTL) return US_IDX_CACHE.data;
  const out = {};
  const closeHistory = (arr) => {
    const dates = arr.map(r => r.d), closes = arr.map(r => r.c), ret = {}, ret5 = {};
    for (let i = 1; i < arr.length; i++) ret[dates[i]] = +((arr[i].c / arr[i - 1].c - 1) * 100).toFixed(2);
    for (let i = 5; i < arr.length; i++) ret5[dates[i]] = +((arr[i].c / arr[i - 5].c - 1) * 100).toFixed(2);
    return { dates, closes, ret, ret5 };
  };
  // ndx = 纳斯达克 100：本 ETF 跟踪的就是纳指科技，比纳指综合（ixic）更贴近；
  // 且它的 MA21 / MACD 直接参与「能不能重仓」的门控（见 buildHeavyGate）。
  // qqq（QQQ ETF 日K）2026-11-10 起改新浪源为主：腾讯 ifzq 的 usQQQ.OQ 三个域名
  // 全部返回 501 反爬 HTML（或连接失败），导致 usIdx 长期缺 qqq，「历史跌幅回顾」
  // 因 buildPremarketHistoryReview 拿不到 usIdx.qqq 而静默消失。
  await Promise.all([['ixic', '.IXIC'], ['ndx', '.NDX'], ['sox', '.SOX'], ['qqq', 'QQQ']].map(async ([key, sym]) => {
    try {
      out[key] = closeHistory(await fetchSinaUsDaily(sym));
    } catch (e) { console.error('[us-index]', key, e.message); }
  }));
  if (!out.qqq) {
    // 新浪 QQQ 也失败时的兜底：腾讯 usQQQ.OQ（2026-11 起经常被 501 反爬拦截）
    try {
      const rows = await fetchTencentDayKline('usQQQ.OQ', 1000);
      const arr = rows.map(r => ({ d: r.date, c: +r.close })).filter(r => r.d && isFinite(r.c));
      if (arr.length) out.qqq = closeHistory(arr);
    } catch (e) { console.error('[us-index]', 'qqq-tencent', e.message); }
  }
  // 任一指数成功即写缓存（此前仅 IXIC 成功才写：IXIC 挂掉时 NDX/SOX/QQQ 白抓且不缓存，
  // 下个请求又重抓四源）。全失败则退避 30 秒。
  if (Object.keys(out).length) {
    US_IDX_CACHE.data = out; US_IDX_CACHE.ts = Date.now(); US_IDX_CACHE.state = usState;
    US_IDX_BACKOFF_UNTIL = 0;
  } else {
    US_IDX_BACKOFF_UNTIL = Date.now() + 30_000;
  }
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

// ── v9「重仓铁律」：入场看 MACD+MA21，出场看价格破位确认 ────────────────
// 2026-08-19 复盘：MACD 先缩短/翻绿后，价格仍在强趋势里横盘再上攻。
// 因此 MACD 单独翻绿只作为动能预警，不再直接触发减仓；必须配合价格跌破 MA21 才升级。
// MA21+MA30 仍是清仓铁律，MA21+MA30+MA60 三线全破仍是跑路清仓。
const POS_TRY_CAP = 0.20;
const POS_RUN_CAP = 0.10;
const POS_MAX_NOT_HEAVY = 0.5;    // 「非重仓档一律 ≤50%」的硬红线
function buildHeavyGate(rows, usIdx) {
  const n = rows.length;
  const out = new Array(n).fill(null);
  if (!n) return out;
  const C = rows.map(r => r.close);
  const ma21 = movingAvgSeries(C, 21);
  const bars = calcMACD(rows.map(r => ({ date: r.date, close: r.close })), n);
  // 优先用纳指 100（本 ETF 的跟踪标的），没有就退回纳指综合
  const ix = (usIdx && (usIdx.ndx || usIdx.ixic)) || null;
  let usMa21 = null, usMa30 = null, usMa60 = null, usDif = null, usDea = null, usAt = null;
  if (ix && ix.dates && ix.closes && ix.dates.length > 60) {
    usMa21 = movingAvgSeries(ix.closes, 21);
    // MA30 / MA60 不参与重仓门控，只供「清仓铁律」判断（跌破 21+30 清仓、跌破 21+30+60 跑路）
    usMa30 = movingAvgSeries(ix.closes, 30);
    usMa60 = movingAvgSeries(ix.closes, 60);
    const ub = calcMACD(ix.closes.map((c, i) => ({ date: ix.dates[i], close: c })), ix.closes.length);
    usDif = ub.map(b => (b && b.dif != null ? b.dif : null));
    usDea = ub.map(b => (b && b.dea != null ? b.dea : null));
    usAt = new Array(n).fill(-1);
    let p = -1;
    for (let i = 0; i < n; i++) { while (p + 1 < ix.dates.length && ix.dates[p + 1] < rows[i].date) p++; usAt[i] = p; }
  }
  for (let i = 0; i < n; i++) {
    if (ma21[i] == null) continue;
    const bar = bars[i] || {};
    const etfAbove = C[i] > ma21[i];
    const etfRed = bar.dif != null && bar.dea != null && bar.dif > bar.dea;
    // ── 破位后的「修复段」识别（mirror usRepair 的 3% 口径）──
    // run 档触发条件是「MACD 翻绿 + 跌破 MA21」双确认，但触发后到站回 MA21 之前
    // 一直喊"减仓跑路"：破位后的反弹段里继续杀跌容易卖在修复起点，也不友好。
    // 自近 20 日收盘低点反弹 ≥3%（与美股止跌确认同阈值）视为修复段：仓位上限不变
    // （铁律不动），只把文案从"减仓跑路"切到"修复中 · 维持低仓"。
    const low20 = Math.min(...C.slice(Math.max(0, i - 19), i + 1));
    const etfRebound = low20 > 0 ? (C[i] / low20 - 1) * 100 : null;
    const histCur = (bar.dif != null && bar.dea != null) ? bar.dif - bar.dea : null;
    const pb = i > 0 ? (bars[i - 1] || {}) : {};
    const histPrev = (pb.dif != null && pb.dea != null) ? pb.dif - pb.dea : null;
    const histImproving = histCur != null && histPrev != null && histCur > histPrev;
    const etfRepair = !etfAbove && !etfRed && etfRebound != null && etfRebound >= 3;
    const gapToMa21 = ma21[i] > 0 ? (ma21[i] / C[i] - 1) * 100 : null;
    let usAbove = null, usRed = null, usZero = null, usClose = null, usMa = null, dv = null, dvDea = null;
    let usBelow30 = null, usBelow60 = null;
    const ui = usAt ? usAt[i] : -1;
    if (ui >= 21 && usMa21 && usMa21[ui] != null) {
      usClose = ix.closes[ui]; usMa = usMa21[ui];
      dv = usDif ? usDif[ui] : null;
      dvDea = usDea ? usDea[ui] : null;
      usAbove = usClose > usMa;
      usRed = (dv != null && dvDea != null) ? (dv > dvDea) : null;   // 美股 MACD 是否翻红
      // 放行「入场」的动能条件取二者之一：已翻红（动能在转正），或 DIF 已在零轴上方（本就强势）
      usZero = usRed != null ? (usRed || dv > 0) : null;
      usBelow30 = usMa30 && usMa30[ui] != null ? usClose < usMa30[ui] : null;
      usBelow60 = usMa60 && usMa60[ui] != null ? usClose < usMa60[ui] : null;
    }
    const hasUs = usAbove != null && usZero != null;
    // 重仓（heavy）：ETF 站上 MA21 且 MACD 翻红；纳指100 也要站上 MA21 且动能不能是负的
    const heavy = etfAbove && etfRed && (!hasUs || (usAbove && usZero));
    // 跑路（run）：单 MACD 翻绿或单独跌破 MA21 都只预警；必须 MACD 翻绿 + 价格破 MA21，才降到减仓档。
    const run = (!etfRed && !etfAbove) || (hasUs && !usRed && !usAbove);
    const miss = [];
    if (!etfAbove) miss.push('ETF 未站上 MA21');
    if (!etfRed) miss.push('ETF MACD 翻绿');
    if (hasUs && !usAbove) miss.push('纳指100 跌破 MA21');
    if (hasUs && !usRed) miss.push('纳指100 MACD 翻绿');
    const macdWatch = !etfRed || (hasUs && !usRed);
    out[i] = {
      tier: heavy ? 'heavy' : (run ? 'run' : (macdWatch ? 'watch' : 'try')), etfAbove, etfRed, usAbove, usRed, usZero, hasUs, miss,
      usBelow30, usBelow60,
      etfRepair, etfRebound: etfRebound == null ? null : +etfRebound.toFixed(2), histImproving, gapToMa21: gapToMa21 == null ? null : +gapToMa21.toFixed(2),
      close: +C[i].toFixed(3), ma21: +ma21[i].toFixed(3),
      dif: bar.dif == null ? null : +bar.dif.toFixed(4), dea: bar.dea == null ? null : +bar.dea.toFixed(4),
      usClose: usClose == null ? null : +usClose.toFixed(2), usMa21: usMa == null ? null : +usMa.toFixed(2),
      usDif: dv == null ? null : +dv.toFixed(2),
    };
  }
  return out;
}

// ── 「恐慌抄底」信号 ──
// 为什么不能只看技术超卖：764 日回测里，单纯用 %R/布林/RSI 超卖抄底会在趋势下跌中反复接飞刀
// （2025-01、2026-01 各一次，20 日后 -5% ~ -6%）。真正区分「恐慌底」与「半山腰」的是
// **外围情绪**：隔夜外盘重挫说明利空在集中兑现，而不是基本面在恶化。
// 2026-07-30 实测：隔夜纳指 -1.74% / 费半 -5.33% + %R -98 + 布林 2% + 溢价 15.6% → 触发，
// 4 个交易日 +8.8%（同期价格 +9.4%），而基准仓位只给 59%。
// 预警不改变仓位；6 项共振 ≥5 项才开启窗口，实际仓位由价格确认与趋势决定。
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
  { min: 6, label: '强超卖共振', note: '多项买入条件达标，不代表底部确认，按仓位风控执行' },
  { min: 5, label: '买入共振达标', note: '达到窗口评分门槛，仍需检查价格、趋势确认' },
  { min: 4, label: '接近买点', note: '关注候选买点，尚未达到正式窗口门槛，不自动加仓' },
  { min: 3, label: '部分条件满足', note: 'ETF 买入共振不足，预警不等于买入' },
  { min: 0, label: '买入条件不足', note: '尚未达到买入共振门槛' },
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
  const fmtPct = v => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const scoreAt = (i, ovOverride) => {
    const hits = [], checks = []; let s = 0;
    const addCheck = (key, value, rule, ok, why) => {
      const item = { key, value, rule, ok: !!ok, why };
      checks.push(item);
      if (item.ok) { s++; hits.push({ key, value, why }); }
      return item;
    };
    const bp = B.up[i] != null ? (C[i] - B.dn[i]) / (B.up[i] - B.dn[i]) : null;
    addCheck('威廉%R', W[i] != null ? W[i].toFixed(0) : '—', '≤ -95 极限超卖', W[i] != null && W[i] <= -95, '短线动量是否杀到极端低位');
    addCheck('布林位置', bp != null ? (bp * 100).toFixed(0) + '%' : '—', '≤ 10% 贴近下轨', bp != null && bp <= 0.10, '价格是否贴近布林下轨');
    addCheck('RSI14', R[i] != null ? R[i].toFixed(0) : '—', '≤ 40 弱势区', R[i] != null && R[i] <= 40, '14 日 RSI 是否进入弱势区');
    const r5 = i >= 5 ? (C[i] / C[i - 5] - 1) * 100 : null;
    const selloffCheck = addCheck('5日跌幅', r5 != null ? r5.toFixed(1) + '%' : '—', '≤ -4% 急跌', r5 != null && r5 <= -4, 'ETF 近 5 个交易日是否急跌');
    const hi20 = Math.max(...C.slice(Math.max(0, i - 19), i + 1));
    const dd20 = (C[i] / hi20 - 1) * 100;
    const drawdownCheck = addCheck('距20日高', dd20.toFixed(1) + '%', '≤ -6% 回撤', dd20 <= -6, 'ETF 是否从 20 日高点明显回撤');
    const ov = ovOverride || ovAt(klines[i].date);
    const ovDailyHit = !!(ov && ((ov.ixic != null && ov.ixic <= -1.5) || (ov.sox != null && ov.sox <= -3)));
    const ovFiveHit = !!(ov && ov.ixic5 != null && ov.ixic5 <= -5);
    const externalCheck = addCheck(
      ov && ov.latest ? '最新外围' : '隔夜外围',
      ov ? `纳指 ${fmtPct(ov.ixic)} · 费半 ${fmtPct(ov.sox)} · 纳指5日 ${fmtPct(ov.ixic5)}` : '—',
      '纳指≤-1.5% 或费半≤-3%；或纳指5日≤-5%',
      ovDailyHit || ovFiveHit,
      ov ? `美股 ${ov.date} 外盘恐慌输入` : '外盘数据缺失'
    );
    const etfStress = selloffCheck.ok || drawdownCheck.ok;
    const warning = {
      active: externalCheck.ok || etfStress,
      level: externalCheck.ok
        ? (etfStress ? '恐慌共振预警' : '外盘恐慌预警')
        : (etfStress ? 'ETF 回撤预警' : (ov ? '未见明显恐慌' : '外盘数据缺失')),
      tone: externalCheck.ok && etfStress ? 'hot' : (externalCheck.ok || etfStress ? 'warm' : ''),
      checks: [externalCheck, selloffCheck, drawdownCheck],
      note: '外盘重挫、ETF 急跌或明显回撤即可预警，不要求极限超卖或低溢价；预警不代表底部确认，也不自动加仓。',
    };
    const lv = PANIC_LEVELS.find(x => s >= x.min);
    return {
      date: klines[i].date, close: +C[i].toFixed(3), premium: prem[i] == null ? null : +prem[i].toFixed(2),
      score: s, hits, checks, level: lv.label, levelNote: lv.note, overnight: ov, warning,
      ma21: ma21[i] == null ? null : +ma21[i].toFixed(3),
    };
  };
  const latestUsAt = () => {
    if (!usIdx || !usIdx.ixic || !Array.isArray(usIdx.ixic.dates) || !usIdx.ixic.dates.length) return null;
    const dd = usIdx.ixic.dates[usIdx.ixic.dates.length - 1];
    return { date: dd, ixic: usIdx.ixic.ret[dd] ?? null, ixic5: usIdx.ixic.ret5[dd] ?? null, sox: usIdx.sox ? (usIdx.sox.ret[dd] ?? null) : null, latest: true };
  };
  const rows = [];
  for (let i = 21; i < n; i++) rows.push(scoreAt(i));
  // 触发 → 维持 → 退出
  // 持仓中「更低位重置」规则（2026-10-13 新增）：触发后若当日 score ≥ 6（极度恐慌）
  // 且不低于持仓触发时 score，且收盘价 < 当前成本——说明利空在更深位兑现、价格更便宜，
  // 用今日收盘价重置成本价和持有天数，相当于「金字塔式在更低位重新开仓」。
  // 回测（768 日，A2 规则）：胜率 64% → 100%，平均 +2.57% → +9.5%；
  // 2025-03-04 那次（扛 30 日 -5.4%）会在 2-25 / 2-28 / 3-04 / 3-11 / 3-31 / 4-07
  // 逐级重置，最终成本落在 2025-04-07 的 1.23，6 日 +13.5% 退出（关税战真底）。
  // 不设重置上限：实测上限 3 次反而会让 2025 那波在 3-11 用完额度，错过 4-07 真底。
  const active = new Set(); const events = [];
  let on = false, cost = 0, cnt = 0, cur = null;
  for (const r of rows) {
    if (!on && r.score >= PANIC_TRIGGER) { on = true; cost = r.close; cnt = 0; cur = { date: r.date, score: r.score, px: r.close, hits: r.hits, level: r.level }; }
    else if (on && r.score >= 6 && r.score >= cur.score && r.close < cost) {
      // score 维持极度恐慌 + 价格创新低 → 在更低位重置（保留上次触发点供复盘）
      const prev = { date: cur.date, score: cur.score, px: cur.px };
      cost = r.close; cnt = 0;
      cur = { date: r.date, score: r.score, px: r.close, hits: r.hits, level: r.level, resetFrom: prev };
    }
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
  const latestOv = latestUsAt();
  const current = latestOv && last && (!last.overnight || latestOv.date > last.overnight.date)
    ? scoreAt(n - 1, latestOv)
    : last;
  // 最近触发列表：覆盖最近 2 年（含未闭合），供前端「最近触发」完整展示
  const twoYearsAgo = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 2); return d.toISOString().slice(0, 10); })();
  const recent = events.filter(e => e.date >= twoYearsAgo).reverse();
  return {
    active, events, recent, current,
    levels: PANIC_LEVELS,
    config: { trigger: PANIC_TRIGGER, cap: POS_PANIC_CAP, capAdd: POS_PANIC_CAP_ADD, holdDays: PANIC_HOLD_DAYS, takeProfit: PANIC_TAKE_PROFIT, ma21Band: PANIC_MA21_BAND, graceDays: PANIC_US_GRACE_DAYS, tryCap: POS_TRY_CAP },
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
  // 重仓铁律：MACD + MA21 四档门控（heavy / watch / try / run）
  const gates = buildHeavyGate(rows, usIdx);
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
    const usOk = !usRow || usRow.ok;   // 美股中期趋势（MA50），仅用于展示，不再单独封顶
    const g = gates[i];
    // 无外盘 / 指标不足时静默降级为重仓档，保证「抓取失败」不等于「不让买」
    const tier = g ? g.tier : 'heavy';
    let cap;
    if (tier === 'heavy' || tier === 'watch') {
      cap = state === 'UP' ? (brokeMa60 ? 0.6 : 1.0) : 0.3;
    } else {
      cap = tier === 'run' ? Math.min(POS_RUN_CAP, POS_TRY_CAP) : POS_TRY_CAP;
    }
    // 零轴下死叉：趋势转弱再压一档
    if (state === 'UP' && i > 0 && bars[i - 1] && bars[i - 1].dif >= bars[i - 1].dea && bar.dif != null && bar.dif <= bar.dea && bar.dif < 0) cap *= 0.7;
    let target = Math.max(0, Math.min(1, cap));
    if (tier === 'watch') target = Math.min(target, POS_MAX_NOT_HEAVY);
    const panic = !!(panicActive && panicActive.has(rows[i].date));
    if (panic) { if (!panicOn) { panicOn = true; panicAdded = false; panicStartIdx = i; } }
    else { panicOn = false; panicStartIdx = -1; }
    if (panicOn && !panicAdded && C[i] > ma21[i]) panicAdded = true;
    // 恐慌下限的「有效期」：11 次历史触发里，站上 MA21 快的（4 天、10 天、12 天）都是好底
    // （+8.8% / +6.2% / +8.4%），而 2026-01-21、2025-03-04 两次扛满 30 天都站不回 MA21，
    // 各亏 6.1% / 5.4%——那是下跌中继，不是恐慌底。所以：尚未回到重仓档（tier!=='heavy'）时，
    // 触发后超过 PANIC_US_GRACE_DAYS 个交易日仍未站上 MA21，就撤掉下限、回到防守仓位。
    // 注意不能反过来「美股走坏就不让恐慌抄底」——实测美股走坏期的 6 次反而更准
    // （平均 +2.7%、胜率 67%，2026-07-30 的最佳案例正是此状态），门控的是「扛多久」。
    const panicLapsed = panicOn && !panicAdded && tier !== 'heavy' && panicStartIdx >= 0 && (i - panicStartIdx) >= PANIC_US_GRACE_DAYS;
    // 站上 MA21 只确认止跌，MACD 翻红后才允许重仓。
    if (panicOn && !panicLapsed) {
      if (panicAdded && tier === 'heavy') {
        target = Math.max(target, POS_PANIC_CAP_ADD);
      } else if (panicAdded && tier !== 'run') {
        target = Math.max(target, POS_PANIC_CAP);
      } else {
        target = POS_TRY_CAP;
      }
    }
    out.push({
      date: rows[i].date, close: +C[i].toFixed(3), premium: p == null ? null : +p.toFixed(2),
      state, bull, ma21: ma21[i] == null ? null : +ma21[i].toFixed(3), ma60: ma60[i] == null ? null : +ma60[i].toFixed(3),
      cap: +cap.toFixed(2), factor: 1, target: +target.toFixed(2), belowDays: below, intraday: !!rows[i].intraday,
      panic, panicAdded: panicOn && panicAdded, panicLapsed,
      // 重仓铁律的逐日判定：tier = heavy/watch/try/run + 四项条件，供前端说明「为什么不能重仓」
      tier, gate: g ? {
        tier: g.tier, etfAbove: g.etfAbove, etfRed: g.etfRed, usAbove: g.usAbove, usRed: g.usRed, usZero: g.usZero, hasUs: g.hasUs,
        etfRepair: g.etfRepair, etfRebound: g.etfRebound, histImproving: g.histImproving, gapToMa21: g.gapToMa21,
        usClose: g.usClose, usMa21: g.usMa21, usDif: g.usDif, miss: g.miss,
      } : null,
      // 美股中期趋势（MA50）：仅用于展示，不再单独封顶（v7 起由 tier 接管）
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

  // 美股趋势确认（MA50 中期口径）：仅用于展示，v7 起仓位由下面的「重仓铁律」接管
  const usOk = last.usOk !== false;
  const usPct = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');

  // ── 重仓铁律（v7）：能不能重仓，只看 MACD 翻红 + 站上 MA21，溢价说了不算 ──
  const tryPct = Math.round(POS_TRY_CAP * 100);
  const runPct = Math.round(Math.min(POS_RUN_CAP, POS_TRY_CAP) * 100);
  const gt = last.gate || {};
  const tier = last.tier || 'heavy';
  const ma21Txt0 = last.ma21 != null ? last.ma21.toFixed(3) : '—';
  const gateInfo = {
    tier, heavy: tier === 'heavy',
    etfAbove: gt.etfAbove != null ? gt.etfAbove : null,
    etfRed: gt.etfRed != null ? gt.etfRed : null,
    usAbove: gt.usAbove != null ? gt.usAbove : null,
    usRed: gt.usRed != null ? gt.usRed : null,
    usZero: gt.usZero != null ? gt.usZero : null,
    hasUs: !!gt.hasUs,
    usClose: gt.usClose != null ? gt.usClose : null,
    usMa21: gt.usMa21 != null ? gt.usMa21 : null,
    usDif: gt.usDif != null ? gt.usDif : null,
    miss: gt.miss || [],
    ma21: last.ma21,
    caps: {
      try: POS_TRY_CAP,
      run: Math.min(POS_RUN_CAP, POS_TRY_CAP),
      maxNotHeavy: POS_MAX_NOT_HEAVY,
    },
    label: tier === 'heavy' ? '重仓条件已满足'
      : (tier === 'run'
        ? (gt.etfRepair ? `破位后修复中 · 维持低仓（自低点 +${gt.etfRebound}%）` : '破位 · 减仓跑路')
        : (tier === 'watch' ? '动能转弱 · 持有观察' : '未确认 · 只能试仓')),
  };
  gateInfo.repair = !!gt.etfRepair;
  gateInfo.etfRebound = gt.etfRebound != null ? gt.etfRebound : null;
  gateInfo.gapToMa21 = gt.gapToMa21 != null ? gt.gapToMa21 : null;
  gateInfo.note = tier === 'heavy'
    ? `ETF 站上 MA21（${ma21Txt0}）且 MACD 翻红，纳指100 也站上 MA21 且动能不为负（MACD 翻红 或 DIF 在零轴上方）→ 两条都确认，可以按趋势仓位上限分批加仓`
    : (tier === 'run'
      ? (gt.etfRepair
        ? `破位未解除（${gateInfo.miss.join('、')}），但已自近 20 日低点反弹 +${gt.etfRebound}%（≥3% 修复确认${gt.histImproving ? '、MACD 绿柱收敛' : ''}）→ 维持减仓后的低仓 ${runPct}%：不再追加减仓（反弹段杀跌容易卖在修复起点），也不加仓；还差 ${gt.gapToMa21}% 收盘站回 MA21，站回且 MACD 翻红后再恢复。反弹回落到距低点 <3% 会自动切回"减仓跑路"口径`
        : `触发：${gateInfo.miss.join('、')} → 价格已经破 MA21，按铁律减仓到 ${runPct}%，未恢复趋势确认前不能重仓`)
      : (tier === 'watch'
        ? `还差：${gateInfo.miss.join('、')} → MACD 转弱但价格仍在 MA21 上方，先停止加仓/观察，不直接减仓`
        : `还差：${gateInfo.miss.join('、')} → 动能已翻红但价格还没站回 MA21，只能试仓 ${tryPct}%`));

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
        ? `纳指自近 20 日低点已反弹 ${usPct(last.usRebound)}（≥${US_TREND_REPAIR_PCT}%），中期止跌确认；实际仓位仍按 MACD 与 MA21 门控执行`
        : '纳指在 MA50 上方或 MA50 未下行，中期趋势健康；实际仓位仍按 MACD 与 MA21 门控执行')
      : `纳指 ${last.usClose != null ? last.usClose.toFixed(0) : '—'} 收在 MA50 ${last.usMa50 != null ? last.usMa50.toFixed(0) : '—'} 下方且 MA50 下行（自近 20 日低点 ${usPct(last.usRebound)}）；仅作中期参考，不单独封顶仓位`,
  };

  let action, tone, headline;
  // 结构化说明（前端按行渲染）：headline 是给人读的一句话，points 是同一件事的拆解。
  // 恐慌窗口那段原来把「触发日/今日评分/门控/仓位/抬仓条件/宽限」塞进一个段落，
  // 两百多字连在一起只能整段读，扫不出关键数字——所以拆成带标签的短行。
  let points = null;
  const prev = series[series.length - 2];
  const changed = prev && Math.abs(last.target - prev.target) >= 0.049;
  // 恐慌窗口元信息（文案与前端共用）：触发日/评分、今日评分、已延续天数、剩余宽限
  // 为什么要单列：过去只有 last.panic 一个布尔量，窗口第 3 天、今日评分 1/6 时也被写成
  // 「触发买入共振信号」，读起来像「今天又恐慌了」。
  const panicWin = (() => {
    if (!last.panic || !panic) return null;
    const ev = Array.isArray(panic.events) ? (panic.events.filter(e => e.open).slice(-1)[0] || null) : null;
    const cur = panic.current || null;
    const idx = ev ? series.findIndex(x => x && x.date === ev.date) : -1;
    const elapsed = idx >= 0 ? (series.length - 1) - idx : null;
    return {
      startDate: ev ? ev.date : null,
      startScore: ev ? ev.score : null,
      startLevel: ev ? ev.level : null,
      startPx: ev ? ev.px : null,
      days: ev ? ev.days : null,
      ret: ev ? ev.ret : null,
      todayScore: cur && cur.score != null ? cur.score : null,
      todayLevel: cur ? cur.level : null,
      elapsed,
      graceLeft: elapsed == null ? null : Math.max(0, PANIC_US_GRACE_DAYS - elapsed),
      fresh: !!(ev && ev.date === last.date),
      aboveMa21: !!last.panicAdded,
    };
  })();
  if (last.panic && last.panicLapsed) {
    // 触发后超过 PANIC_US_GRACE_DAYS 个交易日仍站不回 MA21 → 这是下跌中继，不是恐慌底
    action = `抄底未确认 · 撤回 ${posPct}%`;
    tone = 'warn';
    headline = `恐慌抄底信号已触发超过 ${PANIC_US_GRACE_DAYS} 个交易日，但价格始终站不回 MA21（约 ${last.ma21 != null ? last.ma21.toFixed(3) : 'MA21'}）——`
      + `「利空集中兑现」的判断被证伪，这更像下跌中继（历史上 2026-01-21、2025-03-04 两次各亏 6.1% / 5.4%）。`
      + `撤回 ${Math.round(POS_PANIC_CAP * 100)}% 的仓位下限，按 ${posPct}% 的防守仓位执行；`
      + `等重新站上 MA21 并通过重仓门控后再补回。`;
  } else if (last.panic) {
    const pw = panicWin || {};
    const fresh = !!pw.fresh;
    const graceLeft = pw.graceLeft != null ? pw.graceLeft : null;
    const todayScore = pw.todayScore != null ? pw.todayScore : null;
    const todayLv = pw.todayLevel || null;
    const ma21Txt = last.ma21 != null ? last.ma21.toFixed(3) : 'MA21';
    // 恐慌层同样遵守重仓铁律：站上 MA21 只是「止跌确认」，要 MACD 翻红（重仓档）才到 85%
    const confirmed = last.panicAdded && tier !== 'run';
    action = confirmed ? (tier === 'heavy' ? `分批重仓 · ${posPct}%` : `恐慌抄底 · ${posPct}%`) : `恐慌试仓 · ${posPct}%`;
    tone = 'buy';
    const winTxt = pw.startDate
      ? `恐慌窗口由 ${pw.startDate} 的 ${pw.startScore}/6（${pw.startLevel}）触发，今天是窗口第 ${pw.days} 个交易日（成本 ${pw.startPx}，${pw.ret >= 0 ? '+' : ''}${pw.ret}%）`
      : '恐慌窗口仍在';
    const todayTxt = todayScore != null ? `今日恐慌评分 ${todayScore}/6（${todayLv}）` : '';
    headline = confirmed
      ? (tier === 'heavy'
        ? `恐慌抄底已双重确认（站上 MA21 ${ma21Txt} + MACD 翻红）→ 按「分批重仓」补到 ${posPct}%。`
        : `恐慌抄底已获价格确认（站上 MA21 ${ma21Txt}），但 MACD 还没翻红 → 按 ${posPct}% 执行，翻红后再补到 ${Math.round(POS_PANIC_CAP_ADD * 100)}%。`)
      : (fresh
        ? `${todayTxt || '今日触发'}：多项超卖、回撤等条件达标，但不代表底部或基本面已确认。`
        : `${winTxt}；${todayTxt}——窗口还在，但今天不是新的恐慌买点。`)
        + ` 当前未满足重仓条件（${gateInfo.miss.join('、') || '—'}），按铁律只给 ${posPct}% 试仓档：`
        + `这是「窗口内允许的上限」，不是必须打到的仓位；它覆盖了减仓档的 ${runPct}%，不认同这是恐慌底就按 ${runPct}% 执行。`
        + ` 等 MACD 翻红且收盘站上 MA21（${ma21Txt}）再抬仓。`;
    // 仍在非重仓档时，把「有效期」讲清楚——这正是 2026-01~03 一路扛仓的教训
    if (!last.panicAdded && tier !== 'heavy') {
      headline += graceLeft != null
        ? ` 宽限还剩 ${graceLeft} 个交易日：届时仍站不回 MA21，就撤回恐慌下限、回到 ${runPct}%（防守仓）执行（2026-01-21 那次扛满 30 天亏 6.1%）。`
        : ` 注意：若 ${PANIC_US_GRACE_DAYS} 个交易日内仍站不回 MA21，就撤回恐慌下限、按防守仓位执行（2026-01-21 那次扛满 30 天亏 6.1%）。`;
    }
    // 未获价格确认时给出结构化拆解（已确认的两档文案本来就短，直接用 headline）
    if (!confirmed) {
      const miss = gateInfo.miss.length ? gateInfo.miss.join('、') : '—';
      points = [
        { tag: '窗口', text: pw.startDate
          ? `${pw.startDate} 触发（${pw.startScore}/6 ${pw.startLevel || ''}）· 第 ${pw.days} 个交易日 · 记录成本 ${pw.startPx}（${pw.ret >= 0 ? '+' : ''}${pw.ret}%）`
          : '恐慌窗口进行中' },
        { tag: '今日', text: todayScore != null
          ? `恐慌评分 ${todayScore}/6（${todayLv}）${fresh ? ' · 今日新触发' : ' · 窗口延续，不是新买点'}`
          : '今日评分不可用', tone: fresh ? 'hot' : 'mute' },
        { tag: '门控', text: `未满足重仓，还差：${miss}` },
        { tag: '仓位', text: `${posPct}% 是窗口内上限，覆盖减仓档 ${runPct}%；不认同这是恐慌底就按 ${runPct}% 执行` },
        { tag: '抬仓', text: `收盘站上 MA21 ${ma21Txt}，且 MACD 翻红 → 才补到 ${Math.round(POS_PANIC_CAP * 100)}% / ${Math.round(POS_PANIC_CAP_ADD * 100)}%` },
        { tag: '时效', text: graceLeft != null
          ? `宽限还剩 ${graceLeft} 个交易日，逾期仍站不回 MA21 → 撤回下限、回到 ${runPct}%`
          : `${PANIC_US_GRACE_DAYS} 个交易日内站不回 MA21 → 撤回下限` },
      ];
    }
  } else if (tier === 'run') {
    const prevPos = prev ? Math.round(prev.target * 100) : null;
    const repairTxt = gateInfo.repair
      ? `已自近 20 日低点反弹 +${gt.etfRebound}%（≥3% 修复确认${gt.histImproving ? '、MACD 绿柱收敛' : ''}）`
      : null;
    if (gateInfo.repair) {
      action = `修复中 · 维持低仓 ${posPct}%`; tone = 'warn';
      headline = `破位未解除（${gateInfo.miss.join('、')}），但${repairTxt}——降仓动作已完成（${posPct}%），反弹段不再追加减仓，避免卖在修复起点；也不加仓，还差 ${gt.gapToMa21}% 收盘站回 MA21（${ma21Txt0}），站回且 MACD 翻红后再恢复。`
        + '溢价仅供参考，不改变破位风控。';
      points = [
        { tag: '状态', text: `破位：${gateInfo.miss.join('、') || 'MACD 翻绿且跌破 MA21'}；${repairTxt}` },
        { tag: '仓位', text: `维持 ${posPct}% 低仓${prevPos != null && prevPos > posPct ? `（已从昨日 ${prevPos}% 降完）` : ''}：不追加卖出，也不加仓` },
        { tag: '恢复线', text: `收盘站回 MA21 ${ma21Txt0}（还差 ${gt.gapToMa21}%）且 MACD 翻红 → 退出减仓档` },
        { tag: '失效', text: '反弹回落到距近 20 日低点 <3% → 自动切回"减仓跑路"口径，每日复算' },
        { tag: '溢价', text: `当前 ${p == null ? '—' : p.toFixed(2) + '%'}（${zone.label}），仅参考，不改变破位风控`, },
      ];
    } else {
      action = `减仓跑路 · ${posPct}%`; tone = 'danger';
      headline = `${gateInfo.miss.join('、')}——价格已经破 MA21，按重仓铁律减仓，先降到 ${posPct}%${prevPos != null && prevPos > posPct ? `（昨日 ${prevPos}%）` : ''}。`
        + '溢价仅供参考，不改变破位风控；'
        + `等 ETF MACD 重新翻红且收盘站回 MA21（${ma21Txt0}）才谈加仓。`;
      points = [
        { tag: '门控', text: `破位：${gateInfo.miss.join('、') || 'MACD 翻绿且跌破 MA21'}` },
        { tag: '仓位', text: `降到 ${posPct}%${prevPos != null && prevPos > posPct ? `（昨日 ${prevPos}%）` : ''}，只留防守底仓` },
        { tag: '抬仓', text: `ETF MACD 重新翻红，且收盘站回 MA21 ${ma21Txt0}` },
        { tag: '溢价', text: `当前 ${p == null ? '—' : p.toFixed(2) + '%'}（${zone.label}），仅参考，不改变破位风控`, },
      ];
    }
  } else if (tier === 'watch') {
    action = `持有观察 · ${posPct}%`; tone = 'warn';
    headline = `${gateInfo.miss.join('、')}——只是动能转弱，价格仍在 MA21（${ma21Txt0}）上方，先停止加仓、不直接减仓；若 MACD 翻绿并跌破 MA21，再降到减仓档。`;
    points = [
      { tag: '门控', text: `动能转弱：${gateInfo.miss.join('、') || 'MACD 翻绿'}，但价格仍在 MA21 ${ma21Txt0} 上方` },
      { tag: '仓位', text: `停止加仓，维持 ${posPct}%（非重仓档上限 ${Math.round(POS_MAX_NOT_HEAVY * 100)}%）` },
      { tag: '减仓线', text: `MACD 翻绿且跌破 MA21 → 降到减仓档（${runPct}%）` },
    ];
  } else if (tier === 'try') {
    action = `只可试仓 · ${posPct}%`; tone = 'warn';
    headline = `${gateInfo.miss.join('、')}——还没满足「MACD 翻红 + 站上 MA21」这个重仓的唯一条件，`
      + `只可按 ${posPct}% 以内分批试错，`
      + `等收盘站回 MA21（${ma21Txt0}）且通过重仓门控后再抬仓。`;
    points = [
      { tag: '门控', text: `动能已恢复，但价格还没站回 MA21：${gateInfo.miss.join('、') || '—'}` },
      { tag: '仓位', text: `≤ ${posPct}% 分批试错，不一次打满` },
      { tag: '抬仓', text: `收盘站回 MA21 ${ma21Txt0} 且通过重仓门控` },
    ];
  } else if (!up) {
    // 走到这里的只有 tier === 'heavy' 且 state 仍为 DOWN：价格已站回 MA21（否则进不了
    // heavy 档），只是还没收回 MA21×1.02 的缓冲带。此时 belowDays 必为 0，原文案
    // 「趋势已破坏（连续 0 日…）」是自相矛盾的死文本，改为修复确认口径。
    action = `持有 ${posPct}%`;
    tone = 'warn';
    headline = `重仓门控已确认（MACD 翻红 + 站上 MA21 ${ma21Txt0}），但收盘还没收回 MA21×1.02 缓冲带，趋势章暂记「修复中」：`
      + `收盘连续站回缓冲带上方便自动恢复「趋势向上」，届时趋势上限自动放开（站上 MA60 为 100%，否则 60%）。`
      + `${last.ma60 != null && last.close < last.ma60 ? '注意当前仍在 MA60 下方，趋势上限已按 60% 封顶。' : ''}`;
  } else if (changed && last.target > prev.target) {
    action = `加仓至 ${posPct}%`; tone = 'buy';
    headline = `趋势条件改善，仓位上限放开到 ${posPct}%，可在回踩确认后分批补到该仓位。`;
  } else if (changed && last.target < prev.target) {
    action = `减仓至 ${posPct}%`; tone = 'warn';
    headline = `趋势条件转弱，仓位上限下调到 ${posPct}%；按当前趋势档位控制仓位。`;
  } else if (posPct >= 95) {
    action = '维持满仓'; tone = 'hold';
    headline = '趋势向上且重仓门控已确认，维持目标仓位；跌破 MA21 缓冲带连续 3 日再减。';
  } else {
    action = `持有 ${posPct}%`; tone = 'hold';
    headline = `趋势向上，当前趋势仓位上限 ${posPct}%；按回踩确认分批执行，不追涨。`;
  }

  const entryNote = `若当前空仓：按 ${posPct}% 目标仓位分 2~3 批执行，等待回踩与止跌确认，不一次打满；溢价仅供参考，不限制仓位。`;

  // 触发价位
  const triggers = [];
  if (last.ma21 != null) {
    triggers.push({
      label: `减仓线 · 连续 ${POS_BELOW_N} 日收在 MA21 缓冲带下`,
      price: +(last.ma21 * (1 - POS_MA_BUF)).toFixed(3),
      note: `MA21 ${last.ma21.toFixed(3)} × ${(1 - POS_MA_BUF).toFixed(2)}；触发即按当时仓位上限执行`,
      tone: 'sell',
    });
    triggers.push({
      label: 'MA21（重仓确认线 · 必须站上）',
      price: last.ma21,
      note: gt.etfAbove === false ? '现价还在下方 → 只能试仓，站回上方才谈重仓' : '已站上；还需 MACD 翻红才允许重仓',
      tone: gt.etfAbove === false ? 'warn' : 'ref',
    });
  }
  if (last.ma60 != null) triggers.push({ label: 'MA60（趋势生命线）', price: last.ma60, note: '跌破则趋势上限降到 60%', tone: 'warn' });
  // 纳指 100：重仓的两个前提之一（站上 MA21 + MACD 不能翻绿）
  if (gateInfo.usClose != null && gateInfo.usMa21 != null) {
    const dvTxt = gateInfo.usDif != null ? gateInfo.usDif.toFixed(0) : '—';
    triggers.push({
      label: '纳指100（重仓前提 · 非本 ETF 价位）',
      price: gateInfo.usClose,
      note: `MA21 ${gateInfo.usMa21.toFixed(0)}、DIF ${dvTxt}；`
        + (gateInfo.usAbove ? '已站上 MA21' : '已跌破 MA21')
        + (gateInfo.usRed ? '、MACD 保持翻红' : '、MACD 翻绿')
        + (gateInfo.usAbove && gateInfo.usZero ? ' → 美股这条已确认' : ' → 美股这条不满足重仓前提'),
      tone: (gateInfo.usAbove && gateInfo.usZero) ? 'ref' : 'warn',
    });
  }
  // 纳指综合 MA50：中期趋势参考（不再单独封顶，v7 起由重仓铁律接管）
  if (usInfo.close != null && usInfo.ma50 != null) {
    triggers.push({
      label: '纳斯达克综合（中期风向 · 非本 ETF 价位）',
      price: usInfo.close,
      note: `MA50 ${usInfo.ma50.toFixed(0)}；自近 20 日低点 ${usPct(usInfo.rebound)}`
        + (usOk ? ' → 中期趋势健康/已止跌' : ' → 中期趋势走坏未止跌（参考，不单独封顶）'),
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

  const baseCap = last.cap;
  const capNote = last.panic
    ? (last.panicLapsed
        ? `恐慌抄底已触发超过 ${PANIC_US_GRACE_DAYS} 个交易日但仍站不回 MA21 → 撤回 ${Math.round(POS_PANIC_CAP * 100)}% 下限，按 ${posPct}% 的防守仓位执行`
        : last.panicAdded && tier !== 'run'
          ? `恐慌抄底已获价格确认（站上 MA21）→ ${tier === 'heavy' ? `MACD 也翻红，按 ${posPct}% 目标仓位执行` : `${tier === 'watch' ? 'MACD 转弱但尚未破位' : 'MACD 未翻红'}，按 ${posPct}% 目标仓位执行`}`
          : `恐慌窗口内（${panicWin && panicWin.startDate ? panicWin.startDate + ' 起' : '进行中'}）仍未站上 MA21 → 按 ${posPct}% 试仓档执行；该档覆盖减仓档 ${runPct}%，不认同恐慌底就按 ${runPct}%`)
    : tier === 'run'
      ? (gt.etfRepair
        ? `${gateInfo.miss.join('、')} → 减仓档上限 ${runPct}%，当前目标 ${posPct}%；破位后自低点已反弹 +${gt.etfRebound}%，维持低仓不追加卖出，站回 MA21 且 MACD 翻红后才抬仓`
        : `${gateInfo.miss.join('、')} → 减仓档上限 ${runPct}%，当前目标 ${posPct}%，价格已破 MA21，不能重仓`)
      : tier === 'watch'
        ? `${gateInfo.miss.join('、')} → 动能观察档：价格仍在 MA21 上方，只停止加仓，不因 MACD 单独翻绿直接减仓`
        : tier === 'try'
          ? `${gateInfo.miss.join('、')} → 试仓档上限 ${tryPct}%，当前目标 ${posPct}%；收盘站回 MA21（${ma21Txt0}）且 MACD 翻红后才允许抬仓`
          : `重仓条件已满足 → ${up ? '趋势向上' : (last.belowDays === 0 ? '趋势修复中（已站回 MA21，待缓冲带确认）' : '趋势破坏')}，当前趋势上限 ${Math.round(baseCap * 100)}%；溢价不限制仓位`;

  return {
    action, tone, headline, points, entryNote, capNote, panic: last.panic, panicWindow: panicWin, tier, gate: gateInfo,
    state: last.state,
    // 趋势章与行动卡口径对齐：破位后的反弹段（≥3% 修复确认）不再持续喊"趋势破坏"；
    // state 字段本身不动（回测与仓位阶梯仍按 UP/DOWN 复算），只改展示文案。
    stateLabel: up ? '趋势向上'
      : (gt.etfRepair ? `破位修复中 · 自低点 +${gt.etfRebound}%`
        : (last.belowDays === 0 ? '趋势修复中 · 待缓冲带确认' : '趋势破坏')),
    bull: last.bull, posPct, target: last.target,
    capTrend: baseCap, premiumFactor: last.factor, premium: p, premiumZone: zone,
    ma21: last.ma21, ma60: last.ma60, close: last.close, belowDays: last.belowDays, intraday: last.intraday,
    factorTable: POS_FACTOR_TABLE.map(x => ({ ...x, active: last.factor === x.factor })),
    usTrend: usInfo,
    triggers, backtest,
    // 逐日序列：供前端「仓位阶梯图」与历史查看（近 120 个交易日）
    history: series.slice(-120),
  };
}

// 历史回溯：全区间最佳买卖点 + 多指标策略对比（含每套策略的实际交易日期）
//  · bestBuys/bestSells：事后最优（后视镜视角，用于看清「什么样的位置才是好位置」）
//  · signalBuys：MACD 买入信号，不按溢价筛选
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

  const signalBuys = (signals || [])
    .filter(s => s.side === 'buy' && s.idx < n)
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
  if (klines.length < 35 || !Number.isFinite(price) || price <= 0 || klines[klines.length - 1].date > todayStr) return null;
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
    date: k[n].date, close: price,
    isToday: k[n].date === todayStr,
  };
}

function etfLiveMacdBars(data, klines, today, now = new Date()) {
  const quote = data.quote;
  const last = klines[klines.length - 1];
  // 磁盘兜底的 K 线可能已落后数日：不是今天落盘的缓存不做盘中柱估算，
  // 否则会拿过期 MACD 基线算出假的「盘中翻红/翻绿」信号
  if (data.diskSavedAt && String(data.diskSavedAt).slice(0, 10) !== today) return { bars: data.bars, todayBar: null };
  const minute = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
  const provisional = minute < '15:00';
  const useQuote = data.session.realtime && quote && quote.quoteDate === today && quote.volume > 0
    && last && (provisional || last.date < today);
  const todayBar = useQuote ? etfIntradayBar(klines, quote.price, today) : null;
  if (!todayBar) return { bars: data.bars, todayBar: null };
  const entry = { date: today, close: todayBar.close, dif: todayBar.dif, dea: todayBar.dea, bar: todayBar.bar,
    signal: null, intraday: provisional, estimated: true };
  const bars = data.bars.filter(b => b.date !== today);
  bars.push(entry);
  return { bars: bars.slice(-60), todayBar };
}

// 每日操作建议以趋势与仓位计划为准，溢价仅供参考。
function buildEtfAdvice(ctx) {
  const { quote, ind, lastSignal, pos, todayBar, signals } = ctx;
  const premium = quote.premiumPct;
  const zone = premiumZone(premium);
  const iopv = quote.iopv;
  const price = quote.price != null ? quote.price : ind.price;
  const reasons = [];
  // 理由带 rank（越大越靠前），返回前排序：趋势门控 → 当日动能 → 最近信号 → 溢价参考。
  // 之前固定是「溢价、技术面、信号、盘中柱」的追加顺序，读起来像一堆并列信息，
  // 分不清哪条真正决定了今天的动作；溢价还会被误读成买卖理由（它只解释贵不贵）。
  const addReason = (key, rank, item) => reasons.push({ key, rank, ...item });

  const techBull = ind.price > ind.ma21 && ind.bar > 0;
  const techBear = ind.price < ind.ma21 && ind.bar < 0;
  const buySide = lastSignal && lastSignal.side === 'buy';
  const sellSide = lastSignal && lastSignal.side === 'sell';

  addReason('premium', 10, {
    ref: true,
    tone: 'neutral',
    label: `溢价 ${zone.label}（仅参考）`,
    text: Number.isFinite(premium)
      ? `场内价 ${price.toFixed(3)} / IOPV ${iopv != null ? iopv.toFixed(4) : '—'} = 溢价 ${premium.toFixed(2)}%；不限制买卖或仓位，仍需注意溢价回落风险`
      : '溢价数据缺失，不影响趋势和价格风控判断',
  });
  addReason('tech', 100, {
    tone: techBull ? 'good' : techBear ? 'bad' : 'neutral',
    label: '技术面',
    text: `价格${ind.price > ind.ma21 ? '站上' : '跌破'} MA21(${ind.ma21 != null ? ind.ma21.toFixed(3) : '—'})，MACD ${ind.bar >= 0 ? '红柱 +' : '绿柱 '}${ind.bar.toFixed(3)}`,
  });
  if (lastSignal) {
    addReason('signal', 60, {
      tone: buySide ? 'good' : 'bad',
      label: `最近信号 ${lastSignal.label}`,
      text: `${lastSignal.date} @ ${lastSignal.close.toFixed(3)}，建议${lastSignal.action}；此后${lastSignal.sinceRetPct >= 0 ? '涨' : '跌'} ${Math.abs(lastSignal.sinceRetPct).toFixed(2)}%`,
    });
  }
  if (todayBar && todayBar.isToday) {
    const flip = todayBar.prevBar <= 0 && todayBar.bar > 0 ? '翻红'
      : todayBar.prevBar >= 0 && todayBar.bar < 0 ? '翻绿' : '延续';
    addReason('intraday', 80, {
      tone: flip === '翻红' ? 'good' : flip === '翻绿' ? 'bad' : 'neutral',
      label: '盘中柱',
      text: `现价估算今日 MACD 柱 ${todayBar.bar >= 0 ? '+' : ''}${todayBar.bar.toFixed(3)}（${flip}）`,
    });
  }
  reasons.sort((x, y) => y.rank - x.rank);

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
  const hitFilters = filterDefs.filter(f => f.ok);
  const confirm = {
    filters: filterDefs,
    hit: hitFilters.map(f => f.label),
    hitCount: hitFilters.length,
    level: hitFilters.length ? 'good' : 'chasing',
    note: hitFilters.length
      ? `「${hitFilters.map(f => f.label).join('、')}」命中回调过滤，仍需按趋势与仓位上限分批执行；溢价仅供参考`
      : '三项回调过滤均未命中，价格仍在冲高，等待回踩确认，不因取消溢价限制而追涨',
  };

  let level = 'wait';
  let action = '观望';
  let headline = '';
  const held = !!(pos && pos.shares > 0);
  const plan = ctx.positionPlan;
  if (plan) {
    action = plan.action;
    headline = plan.headline;
    level = plan.tone === 'danger' ? 'danger' : plan.tone === 'warn' ? 'warn' : plan.tone === 'buy' ? 'buy' : 'hold';
  } else if (techBear || sellSide && ind.price < ind.ma21) {
    level = held ? 'danger' : 'wait';
    action = held ? '减仓 / 清仓' : '观望';
    headline = '技术面转空且价格跌破 MA21，先控制风险，等待企稳。';
  } else if (techBull && hitFilters.length) {
    level = 'buy'; action = held ? '持有 / 分批加仓' : '分批买入';
    headline = '趋势与回调过滤配合，可分批执行，仍需遵守总仓位上限。';
  } else {
    level = held ? 'hold' : 'wait'; action = held ? '持有观察' : '观望';
    headline = buySide ? '已有买入信号，等待当前回调与趋势确认，不追涨。' : '等待趋势与回调确认，溢价不再作为买卖限制。';
  }

  return { level, action, headline, points: plan ? (plan.points || null) : null, reasons, held, zone: zone.key, confirm };
}

// ═══════════════════════════════════════════════════════
//  盘前提示 · 日内高抛低吸计划
//   · 盘前生成（BJ 04:00–09:30）+ 盘中微调（已触达档位锁定）
//   · 输入：etf-track 自带 quote/ind/klineLast + 前端查询参数带入的 QQQ/IXIC 24h 涨跌幅
//   · 输出：相对昨收的 1-5 档低吸买点 / 1-2 档高抛目标 / 失效条件 / 生成逻辑
// ═══════════════════════════════════════════════════════

// 基准昨收：按 K 线日期判断哪根是"昨日"
//  - 盘前（pre）：klineLast 是昨日（今日 K 线还没生成）→ 用 klineLast.close
//  - 盘中（live）：klineLast 已是今日（含实时价）→ 昨日 = klinePrev，用 klinePrev.close
//  - 盘后（closed）：klineLast 是今日已收 → 从明日视角看，"昨日"=今日，用 klineLast.close
//  之前盘前/盘中都用 klineLast.close，盘中会拿到今日实时价（如 3.221），
//  导致 P0 失真、所有涨跌幅档位都偏浅（实测：开盘 -3.42% 被算成 -1.03%）。
function getBasePrevClose(ctx, mode) {
  const { quote, klineLast, klinePrev } = ctx;
  if (mode === 'live') {
    if (quote && quote.prevClose > 0) return quote.prevClose;
    const yesterday = klineLast && klineLast.date < ctx.today ? klineLast : klinePrev;
    if (yesterday && yesterday.close > 0) return yesterday.close;
  }
  // 盘前/盘后：klineLast 即昨日
  if (klineLast && isFinite(klineLast.close) && klineLast.close > 0) return klineLast.close;
  if (quote && isFinite(quote.prevClose) && quote.prevClose > 0) return quote.prevClose;
  if (quote && isFinite(quote.price) && quote.price > 0) return quote.price;
  return null;
}

// 模式判定：pre=盘前 04:00-09:30 · live=盘中 09:30-15:00 · next=美股收盘后生成下个交易日计划 · closed=无有效外盘输入
function premarketMode(ctx, nowOverride, opts = {}) {
  const now = nowOverride ? new Date(nowOverride) : new Date();
  // 北京时间
  const bjMs = now.getTime() + 8 * 3600_000;
  const bj = new Date(bjMs);
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const dow = bj.getUTCDay(); // 0=周日 6=周六
  const isWeekday = dow >= 1 && dow <= 5;
  if (isWeekday && min >= 240 && min < 570) return 'pre';          // 04:00-09:30
  if (isWeekday && min >= 570 && min < 900) return 'live';         // 09:30-15:00
  const hasUsCloseInput = [opts.qqqRegPct, opts.ixicRegPct, opts.qqqPct, opts.ixicPct].some(v => v != null && isFinite(v));
  return hasUsCloseInput ? 'next' : 'closed';
}

function unpricedUsMove(history, anchorDate, regular, extended, cumulative, mode) {
  const compound = (a, b) => ((1 + a / 100) * (1 + b / 100) - 1) * 100;
  if (history && history.dates && history.closes && anchorDate) {
    const last = history.dates.length - 1;
    let base = -1;
    for (let i = 0; i <= last && history.dates[i] < anchorDate; i++) base = i;
    if (last >= 0 && history.dates[last] < anchorDate) return mode === 'next' ? null : extended;
    if (base >= 0 && history.closes[base] > 0 && history.closes[last] > 0) {
      const move = (history.closes[last] / history.closes[base] - 1) * 100;
      return compound(move, extended == null ? 0 : extended);
    }
  }
  if (regular != null) return compound(regular, extended == null ? 0 : extended);
  return cumulative != null ? cumulative : extended;
}

function buildPremarketHistoryReview(klines, usIdx, qqqMovePct, beforeDate) {
  // 双向匹配：QQQ 跌幅日看次日"还能跌多深"（low），涨幅日看次日"还能冲多高"（high）。
  // 涨幅回顾仅作卖档的展示参考，不自动校准档位（服务端校准与样本不足提示均以 dir==='down' 门控）。
  if (!Array.isArray(klines) || klines.length < 60 || !usIdx || !usIdx.qqq || qqqMovePct == null || !isFinite(qqqMovePct)) return null;
  const dir = qqqMovePct < 0 ? 'down' : 'up';
  const q = usIdx.qqq;
  if (!Array.isArray(q.dates) || !q.ret) return null;
  const lo = Math.min(qqqMovePct * 0.7, qqqMovePct * 1.3);
  const hi = Math.max(qqqMovePct * 0.7, qqqMovePct * 1.3);
  const cutoff = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 2); return d.toISOString().slice(0, 10); })();
  const nextEtfAfter = (d) => {
    let loIdx = 0, hiIdx = klines.length - 1, ans = -1;
    while (loIdx <= hiIdx) {
      const mid = (loIdx + hiIdx) >> 1;
      if (klines[mid].date > d) { ans = mid; hiIdx = mid - 1; }
      else loIdx = mid + 1;
    }
    return ans;
  };
  const rows = [];
  const lastEtfDate = klines[klines.length - 1].date;
  for (const d of q.dates) {
    if (d < cutoff) continue;
    const move = q.ret[d];
    if (move == null || move < lo || move > hi) continue;
    const i = nextEtfAfter(d);
    if (i < 1 || klines[i].date > lastEtfDate || (beforeDate && klines[i].date >= beforeDate)) continue;
    const prevClose = klines[i - 1].close;
    const row = klines[i];
    if (!(prevClose > 0) || !(row.close > 0) || !(row.low > 0) || !(row.high > 0)) continue;
    if (rows.some(r => r.etfDate === row.date)) continue;
    rows.push({
      qqqDate: d,
      qqqMove: move,
      etfDate: row.date,
      openPct: row.open > 0 ? +((row.open / prevClose - 1) * 100).toFixed(2) : null,
      closePct: +((row.close / prevClose - 1) * 100).toFixed(2),
      lowPct: +((row.low / prevClose - 1) * 100).toFixed(2),
      highPct: +((row.high / prevClose - 1) * 100).toFixed(2),
      open: row.open > 0 ? +row.open.toFixed(3) : null,
      close: +row.close.toFixed(3),
      low: +row.low.toFixed(3),
      high: +row.high.toFixed(3),
    });
  }
  if (!rows.length) return { dir, target: +qqqMovePct.toFixed(2), range: { lo: +lo.toFixed(2), hi: +hi.toFixed(2) }, period: '近2年', count: 0, samples: [] };
  const avg = arr => +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);
  const quantile = (arr, qv) => {
    const a = [...arr].sort((a, b) => a - b);
    const pos = Math.min(a.length - 1, Math.max(0, Math.round(qv * (a.length - 1))));
    return +a[pos].toFixed(2);
  };
  const closeP = rows.map(r => r.closePct);
  const lowP = rows.map(r => r.lowPct);
  const highP = rows.map(r => r.highPct);
  const samples = [...rows].sort((a, b) => Math.abs(a.qqqMove - qqqMovePct) - Math.abs(b.qqqMove - qqqMovePct)).slice(0, 5);
  return {
    dir,
    target: +qqqMovePct.toFixed(2),
    range: { lo: +lo.toFixed(2), hi: +hi.toFixed(2) },
    period: '近2年',
    count: rows.length,
    close: { avg: avg(closeP), median: quantile(closeP, 0.5), worst: Math.min(...closeP), best: Math.max(...closeP) },
    low: { avg: avg(lowP), median: quantile(lowP, 0.5), worst: Math.min(...lowP), best: Math.max(...lowP) },
    high: { avg: avg(highP), median: quantile(highP, 0.5), worst: Math.min(...highP), best: Math.max(...highP) },
    samples,
  };
}

// 主函数：buildPremarketPlan(ctx, lastPlan, opts)
//   ctx  = { quote, ind, klineLast, session, pos, ... }
//   lastPlan = 上一次生成的 plan（用于盘中微调对比、档位锁定）
//   opts   = { qqqPct, ixicPct, debugTime }
function buildPremarketPlan(ctx, lastPlan, opts = {}) {
  const { quote, ind, klineLast } = ctx;
  const BETA = 0.7;
  const qqqPct = opts.qqqPct != null && isFinite(opts.qqqPct) ? opts.qqqPct : null;
  const ixicPct = opts.ixicPct != null && isFinite(opts.ixicPct) ? opts.ixicPct : null;
  const qqqRegPct = opts.qqqRegPct != null && isFinite(opts.qqqRegPct) ? opts.qqqRegPct : null;
  const qqqPrePct = opts.qqqPrePct != null && isFinite(opts.qqqPrePct) ? opts.qqqPrePct : null;
  const ixicRegPct = opts.ixicRegPct != null && isFinite(opts.ixicRegPct) ? opts.ixicRegPct : null;
  const ixicPrePct = opts.ixicPrePct != null && isFinite(opts.ixicPrePct) ? opts.ixicPrePct : null;
  const mode = premarketMode(ctx, opts.debugTime, { qqqPct, ixicPct, qqqRegPct, ixicRegPct });
  const P0 = getBasePrevClose(ctx, mode);
  const generatedAt = new Date().toISOString();

  if (!P0) return null;

  // ── 1. 预期开盘涨跌幅（β折算）──

  const mix = (a, b) => (a != null && b != null) ? 0.6 * a + 0.4 * b : (a != null ? a : (b != null ? b : null));
  const anchorK = mode === 'live' && klineLast && klineLast.date === ctx.today ? ctx.klinePrev : klineLast;
  const anchorDate = anchorK && anchorK.date;
  const qqqUnpricedPct = unpricedUsMove(ctx.usIdx && ctx.usIdx.qqq, anchorDate, qqqRegPct, qqqPrePct, qqqPct, mode);
  const ixicUnpricedPct = unpricedUsMove(ctx.usIdx && ctx.usIdx.ixic, anchorDate, ixicRegPct, ixicPrePct, ixicPct, mode);
  const usPct = mix(qqqUnpricedPct, ixicUnpricedPct);
  const usPrePct = mix(qqqPrePct, ixicPrePct);
  const usRegPct = mix(qqqRegPct, ixicRegPct);
  const historyReview = buildPremarketHistoryReview(ctx.klines || [], ctx.usIdx, qqqRegPct, mode === 'next' ? null : ctx.today);
  const expectOpenPct = usPct == null ? 0 : Math.max(-5, Math.min(5, usPct * BETA));

  // ── 2. 技术锚点（换算成相对 P0 的涨跌幅）──
  const toPct = (v) => (isFinite(v) && v > 0) ? (v / P0 - 1) * 100 : null;
  const ma21Pct   = toPct(ind && ind.ma21);
  const bollUpPct = toPct(ind && ind.bollUp);
  const bollMidPct= toPct(ind && ind.bollMid);
  const bollDnPct = toPct(ind && ind.bollDn);
  const high20Pct = toPct(ind && ind.high20);
  const low20Pct  = toPct(ind && ind.low20);
  const premium   = quote && isFinite(quote.premiumPct) ? quote.premiumPct : null;
  const zone      = premiumZone(premium);

  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── 昨日真实波段（日内 T+0 的波动基准）──
  // 按模式选"昨日 K 线"：
  //  - 盘前（pre）：klineLast=昨日（今日 K 线未生成）
  //  - 盘中（live）：klinePrev=昨日（klineLast 已切到今日）
  //  - 盘后（closed）：klineLast=今日（明日视角"昨日"=今日）
  //  之前固定用 klineLast，盘中会拿今日 OHLC 当"昨日波段"，b2/b3 锚点失真。
  const hasTodayK = klineLast && klineLast.date === ctx.today;
  const yK = mode === 'live' && hasTodayK ? ctx.klinePrev : klineLast;
  const yO = yK && isFinite(yK.open)  ? yK.open  : null;
  const yH = yK && isFinite(yK.high)  ? yK.high  : null;
  const yL = yK && isFinite(yK.low)   ? yK.low   : null;
  const hasYesterday = !!(yO && yH && yL && yO > 0);
  // 昨日的前收基准（即"前日收盘"）：
  //  - 盘前/盘后：昨日=klineLast，前日=klinePrev
  //  - 盘中：昨日=klinePrev，前日=klinePrev2
  const yPrevK = mode === 'live' && hasTodayK ? ctx.klinePrev2 : ctx.klinePrev;
  const yBase = (yPrevK && isFinite(yPrevK.close) && yPrevK.close > 0) ? yPrevK.close : P0;
  const yOpenPct = hasYesterday ? (yO / yBase - 1) * 100 : null;
  const yHighPct = hasYesterday ? (yH / yBase - 1) * 100 : null;
  const yLowPct  = hasYesterday ? (yL / yBase - 1) * 100 : null;

  // ── 3. 低吸买点（5 档，相对 P0 的跌幅，均为负数）──
  //  思路：前三档围绕预期开盘/昨日波段，后两档围绕历史相似跌幅里的深水区。
  //  b1 = 预期开盘小幅回踩；b2 = 昨日开盘位；b3 = 昨日最低/历史均值深水区
  //  b4 = 历史偏极端盘中跌幅；b5 = 历史最差附近 / 极端恐慌预留
  let buyReasons = [];
  let b1, b2, b3, b4, b5;
  if (hasYesterday) {
    // b1: 预期开盘小幅回踩（轻仓试探）
    b1 = clip(expectOpenPct - 0.4, -9, -0.3);
    // b2: 昨日开盘位（如果昨日开盘比 b1 浅，则取 b1 - 0.3 保证阶梯）
    b2 = Math.max(Math.min(yOpenPct, b1 - 0.3), -9);
    // b3: 昨日最低位（如果昨日最低比 b2 浅，则取 b2 - 0.3 保证阶梯）
    b3 = Math.max(Math.min(yLowPct, b2 - 0.3), -9);
    b4 = b3 - 0.8;
    b5 = b4 - 0.8;
    // 大振幅日修正：昨日振幅 > 5% 说明处于恐慌/剧烈波动期，
    // 二次探底可能更深，b3 再往下压昨日振幅的 30%
    const yRange = (yH - yL) / yO * 100;
    if (yRange > 5) {
      const b3New = b3 - yRange * 0.3;
      buyReasons.push(`昨日振幅 ${yRange.toFixed(1)}%（>5%），b3 再压深 ${(yRange * 0.3).toFixed(2)}%`);
      b3 = Math.max(b3New, -9);
    }
    buyReasons.push(`昨日 开${yOpenPct.toFixed(2)}% / 低${yLowPct.toFixed(2)}% / 高${yHighPct.toFixed(2)}% / 振幅${((yH - yL) / yO * 100).toFixed(1)}%`);
  } else {
    b1 = usPct == null ? -1 : clip(expectOpenPct - 0.4, -9, -0.3);
    b2 = b1 - 1; b3 = b2 - 1.5; b4 = b3 - 1; b5 = b4 - 1;
  }
  // 盘外继续急跌时保留额外深水缓冲，正规盘跌幅已计入开盘基准。
  if (usPrePct != null && usPrePct <= -2.5) { b1 -= 1; b2 -= 1; b3 -= 1; b4 -= 1; b5 -= 1; buyReasons.push(`美股盘外 ${usPrePct.toFixed(2)}% ≤-2.5%，买点下移 1%`); }
  // 修正②：双段同向下跌（昨日盘中 + 今日盘前都跌）→ 二次探底压深
  //   场景：昨日盘中跌 X%、今日盘前继续跌 Y%，说明抛压在延续，今日可能击穿昨日最低
  //   压深幅度 = |昨日盘中跌幅| × 30%（昨日跌得越多，今日探底越深）
  //   例：昨日 -1.93% / 盘前 -0.95% → 压深 0.58%
  //       昨日 -3.50% / 盘前 -1.20% → 压深 1.05%
  if (usRegPct != null && usRegPct <= -0.5 && usPrePct != null && usPrePct <= -0.5) {
    const deepen = Math.abs(usRegPct) * 0.3;
    b1 -= deepen; b2 -= deepen; b3 -= deepen; b4 -= deepen; b5 -= deepen;
    buyReasons.push(`昨日盘中 ${usRegPct.toFixed(2)}% + 今日盘外 ${usPrePct.toFixed(2)}% 双段同向下跌，二次探底买点下移 ${deepen.toFixed(2)}%`);
  }
  if (historyReview && historyReview.dir === 'down' && historyReview.count >= 5 && historyReview.low) {
    const hMed = historyReview.low.median;
    const hAvg = historyReview.low.avg;
    const hWorst = historyReview.low.worst;
    if (isFinite(hMed) && isFinite(hAvg) && isFinite(hWorst)) {
      const histB1 = hMed - 0.3;
      const histB2 = hAvg - 0.3;
      const histB3 = Math.max(hWorst, hAvg - 2.0);
      const histB4 = Math.max(hWorst - 0.4, hAvg - 3.0);
      const histB5 = Math.max(hWorst - 1.0, -9);
      const old = [b1, b2, b3, b4, b5];
      b1 = Math.min(b1, histB1);
      b2 = Math.min(b2, histB2);
      b3 = Math.min(b3, histB3);
      b4 = Math.min(b4, histB4);
      b5 = Math.min(b5, histB5);
      if (b1 !== old[0] || b2 !== old[1] || b3 !== old[2] || b4 !== old[3] || b5 !== old[4]) {
        buyReasons.push(`近2年相似 QQQ 跌幅 ${historyReview.count} 次：次日盘中最大跌幅中位 ${hMed.toFixed(2)}% / 平均 ${hAvg.toFixed(2)}% / 最差 ${hWorst.toFixed(2)}%，据此校准低吸点`);
      }
    }
  }
  // 兜底保护阶梯（不强制 0.5 间距，让昨日最低位能体现出来）
  b1 = Math.max(Math.min(b1, -0.3), -9);
  b2 = Math.max(Math.min(b2, b1 - 0.2), -9);
  b3 = Math.max(Math.min(b3, b2 - 0.2), -9);
  b4 = Math.max(Math.min(b4, b3 - 0.2), -9.5);
  b5 = Math.max(Math.min(b5, b4 - 0.2), -10);

  const scaledPos = [20, 30, 50, 75, 100];

  const buyLabels = hasYesterday
    ? [`预期开盘小幅回踩`, `昨日开盘位（${yOpenPct.toFixed(2)}%）`, `昨日最低（${yLowPct.toFixed(2)}%）`, '历史相似深水区', '极端恐慌预留']
    : ['固定档位（数据缺失）', '固定档位', '固定档位', '深水预留', '极端预留'];
  const buy = [
    { key: 'b1', pct: +b1.toFixed(2), pos: scaledPos[0], reason: buyLabels[0] },
    { key: 'b2', pct: +b2.toFixed(2), pos: scaledPos[1], reason: buyLabels[1] },
    { key: 'b3', pct: +b3.toFixed(2), pos: scaledPos[2], reason: buyLabels[2] },
    { key: 'b4', pct: +b4.toFixed(2), pos: scaledPos[3], reason: buyLabels[3] },
    { key: 'b5', pct: +b5.toFixed(2), pos: scaledPos[4], reason: buyLabels[4] },
  ];

  const actualOpenPct = mode === 'live' && quote && quote.quoteDate === ctx.today && quote.open > 0
    ? (quote.open / P0 - 1) * 100 : null;
  const sellAnchorPct = actualOpenPct == null ? expectOpenPct : actualOpenPct;
  const sellAnchor = actualOpenPct != null ? '实际开盘' : usPct == null ? '基准昨收（预测输入缺失）' : '预期开盘';
  const s1 = clip((1 + sellAnchorPct / 100) * 1.005 * 100 - 100, -9, 9);
  const s2 = clip((1 + sellAnchorPct / 100) * 1.01 * 100 - 100, s1 + 0.2, 9.5);
  const held = !!(ctx.pos && ctx.pos.shares > 0);
  const sell = [
    { key: 's1', pct: +s1.toFixed(2), pos: 50, reason: `${sellAnchor}价反弹 0.5%，仅为减仓观察价` },
    { key: 's2', pct: +s2.toFixed(2), pos: 100, reason: `${sellAnchor}价反弹 1.0%，仍需转弱确认` },
  ];

  // ── 5. 失效条件（日内 T+0，不含溢价项）──
  const stop = {
    pricePct: +(b5 - 1.0).toFixed(2),
    qqqAbort: -3.5,
    note: '14:30 后不再开新仓',
  };

  const adjustments = (lastPlan && Array.isArray(lastPlan.adjustments)) ? [...lastPlan.adjustments] : [];
  const touched = (lastPlan && lastPlan.touched) ? { ...lastPlan.touched } : {};
  if (mode === 'live' && lastPlan && Array.isArray(lastPlan.buy) && Array.isArray(lastPlan.sell)) {
    for (const b of buy) {
      const orig = lastPlan.buy.find(x => x.key === b.key);
      if (orig && touched[b.key]) b.pct = orig.pct;
    }
    for (const s of sell) {
      const orig = lastPlan.sell.find(x => x.key === s.key);
      if (orig && touched[s.key]) s.pct = orig.pct;
    }
  }
  if (actualOpenPct != null && usPct != null) {
    const dev = actualOpenPct - expectOpenPct;
    if (Math.abs(dev) >= 1.5) {
      const shift = dev * 0.6;
      for (const b of buy) if (!touched[b.key]) b.pct = Math.max(-10, Math.min(-0.3, +(b.pct + shift).toFixed(2)));
      if (!touched._openDevLogged) adjustments.push({ at: generatedAt, trigger: `开盘偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%`, delta: `未触达买档校准 ${shift >= 0 ? '+' : ''}${shift.toFixed(2)}%，卖档以实际开盘为基准` });
    }
    touched._openDevLogged = true;
  }

  if (!touched.s2) sell[1].pct = +Math.max(sell[1].pct, sell[0].pct + 0.2).toFixed(2);
  if (!touched.s1 && touched.s2) sell[0].pct = +Math.min(sell[0].pct, sell[1].pct - 0.2).toFixed(2);
  stop.pricePct = +(buy[buy.length - 1].pct - 1).toFixed(2);
  const touches = lastPlan && Array.isArray(lastPlan.touches) ? [...lastPlan.touches] : [];
  const quoteMinute = quote && (quote.quoteTime || '').slice(11, 16);
  const minuteTail = ctx.intraday && ctx.intraday.date === ctx.today && ctx.intraday.points[ctx.intraday.points.length - 1];
  const tradingNow = ctx.session && ctx.session.trading && quote.quoteDate === ctx.today && isEtfContinuousMinute(quoteMinute) && minuteTail
    && Math.abs(etfMinuteNumber(quoteMinute) - etfMinuteNumber(minuteTail.t)) <= 2;
  if (mode === 'live' && tradingNow && quote && quote.price > 0) {
    const curPct = (quote.price / P0 - 1) * 100;
    const time = (quote.quoteTime || '').slice(11, 16);
    for (const [side, levels] of [['buy', buy], ['sell', sell]]) {
      for (const level of levels) {
        const reached = side === 'buy' ? curPct <= level.pct : curPct >= level.pct;
        if (!touched[level.key] && reached) {
          touched[level.key] = true;
          touches.push({ key: level.key, side, time, price: quote.price, target: +(P0 * (1 + level.pct / 100)).toFixed(3) });
          adjustments.push({ at: generatedAt, trigger: `${level.key.toUpperCase()} 档位触达`, delta: '锁定参考价位，不代表已成交' });
        }
      }
    }
  }

  // ── 7. 生成逻辑一句话 ──
  const fmtPct = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const logicParts = [];
  // 分段展示：昨日盘中 / 今日盘前 / 累计
  //   不再叠加显示为一个数——两段同向下跌是独立的恐慌信号，分开展示用户才能直观看到
  const hasSeg = (qqqRegPct != null && qqqPrePct != null) || (ixicRegPct != null && ixicPrePct != null);
  if (hasSeg) {
    const seg = [];
    if (qqqRegPct != null && qqqPrePct != null) {
      seg.push(`QQQ 昨日盘中 ${fmtPct(qqqRegPct)} / 今日盘前 ${fmtPct(qqqPrePct)}`);
    }
    if (ixicRegPct != null && ixicPrePct != null) {
      seg.push(`IXIC 昨日盘中 ${fmtPct(ixicRegPct)} / 今日盘前 ${fmtPct(ixicPrePct)}`);
    }
    logicParts.push(seg.join(' · '));
    logicParts.push(`相对 ETF 基准日 ${anchorDate || '未知'} 尚未消化的美股累计 ${fmtPct(usPct)} × β${BETA} → 预期开盘 ${fmtPct(expectOpenPct)}`);
  } else if (qqqPct != null || ixicPct != null) {
    logicParts.push(`昨夜 QQQ ${fmtPct(qqqPct)} / IXIC ${fmtPct(ixicPct)} × β${BETA} → 预期开盘 ${fmtPct(expectOpenPct)}`);
  } else if (qqqRegPct != null || ixicRegPct != null) {
    logicParts.push(`美股正规盘 QQQ ${fmtPct(qqqRegPct)} / IXIC ${fmtPct(ixicRegPct)} × β${BETA} → 预期开盘 ${fmtPct(expectOpenPct)}`);
  } else {
    logicParts.push('美股数据缺失，按预期开盘 0% 处理');
  }
  logicParts.push(`${sellAnchor} ${fmtPct(sellAnchorPct)} → 反弹减仓参考档位，不要求回到昨收`);
  if (historyReview && historyReview.dir === 'down' && historyReview.count < 5) logicParts.push(`相似历史仅 ${historyReview.count} 个独立 ETF 交易日，样本不足，不按历史均值自动校准`);
  if (usPct == null) logicParts.push('缺少未消化美股输入，开盘0%仅为数据缺失占位，不是中性预测');
  if (premium != null) logicParts.push(`当前溢价 ${premium.toFixed(1)}%（${zone.label}）`);
  if (buyReasons.length) logicParts.push(buyReasons.join('；'));
  const logic = logicParts.join(' · ');
  // 结构化输出：供前端按行排版（原因逐条拆开，避免一整段" · "串读不动）
  const logicLines = buyReasons.length ? [...logicParts.slice(0, -1), ...buyReasons] : [...logicParts];

  return {
    mode,
    generatedAt,
    basePrevClose: +P0.toFixed(3),
    expectOpenPct: usPct == null ? null : +expectOpenPct.toFixed(2),
    inputs: {
      anchorDate, qqqUnpricedPct, ixicUnpricedPct, sellAnchorPct, sellAnchor,
      qqqPct: qqqPct != null ? +qqqPct.toFixed(2) : null,
      ixicPct: ixicPct != null ? +ixicPct.toFixed(2) : null,
      // 分段口径：昨日盘中 vs 今日盘前，分开展示不叠加
      qqqRegPct: qqqRegPct != null ? +qqqRegPct.toFixed(2) : null,
      qqqPrePct: qqqPrePct != null ? +qqqPrePct.toFixed(2) : null,
      ixicRegPct: ixicRegPct != null ? +ixicRegPct.toFixed(2) : null,
      ixicPrePct: ixicPrePct != null ? +ixicPrePct.toFixed(2) : null,
      usRegPct: usRegPct != null ? +usRegPct.toFixed(2) : null,
      premium: premium != null ? +premium.toFixed(2) : null,
      ma21: ind && ind.ma21, bollUp: ind && ind.bollUp, bollDn: ind && ind.bollDn,
      high20: ind && ind.high20, low20: ind && ind.low20,
    },
    buy: buy.map(b => ({ ...b, price: +(P0 * (1 + b.pct / 100)).toFixed(3) })),
    sell: sell.map(s => ({ ...s, price: +(P0 * (1 + s.pct / 100)).toFixed(3) })),
    stop, touched, touches, adjustments,
    signalEvents: lastPlan && lastPlan.signalEvents || [],
    held,
    historyReview,
    logic,
    logicLines,
  };
}

function buildEtfIntradayBands(points) {
  const recent = [];
  const round = v => +v.toFixed(3);
  return points.map(p => {
    if (recent.length && etfMinuteNumber(p.t) - etfMinuteNumber(recent[recent.length - 1].t) !== 1) recent.length = 0;
    recent.push(p);
    if (recent.length > 30) recent.shift();
    const lowIndex = recent.reduce((best, r, i) => r.price <= recent[best].price ? i : best, 0);
    const low = recent[lowIndex];
    const high = recent.slice(lowIndex).reduce((best, r) => r.price >= best.price ? r : best, low);
    const windowRange = (Math.max(...recent.map(r => r.price)) / low.price - 1) * 100;
    const halfWidthPct = Math.max(0.15, Math.min(0.6, windowRange * 0.25));
    const prev = recent[recent.length - 2], prev2 = recent[recent.length - 3];
    // ── 结构位（全部截至当前分钟，无未来函数）：分时均价 / 当日开盘 / 已确认摆动低点 ──
    const vwap = p.avg > 0 ? p.avg : null;
    const dayOpen = points[0].price;
    const swingLows = [], swingHighs = [];
    for (let j = 2; j <= recent.length - 3; j++) {
      const w = recent;
      if (w[j].price <= w[j - 1].price && w[j].price <= w[j - 2].price && w[j].price <= w[j + 1].price && w[j].price <= w[j + 2].price) swingLows.push(w[j].price);
      if (w[j].price >= w[j - 1].price && w[j].price >= w[j - 2].price && w[j].price >= w[j + 1].price && w[j].price >= w[j + 2].price) swingHighs.push(w[j].price);
    }
    const swingLow = swingLows.length ? swingLows.at(-1) : null;
    const swingHigh = swingHighs.length ? swingHighs.at(-1) : null;
    const buyCands = [[vwap, 'vwap'], [dayOpen, 'open'], [swingLow, 'swingLow']].filter(([v]) => v != null && v > 0);
    // 低吸挂单价：现价下方 ≥0.3% 的最高结构位（保证挂单有真实回落空间，不再贴脸）
    let lowLevel = null, lowAnchor = null;
    for (const [v, a] of buyCands) if (p.price / v - 1 >= 0.003 && (lowLevel == null || v > lowLevel)) { lowLevel = v; lowAnchor = a; }
    // 空间不足时给出最近下方结构位作为「等回落到」目标
    let lowWait = null, lowWaitAnchor = null;
    for (const [v, a] of buyCands) if (p.price > v && (lowWait == null || v > lowWait)) { lowWait = v; lowWaitAnchor = a; }
    // 高抛参考价：现价上方 ≥0.2% 的最近结构位（反弹到阻力即减仓参考）
    const sellCands = [[vwap, 'vwap'], [dayOpen, 'open'], [swingHigh, 'swingHigh']].filter(([v]) => v != null && v > 0);
    let highLevel = null, highAnchor = null;
    for (const [v, a] of sellCands) if (v / p.price - 1 >= 0.002 && (highLevel == null || v < highLevel)) { highLevel = v; highAnchor = a; }
    const enough = recent.length >= 3;
    return { time: p.t, from: recent[0].t, low: low.price, lowTime: low.t, high: high.price, highTime: high.t,
      reboundPct: (p.price / low.price - 1) * 100, swingPct: (high.price / low.price - 1) * 100,
      pullbackPct: (high.price / p.price - 1) * 100, halfWidthPct,
      rising: !!(prev2 && p.price > prev.price && prev.price > prev2.price),
      falling: !!(prev2 && p.price < prev.price && prev.price < prev2.price),
      lowBand: enough && lowLevel != null ? { low: round(lowLevel), high: round(lowLevel * 1.003),
        anchor: lowAnchor, spacePct: +(((p.price / lowLevel) - 1) * 100).toFixed(2) } : null,
      lowWait: enough && lowLevel == null && lowWait != null ? { price: round(lowWait), anchor: lowWaitAnchor } : null,
      highBand: enough && highLevel != null ? { low: round(highLevel), high: round(highLevel * (1 + halfWidthPct / 100)),
        anchor: highAnchor, spacePct: +(((highLevel / p.price) - 1) * 100).toFixed(2) } : null,
      highHold: enough && highLevel == null };
  });
}

function buildEtfIntradayGuide(ctx, points, events, actionable, bands) {
  const reference = bands[bands.length - 1];
  if (!reference || (!reference.lowBand && !reference.lowWait && !reference.highBand && !reference.highHold)) return null;
  const last = points[points.length - 1];
  // 当日已见低点：跌破它才算"低点失守"，用作深档观察位，而不是提前挂单等成交
  const dayLowPoint = points.reduce((best, p) => p.price <= best.price ? p : best, points[0]);
  const { lowBand, highBand } = reference;
  const quote = ctx.quote || {};
  const time = (quote.quoteTime || '').slice(11, 16);
  const anchorLabel = { vwap: '分时均价', open: '当日开盘价', swingLow: '摆动低点', swingHigh: '摆动高点' };
  const stopPrice = lowBand ? +(lowBand.low * 0.995).toFixed(3) : null;
  let buyBlock = '';
  if (!actionable) buyBlock = '非实时交易状态，仅回看参考价，不生成当前买入指令。';
  else if (time >= '14:30') buyBlock = '14:30 后停止新增仓位。';
  else if (!ctx.positionPlan || !['heavy', 'try'].includes(ctx.positionPlan.tier)) buyBlock = '当前趋势不允许加仓，低吸价仅观察。';
  else if (ctx.premarket && ctx.premarket.inputs.qqqPrePct != null && ctx.premarket.inputs.qqqPrePct <= ctx.premarket.stop.qqqAbort) buyBlock = 'QQQ 已触发日内计划作废条件。';
  else if (ctx.premarket && quote.prevClose > 0 && (quote.price / quote.prevClose - 1) * 100 <= ctx.premarket.stop.pricePct) buyBlock = '价格已跌破日内计划失效线，不新增仓位。';
  const latest = [...events].reverse().find(e => etfMinuteNumber(last.t) - etfMinuteNumber(e.time) >= 0 && etfMinuteNumber(last.t) - etfMinuteNumber(e.time) <= 1);
  let buyState = '等待回落', buyNote = lowBand
    ? `可在 ${lowBand.low.toFixed(3)}（${anchorLabel[lowBand.anchor] || lowBand.anchor}）挂单等待；触价不等于买入，需止跌确认。跌破 ${stopPrice.toFixed(3)}（-0.5%）视为接飞刀，放弃该笔。`
    : reference.lowWait
      ? `回落空间不足 0.3%，等回落到 ${reference.lowWait.price.toFixed(3)}（${anchorLabel[reference.lowWait.anchor] || reference.lowWait.anchor}）再评估。`
      : '现价低于全部分时均价与开盘价，等止跌企稳后再评估，不接飞刀。';
  if (!lowBand && !reference.lowWait) buyState = '低于结构位 · 等企稳';
  if (buyBlock) { buyState = '低吸仅观察'; buyNote = buyBlock; }
  else if (latest && latest.side === 'buy') { buyState = '止跌确认 · 小仓候选'; buyNote = `确认分钟 ${latest.time}，仍按总仓位上限分批执行，不追涨。`; }
  else if (lowBand && last.price <= lowBand.high) { buyState = '低吸区内 · 等止跌'; buyNote = `已触及 ${lowBand.low.toFixed(3)} 结构位，还需两分钟回升与至少0.3%反弹确认；继续创新低不接飞刀，跌破 ${stopPrice.toFixed(3)} 止损。`; }
  const buyMissing = [];
  const weak = (quote.prevClose > 0 && reference.low <= quote.prevClose * 0.995) || (last.avg > 0 && reference.low <= last.avg * 0.997);
  if (!weak) buyMissing.push('需先出现有效回踩');
  if (reference.reboundPct < 0.3) buyMissing.push(`反弹还差 ${(0.3 - reference.reboundPct).toFixed(2)}%`);
  if (!reference.rising) buyMissing.push('尚未连续两分钟回升');
  if (!buyBlock && !(latest && latest.side === 'buy') && buyMissing.length && lowBand) buyNote = buyMissing.join('；') + '。触价不直接买入。';
  const sellMissing = [];
  if (reference.swingPct < 0.6) sellMissing.push(`反弹幅度还差 ${(0.6 - reference.swingPct).toFixed(2)}%`);
  if (reference.pullbackPct < 0.25) sellMissing.push(`从高点回落还差 ${(0.25 - reference.pullbackPct).toFixed(2)}%`);
  if (!reference.falling) sellMissing.push('尚未连续两分钟转弱');
  let sellState = '等待反弹', sellNote;
  if (highBand) sellNote = `反弹到 ${highBand.low.toFixed(3)}（${anchorLabel[highBand.anchor] || highBand.anchor}，距现价 ${highBand.spacePct.toFixed(2)}%）附近考虑分批减仓；需转弱确认，不因触价自动卖出。`;
  else if (reference.highHold) { sellState = '上方无阻力 · 持有观察'; sellNote = '现价不低于任何结构位，上方暂无阻力参考；强势持有观察，等转弱信号。'; }
  else { sellState = '均价待确认'; sellNote = '分时均价不可用，暂不判断高抛参考价。'; }
  if (!actionable) { sellState = '反弹参考回看'; sellNote = '已收盘或行情不实时，仅展示参考价；历史卖点不补发通知。'; }
  else if (highBand && reference.high < highBand.low && reference.swingPct >= 0.6) sellMissing.push(`反弹高点距参考价还差 ${((highBand.low / reference.high - 1) * 100).toFixed(2)}%`);
  else if (!highBand && reference.highHold) { sellMissing.length = 0; }
  else if (!highBand) { sellState = '均价待确认'; sellNote = '分时均价不可用，暂不判断高抛参考价。'; }
  else if (latest && latest.side === 'sell') { sellState = latest.risk ? '持续走弱 · 减仓预警' : '反弹转弱 · 减仓候选'; sellNote = `确认分钟 ${latest.time}；仅适用于已有仓位，不等于必须卖出或已成交。`; }
  else if (last.price >= highBand.low && last.price <= highBand.high) { sellState = '阻力区内 · 等转弱'; sellNote = '已反弹到结构位附近，反弹仍强时不提前卖；等待回落幅度和连续两分钟转弱确认。'; }
  if (actionable && highBand && !(latest && latest.side === 'sell') && sellMissing.length) sellNote = sellMissing.join('；') + '。仅供已有仓位分批减仓参考。';
  return { asOf: last.t, from: reference.from, lowBand, highBand, lowWait: reference.lowWait, highHold: reference.highHold,
    stopPrice, buyState, buyNote, sellState, sellNote,
    dayLow: { price: dayLowPoint.price, time: dayLowPoint.t },
    buyMissing, sellMissing, halfWidthPct: reference.halfWidthPct,
    note: '参考价为结构位挂单参考：低吸=现价下方≥0.3%的最高结构位（分时均价/开盘价/摆动低点），高抛=现价上方≥0.2%的最近结构位。回测（41个交易日）显示机械「触低吸买→触高抛卖」为负期望，触价不等于成交，须配合止跌/转弱确认与止损（低吸价-0.5%）。' };
}

function buildEtfIntradayStrength(points, date) {
  const recent = [], history = [], events = [];
  let lastAlert = -Infinity, lastLevel = 0, armed = true;
  for (const p of points) {
    if (recent.length && etfMinuteNumber(p.t) - etfMinuteNumber(recent[recent.length - 1].t) !== 1) {
      recent.length = 0; armed = true; lastLevel = 0;
    }
    recent.push(p);
    if (recent.length > 12) recent.shift();
    const tail = recent.slice(-3);
    const enough = recent.length >= 5 && recent.slice(-5).every(r => r.avg > 0);
    const move = enough ? (p.price / recent[recent.length - 5].price - 1) * 100 : null;
    const under = enough && tail.every(r => r.price <= r.avg * 0.997);
    const above = enough && tail.every(r => r.price >= r.avg * 1.001);
    const avgGap = p.avg > 0 ? (p.price / p.avg - 1) * 100 : null;
    const supportRows = recent.slice(0, -2);
    const support = supportRows.length >= 5 ? Math.min(...supportRows.map(r => r.price)) : null;
    const brokenSupport = under && support != null && tail.slice(-2).every(r => r.price < support * 0.999);
    const broken = under && (move <= -0.8 || brokenSupport);
    const weakening = under && move <= -0.3;
    const kind = !enough ? 'insufficient' : broken ? 'broken' : under ? 'weak' : above && move >= 0.15 ? 'strong' : 'neutral';
    const label = { insufficient: '待连续数据', broken: '破位 · 禁止追涨', weak: '偏弱 · 禁止追涨', strong: '偏强 · 等回踩', neutral: '震荡 · 不追涨' }[kind];
    history.push({ time: p.t, price: p.price, kind, label, move4: move, avgGap, support });
    if (enough && tail.every(r => r.price >= r.avg)) { armed = true; lastLevel = 0; }
    const level = broken ? 2 : weakening ? 1 : 0;
    const minute = etfMinuteNumber(p.t);
    if (level && (armed || level > lastLevel) && (minute - lastAlert >= 10 || level > lastLevel)) {
      events.push({ key: `intraday_weak_${date}_${p.t}_${level}`, time: p.t, price: p.price, side: 'sell', risk: kind,
        level: broken ? 'danger' : 'warn', title: broken ? 'ETF 破位 · 已有仓位减仓预警' : 'ETF 持续走弱 · 已有仓位减仓预警',
        text: `连续3分钟低于各自分时均价至少0.3%，近4分钟 ${move.toFixed(2)}%${brokenSupport ? `；连续2分钟跌破此前支撑 ${support.toFixed(3)}` : ''}。无需先反弹才预警；停止追买，已有仓位考虑分批减仓。所标 ${p.price.toFixed(3)} 为确认分钟价，下一分钟才可提示，不保证成交或避免亏损。` });
      lastAlert = minute; lastLevel = level; armed = false;
    }
  }
  return { current: history[history.length - 1] || null, history, events,
    note: '偏强只表示ETF短线走势，不代表允许追买；均价下方持续走弱或支撑破位独立预警，阈值未经盈利验证。' };
}

// ── 追涨闸门：把「现在这个价能不能追」变成一句可执行的结论 ──
//  回测依据（159509，2026-09-04~11-09，41 个交易日、5 分钟粒度、逐 bar 判定）：
//    同时满足「开盘涨幅 ≤ 0.8% + 现价站上分时均价 + 偏离均价 ≤ 0.6%」的时点，
//    追入后持有到收盘平均 +0.40%、胜率 63%（331 个样本 bar / 26 天）；
//    被其中任一条否决的时点平均 -0.09%、胜率 46%（1046 个样本 bar / 41 天）。
//    单独用「高开幅度」判定区分度很弱（允许 0.11% vs 拦截 -0.09%），
//    「距日内高点回落」作为拦截条件甚至是负贡献（+0.30%），所以都不单独使用。
//  这里只判盘中结构，溢价/趋势风控已在 guide 与 chase 文案里，避免长期高溢价把结论钉死成永远不能买。
function buildEtfChaseGate(ctx, points, current, actionable) {
  if (!Array.isArray(points) || !points.length) return null;   // 停牌/无成交分时：不出闸门结论
  const quote = ctx.quote || {};
  const last = points[points.length - 1];
  const prevClose = quote.prevClose > 0 ? quote.prevClose : null;
  const open = quote.open > 0 ? quote.open : points[0].price;
  const openPct = prevClose ? (open / prevClose - 1) * 100 : null;
  const avgGap = last.avg > 0 ? (last.price / last.avg - 1) * 100 : null;
  const span = etfMinuteNumber(last.t) - etfMinuteNumber(points[0].t);
  const premium = Number.isFinite(quote.premiumPct) ? quote.premiumPct : null;
  const kind = current && current.kind;
  const metrics = { open, openPct, avg: last.avg, price: last.price, avgGap, span, premium, kind: kind || null };
  const gate = (level, label, reason, fix) => ({ level, label, reason, fix, metrics, asOf: last.t });
  if (!actionable) {
    // 收盘/非实时：不产生当前指令，但把当日复盘结论留在这里，避免卡片变成一句空话。
    // 回放口径与盘中闸门一致（高开≤0.8% + 站上均价 + 偏离≤0.6%），只是逐分钟数一遍。
    let firstAllow = null, allowMinutes = 0;
    const baseMin = etfMinuteNumber(points[0].t);
    for (const p of points) {
      if (!(p.avg > 0) || p.t >= '14:30') continue;
      if (etfMinuteNumber(p.t) - baseMin < 15) continue;
      const gap = (p.price / p.avg - 1) * 100;
      if ((openPct != null && openPct > 0.8) || gap < 0 || gap > 0.6) continue;
      allowMinutes++;
      if (!firstAllow) firstAllow = { t: p.t, price: p.price };
    }
    const openToClose = open > 0 ? (last.price / open - 1) * 100 : null;
    const tail = openToClose == null ? '' : `开盘买入持有到收盘 ${openToClose >= 0 ? '+' : ''}${openToClose.toFixed(2)}%。`;
    if (!firstAllow) {
      const why = openPct != null && openPct > 0.8
        ? `今天开盘高开 +${openPct.toFixed(2)}%，超过 0.8% 追涨上限，全天没有出现可追时点。`
        : '今天现价全天没站稳分时均价上方，或偏离均价过远，没有出现可追时点。';
      return gate('closed', '今天全天不该追', why + tail, '下一个交易日开盘满 15 分钟后再看这张卡。');
    }
    const after = firstAllow.price > 0 ? (last.price / firstAllow.price - 1) * 100 : null;
    return gate('closed', '今天出现过可追时点',
      `全天 ${allowMinutes} 分钟符合条件，最早在 ${firstAllow.t}（${firstAllow.price.toFixed(3)}），从该时点持有到收盘 ${after == null ? '—' : (after >= 0 ? '+' : '') + after.toFixed(2) + '%'}。`,
      '收盘后仅供复盘，不构成当前指令。');
  }
  if (last.t >= '14:30') return gate('block', '现在不能追', '14:30 后停止新增仓位，尾盘追入要承担隔夜缺口。', '等下一个交易日开盘 15 分钟的结构确认。');
  if (openPct != null && openPct > 0.8) {
    return gate('block', '现在不能追', `今天开盘已高开 +${openPct.toFixed(2)}%（超过 0.8%），此刻追入是在替隔夜盘抬轿。`,
      `等回落到分时均价 ${last.avg.toFixed(3)} 附近重新站稳再评估。`);
  }
  if (['weak', 'broken'].includes(kind)) {
    return gate('block', '现在不能追', `ETF 自身${kind === 'broken' ? '破位' : '持续偏弱'}，走势与美股隔夜涨跌无关。`,
      '等连续几分钟站回分时均价、强弱翻正再看。');
  }
  if (avgGap != null && avgGap < 0) {
    return gate('block', '现在不能追', `现价 ${last.price.toFixed(3)} 已低于分时均价 ${last.avg.toFixed(3)}（${avgGap.toFixed(2)}%），今天买入的人整体在浮亏。`,
      '等重新站上分时均价，不在均价下方接。');
  }
  if (avgGap != null && avgGap > 0.6) {
    return gate('block', '现在不能追', `现价已高出分时均价 ${avgGap.toFixed(2)}%，追进去的成本明显高于今天平均水平。`,
      `等回踩均价 ${last.avg.toFixed(3)} 附近、且回踩不破再考虑。`);
  }
  if (span < 15) {
    return gate('wait', '观察 · 先别追', `开盘才 ${Math.max(0, span)} 分钟，分时结构还没成形。`,
      '等开盘满 15 分钟：不高开、站上均价、未过度偏离再决定。');
  }
  return gate('allow', '结构允许 · 小仓试', `高开 ${openPct == null ? '—' : '+' + openPct.toFixed(2) + '%'}，现价站上均价 ${last.avg.toFixed(3)}（${avgGap.toFixed(2)}%）。`,
    '仍按总仓位上限分批，跌破分时均价立刻退出。');
}

function buildEtfIntradaySignals(ctx) {
  const d = ctx.intraday;
  const quote = ctx.quote || {};
  const result = { date: d && d.date, events: [], actionable: false, note: '分时数据不足，暂不生成日内确认信号。' };
  if (!d || d.date !== ctx.today || !Array.isArray(d.points)) return result;
  const time = (quote.quoteTime || '').slice(11, 16);
  const points = d.points.filter(p => isEtfContinuousMinute(p.t) && p.t <= time && (!(ctx.session && ctx.session.trading) || p.t < time) && p.price > 0 && p.volume > 0);
  if (!points.length) {
    // 停牌（溢价风险警示常开盘停到 10:30）或集合竞价未成交：分时全为 volume=0，过滤后为空。
    // 此前会带着空 points 走到 buildEtfChaseGate 读 points[0] 抛异常，拖垮整个 /api/etf-track，
    // premarket/intradaySignals 全部消失、前端永远停在"数据加载中"。这里提前返回空信号。
    if (ctx.session && ctx.session.trading) result.note = '分时无成交（可能停牌或尚未开盘），暂不生成日内信号；停牌时段价格冻结在昨收，不据此判断涨跌。';
    return result;
  }
  result.asOf = points.length ? points[points.length - 1].t : null;
  const quoteAt = Date.parse((quote.quoteTime || '').replace(' ', 'T') + '+08:00');
  const now = ctx.now == null ? Date.now() : ctx.now;
  result.actionable = !!(!ctx.stale && ctx.session && ctx.session.trading && quote.quoteDate === ctx.today && isEtfContinuousMinute(time)
    && Number.isFinite(quoteAt) && now - quoteAt <= 90000 && quoteAt <= now + 5000
    && result.asOf && Math.abs(etfMinuteNumber(time) - etfMinuteNumber(result.asOf)) <= 2);
  result.note = '仅按已闭合分钟确认，所标时间为确认分钟，下一分钟才能实时提示；低吸需止跌，高抛需反弹转弱。回放不代表实际成交，非实时信号不追认买入；溢价仅供参考。';
  result.bands = buildEtfIntradayBands(points);
  result.strength = buildEtfIntradayStrength(points, d.date);
  let reboundArmed = true, priorLowTime = null, lastReboundMin = -Infinity, lastSellMin = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], reference = result.bands[i];
    const min = etfMinuteNumber(p.t);
    if (reference.lowTime !== priorLowTime) reboundArmed = true;
    priorLowTime = reference.lowTime;
    if (!reference.lowBand && !reference.lowWait && !reference.highBand && !reference.highHold) continue;
    const { rising, falling } = reference;
    const offLow = reference.reboundPct, offHigh = reference.pullbackPct, range = reference.swingPct;
    const weak = (quote.prevClose > 0 && reference.low <= quote.prevClose * 0.995) || (p.avg > 0 && reference.low <= p.avg * 0.997);
    const nearAvg = reference.highBand && reference.high >= reference.highBand.low;
    if (reboundArmed && min - lastReboundMin >= 10 && rising && weak && offLow >= 0.3 && p.t < '14:30') {
      const liveSignal = result.actionable && min >= etfMinuteNumber(time) - 2;
      const weakNow = ['weak', 'broken'].includes(result.strength.history[i].kind);
      const buyAllowed = liveSignal && !weakNow && time < '14:30'
        && ctx.positionPlan && ['heavy', 'try'].includes(ctx.positionPlan.tier)
        && !(ctx.premarket && ctx.premarket.inputs.qqqPrePct != null && ctx.premarket.inputs.qqqPrePct <= ctx.premarket.stop.qqqAbort)
        && !(ctx.premarket && quote.prevClose > 0 && (p.price / quote.prevClose - 1) * 100 <= ctx.premarket.stop.pricePct);
      result.events.push({ key: `intraday_rebound_${d.date}_${p.t}`, time: p.t, price: p.price, side: buyAllowed ? 'buy' : 'watch',
        level: buyAllowed ? 'good' : 'info', title: buyAllowed ? '日内止跌 · 小仓候选' : '日内止跌观察 · 不自动买入',
        text: `自近30分钟低位 ${reference.low.toFixed(3)} 反弹 ${offLow.toFixed(2)}%，连续两分钟回升。${buyAllowed ? '实时风控允许，仍按总仓位上限执行，不追涨；溢价仅供参考。' : '仅作走势观察，时段、趋势或实时风控未确认，不追认买入。'}` });
      lastReboundMin = min; reboundArmed = false;
    } else if (min - lastSellMin >= 10 && falling && range >= 0.6 && offHigh >= 0.25 && nearAvg && reference.highTime > reference.lowTime) {
      result.events.push({ key: `intraday_pullback_${d.date}_${p.t}`, time: p.t, price: p.price, side: 'sell', level: 'warn',
        title: '反弹转弱 · 已有仓位减仓候选',
        text: `已知反弹幅度 ${range.toFixed(2)}%，从近30分钟反弹高位 ${reference.high.toFixed(3)} 回落 ${offHigh.toFixed(2)}%，连续两分钟转弱且接近分时均价 ${p.avg.toFixed(3)}。卖点不要求相对昨收翻红；仅供已有仓位分批减仓参考。` });
      lastSellMin = min; reboundArmed = true;
    }
  }
  result.events.push(...result.strength.events);
  result.events.sort((a, b) => a.time.localeCompare(b.time));
  result.guide = buildEtfIntradayGuide(ctx, points, result.events, result.actionable, result.bands);
  result.chaseGate = buildEtfChaseGate(ctx, points, result.strength.current, result.actionable);
  // 交易时段内但行情没跟上：不能把「今天全天不该追」这种收盘复盘结论挂到盘中卡片上
  if (result.chaseGate && !result.actionable && ctx.session && ctx.session.trading && quote.quoteDate === ctx.today) {
    const delaySec = Number.isFinite(quoteAt) ? Math.max(0, Math.round((now - quoteAt) / 1000)) : null;
    result.chaseGate = { ...result.chaseGate, level: 'wait', label: '行情延迟 · 暂不判定',
      reason: `行情${delaySec == null ? '还没跟上' : `滞后约 ${delaySec >= 60 ? Math.floor(delaySec / 60) + ' 分' : delaySec + ' 秒'}`}，此刻的涨幅与均价不是最新状态，不据此给追买结论。`,
      fix: '等行情恢复实时后自动刷新；延迟期间的买卖价只作挂单参考，不构成成交指令。' };
  }
  const strength = result.strength.current;
  if (result.guide && strength) {
    if (result.actionable && ['weak', 'broken'].includes(strength.kind)) {
      result.guide.buyState = '走弱 · 禁止追买';
      result.guide.buyNote = strength.label + '，不因外盘上涨接跌或追涨；等ETF自身恢复再检查趋势与价格风控。';
    }
    result.strength.chase = !result.actionable ? '非实时 · 仅回看'
      : time >= '14:30' ? '14:30 后不新增仓位'
      : !ctx.positionPlan || !['heavy', 'try'].includes(ctx.positionPlan.tier) ? '趋势风控不允许新增买入'
      : strength.kind === 'strong' ? '偏强也不直接追涨，等回踩确认' : '未确认强势 · 不追涨';
  }
  return result;
}

// 行动卡：把全部盘中信号压缩成一张卡——买 / 卖 / 持有 / 跑路，外加三个关键价位。
//   跑路线 = 昨收 × (1 + stop.pricePct)；买/卖档 = 盘前计划里离现价最近的下一档。
//   判定优先级：跑路 > 走弱减仓 > 反弹转弱高抛 > 止跌买入 > 持有不动。
function buildEtfActionCard(ctx) {
  const quote = ctx.quote || {}, price = quote.price, prevClose = quote.prevClose;
  if (!(price > 0) || !(prevClose > 0)) return null;
  const plan = ctx.premarket || {};
  const sig = ctx.intradaySignals || {};
  const strength = sig.strength && sig.strength.current;
  const tier = ctx.positionPlan && ctx.positionPlan.tier;
  const minute = etfMinuteNumber((quote.quoteTime || '').slice(11, 16));
  const buyLv = (plan.buy || []).filter(b => b.price > 0 && b.price < price).sort((a, b) => b.price - a.price)[0] || null;
  const sellLv = (plan.sell || []).filter(s => s.price > 0 && s.price > price).sort((a, b) => a.price - b.price)[0] || null;
  const stopPct = plan.stop && isFinite(plan.stop.pricePct) ? plan.stop.pricePct : -3.5;
  const stopPrice = +(prevClose * (1 + stopPct / 100)).toFixed(3);
  const recent = (side, win) => (sig.events || []).some(e => {
    if (e.side !== side) return false;
    const age = minute - etfMinuteNumber(e.time);
    return age >= 0 && age <= win;
  });
  const kind = strength && strength.kind;
  const runByPrice = price <= stopPrice;
  let stance = 'hold', verdict = '持有不动', reason = '';
  if (kind === 'broken' || runByPrice) {
    stance = 'run'; verdict = '跑路 · 先出来';
    reason = runByPrice
      ? `现价 ${price.toFixed(3)} 已跌破跑路线 ${stopPrice.toFixed(3)}（昨收 ${stopPct}%），情况不对先出来，别赌反弹。`
      : '分时已破位：连续贴着均价下方且跌破前段支撑。先减仓出来，重新站回分时均价之前不接。';
  } else if (kind === 'weak') {
    stance = 'sell'; verdict = '走弱 · 先减仓';
    reason = '连续几分钟贴着分时均价下方阴跌，反弹没力道；已有仓位逢反弹先减，不在这个位置接跌。';
  } else if (recent('sell', 5)) {
    stance = 'sell'; verdict = '反弹转弱 · 高抛';
    reason = `刚确认反弹转弱，已有仓位分批减${sellLv ? `，参考档 ${sellLv.price.toFixed(3)}` : ''}，别等利润回吐。`;
  } else if (recent('buy', 5) && ['heavy', 'try'].includes(tier)) {
    stance = 'buy'; verdict = '止跌 · 按档买入';
    reason = `日内止跌确认、趋势风控允许；参考买档 ${buyLv ? buyLv.price.toFixed(3) : '现价附近'}，按计划分批小仓接，破位立刻停。`;
  } else {
    stance = 'hold'; verdict = '持有不动';
    reason = `结构没坏、也没确认转强，拿着别动；涨到 ${sellLv ? sellLv.price.toFixed(3) : '—'} 附近再看减仓，跌到 ${buyLv ? buyLv.price.toFixed(3) : '—'} 附近再看接回。`;
  }
  return { stance, verdict, reason, kind: kind || null,
    prices: { stop: stopPrice, buy: buyLv ? buyLv.price : null, sell: sellLv ? sellLv.price : null } };
}

// 盘中提示：状态型条件（每次请求重算，前端按 key 去重后只提示新增项）
function buildEtfAlerts(ctx) {
  const { quote, ind, todayBar } = ctx;
  const out = [];
  const add = (key, level, title, text, pri) => out.push({ key, level, title, text, pri });
  // 跑路是最高优先级：独立 key，条件解除后自动重新武装，再次触发会再弹一次
  if (ctx.action && ctx.action.stance === 'run') {
    add('action_run', 'danger', `🚨 ${ctx.action.verdict}`, ctx.action.reason, -10);
  }
  const zone = premiumZone(quote.premiumPct);
  const pz = quote.premiumPct;
  const live = ctx.session && ctx.session.trading && ctx.intradaySignals && ctx.intradaySignals.actionable;
  const nowMin = etfMinuteNumber((quote.quoteTime || '').slice(11, 16));
  if (live && ctx.premarket) {
    for (const touch of ctx.premarket.touches || []) {
      if (nowMin - etfMinuteNumber(touch.time) < 0 || nowMin - etfMinuteNumber(touch.time) > 2) continue;
      const canBuy = touch.side === 'buy' && touch.time < '14:30'
        && ctx.positionPlan && ['heavy', 'try'].includes(ctx.positionPlan.tier);
      out.push({ key: `intraday_level_${ctx.today}_${touch.key}`, time: touch.time, level: touch.side === 'sell' ? 'warn' : canBuy ? 'good' : 'info',
        title: `${touch.key.toUpperCase()} ${touch.side === 'buy' ? '低吸参考位' : '高抛参考位'}触达`,
        text: `现价 ${touch.price.toFixed(3)}，参考档位 ${touch.target.toFixed(3)}；${touch.side === 'sell' ? '已有仓位可关注分批减仓，不代表自动成交。' : canBuy ? '等待止跌确认，不因触价直接买入。' : '当前时间或趋势风控不允许新增仓位，仅记录触达。'}`, pri: -2 });
    }
  }
  if (live && ctx.intradaySignals && ctx.intradaySignals.actionable) {
    for (const event of ctx.intradaySignals.events) {
      const age = nowMin - etfMinuteNumber(event.time);
      if (age >= 0 && age <= 2) {
        const currentStrength = ctx.intradaySignals.strength && ctx.intradaySignals.strength.current;
        const buyBlocked = event.side === 'buy' && (nowMin >= 870
          || currentStrength && ['weak', 'broken'].includes(currentStrength.kind)
          || !ctx.positionPlan || !['heavy', 'try'].includes(ctx.positionPlan.tier));
        out.push(buyBlocked ? { ...event, side: 'watch', level: 'info', title: '止跌信号已出现 · 当前风控禁止买入', text: `${event.text} 当前时间或趋势已不满足买入条件，不按之前候选加仓。`, pri: -3 } : { ...event, pri: -3 });
      }
    }
  }

  const pc = ctx.premCross;
  if (pc) {
    for (const [direction, lines] of [['dn', pc.crossedDown || []], ['up', pc.crossedUp || []]]) {
      for (const line of lines) {
        add(`premium_cross_${direction}_${line}`, 'info', `溢价${direction === 'dn' ? '跌破' : '升破'} ${line}% 参考档位`,
          `溢价由 ${pc.from.toFixed(2)}% 变为 ${pc.to.toFixed(2)}%；仅供参考，不触发买卖或仓位调整。`);
      }
    }
  }
  if (Number.isFinite(pz)) {
    add(`premium_zone_${zone.key}`, 'info', `溢价 ${zone.label}（仅参考）`,
      `当前溢价 ${pz.toFixed(2)}%；不限制买卖或仓位，注意溢价收敛可能造成额外回撤。`);
  }

  const adv = ctx.advice;
  if (adv && adv.level === 'buy') {
    add('buy_opportunity', 'good', '分批买入参考', adv.headline, -1);
  } else if (adv && adv.level === 'warn' && /试仓|试探|建仓/.test(adv.action || '')) {
    add('buy_probe', 'warn', '趋势未确认 · 只可试仓', adv.headline, 1);
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
  // 日K走独立缓存 + 失败退避；quote 与分时保持每次实时拉（拆出 Promise.all）
  const klineTtl = clockTrading ? ETF_KLINE_TTL_TRADING : ETF_KLINE_TTL_IDLE;
  let klines = (ETF_KLINE_CACHE.data && ETF_KLINE_CACHE.data.length && Date.now() - ETF_KLINE_CACHE.ts < klineTtl)
    ? ETF_KLINE_CACHE.data : null;
  if (!klines && Date.now() >= ETF_KLINE_BACKOFF_UNTIL) {
    try {
      klines = await fetchTencentEtfDayK(ETF_CODE, 1000);
      if (klines && klines.length) {
        ETF_KLINE_CACHE.data = klines;
        ETF_KLINE_CACHE.ts = Date.now();
        ETF_KLINE_BACKOFF_UNTIL = 0;
      }
    } catch (e) { console.error('[etf-kline]', e.message); }
    if (!klines || !klines.length) {
      klines = [];
      ETF_KLINE_BACKOFF_UNTIL = Date.now() + ETF_KLINE_BACKOFF_MS;   // 失败退避 60 秒，不让每个请求都打上游
    }
  } else if (!klines) {
    klines = [];   // 退避期内：不打上游，直接走下方缓存兜底
  }
  const [quote, minute] = await Promise.all([
    fetchTencentEtfQuote(ETF_CODE).catch(() => null),
    fetchTencentEtfMinute(ETF_CODE).catch(() => null),
  ]);
  let navMap = {};
  const degraded = [];   // 子源失败清单（净值/美股/恐慌等）：响应里带出去，前端能区分「为空」和「挂了」
  try { navMap = await fetchEtfNavHistory(ETF_FUND_CODE); } catch { degraded.push('净值'); /* 净值缺失不阻断 */ }

  if (!klines.length) {
    if (ETF_MKT_CACHE.data) return ETF_MKT_CACHE.data;
    const disk = loadEtfDiskCache();
    if (disk) {
      // 用磁盘缓存顶住；不再把 ts 清零（那会导致每个请求都重打上游），
      // 改为 30 秒后允许重试上游自愈
      ETF_MKT_CACHE.data = disk;
      ETF_MKT_CACHE.ts = Date.now() - (clockTrading ? ETF_MKT_TTL_TRADING : ETF_MKT_TTL_IDLE) + 30_000;
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
  try { usIdx = await fetchUsIndexHistory(); } catch (e) { console.error('[us-index]', e.message); degraded.push('美股指数'); }

  let panicSignal = null;
  try {
    panicSignal = buildEtfPanicSignal(klines, navMap, usIdx);
  } catch (e) { console.error('[etf-panic]', e.message); degraded.push('恐慌信号'); }

  // 多指标组合信号（买卖信号清单 v6）：溢价为主 + 威廉%R/MA21/布林/MACD 共振，
  // 且美股未确认止跌时不给「重仓买入/买入/试仓」，统一降级为「等美股确认」
  let comboSignals = { signals: [], stats: null, backtest: null };
  try { comboSignals = buildEtfCompositeSignals(klines, navMap, panicSignal, usIdx); } catch (e) { console.error('[etf-combo]', e.message); degraded.push('组合信号'); }

  // 仓位建议：趋势定方向、溢价定仓位、美股趋势定「低溢价能不能抬仓」（盘中用实时价与实时溢价覆盖）
  let positionPlan = null;
  try {
    positionPlan = buildEtfPositionPlan(klines, navMap, (quote && quote.price > 0) ? {
      price: quote.price, premiumPct: quote.premiumPct, iopv: quote.iopv, date: todayStr,
    } : null, panicSignal, usIdx);
  } catch (e) { console.error('[etf-pos]', e.message); degraded.push('仓位计划'); }

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
    // 仓位建议按趋势定仓，溢价仅供参考。
    positionPlan,
    // 恐慌抄底：外盘与技术共振的窗口（含历史统计）。
    panicSignal,
    usIdx,
    stats,
    premium: {
      current: quote ? quote.premiumPct : null,
      band: premiumZone(quote ? quote.premiumPct : null),
      iopv: quote ? quote.iopv : null,
      nav: quote ? quote.nav : null,
      history: premiumHist,          // 全历史（用于回溯；前端默认只画近 120 日）
      stats20: premiumStats,
      // 历史溢价参考档位，不参与交易决策。
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
    intraday: minute ? { ...minute, prevClose: quote ? quote.prevClose : null } : minute,
    lastSignal,
    // 子源失败清单（null = 全部正常）：前端据此区分「信号为空」和「子源挂了」
    degraded: degraded.length ? degraded : null,
    // 全历史回溯：最佳买卖点 + 策略对比（按交易日缓存，同一交易日内直接复用）
    review: (() => {
      const kdate = klines[lastIdx] ? klines[lastIdx].date : null;
      if (ETF_REVIEW_CACHE.date === kdate && ETF_REVIEW_CACHE.data) return ETF_REVIEW_CACHE.data;
      try {
        ETF_REVIEW_CACHE.data = buildEtfHistoryReview(klines, navMap, signals);
        ETF_REVIEW_CACHE.date = kdate;
      } catch (e) { console.error('[etf-review]', e.message); degraded.push('历史回溯'); ETF_REVIEW_CACHE.data = null; }
      return ETF_REVIEW_CACHE.data;
    })(),
  };

  ETF_MKT_CACHE.data = data;
  ETF_MKT_CACHE.ts = Date.now();
  saveEtfDiskCache(data, klines);
  return data;
}

// 最近一次成功的完整响应（含 route 层字段 advice/premarket/intradaySignals 等）。
// 上游异常时回给它 + stale:true，保证兜底响应结构完整、前端卡片不会整片消失。
let ETF_LAST_TRACK_PAYLOAD = null;

app.get('/api/etf-track', async (req, res) => {
  try {
    const data = await getEtfMarketData();
    const todayStr = bjDateStr();

    // 持仓（查询参数由前端从 localStorage 带入，仅用于生成建议，不落库）
    // 合法性校验：cost 为合理单价（0~1 万）、shares 为合理份额上限，防脏参数生成荒谬建议
    const cost = parseFloat(req.query.cost);
    const shares = parseFloat(req.query.shares);
    let pos = null;
    if (isFinite(cost) && isFinite(shares) && shares > 0 && cost > 0 && cost < 10_000 && shares <= 100_000_000) {
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

    const { bars: displayBars, todayBar } = etfLiveMacdBars(data, ETF_KLINES, todayStr);

    // 盘中溢价参考档位变化检测。
    const curPrem = data.quote ? data.quote.premiumPct : null;
    let premCross = null;
    if (isFinite(curPrem)) {
      // 基线只在盘中更新、且按交易日归组：
      //  · 盘外不更新基线 → 隔夜溢价跳空不会被当成盘中穿越误报（此前隔夜最后一笔溢价
      //    会成为次日开盘检测的起点，开盘第一对请求就把「跳空」误报成「穿越」）
      //  · 新交易日第一笔（day !== today）只重建基线、不检测
      if (ETF_PREM_PREV && isFinite(ETF_PREM_PREV.pct) && data.session.trading && ETF_PREM_PREV.day === todayStr) {
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
      if (data.session.trading) ETF_PREM_PREV = { pct: curPrem, ts: Date.now(), day: todayStr };
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
      today: todayStr,
      stale: !!data.stale,
      intraday: data.intraday,
      positionPlan: data.positionPlan,
      klines: ETF_KLINES,
      usIdx: data.usIdx,
      klineLast: data.klineLast,
      klinePrev: ETF_KLINES.length >= 2 ? ETF_KLINES[ETF_KLINES.length - 2] : null,   // 前一日 K 线（含 OHLC）
      klinePrev2: ETF_KLINES.length >= 3 ? ETF_KLINES[ETF_KLINES.length - 3] : null,  // 前两日 K 线（盘中算"昨日的前收"用）
    };
    const advice = buildEtfAdvice(ctx);
    ctx.advice = advice;

    // 盘前提示 · 日内高抛低吸计划
    // qqqPct/ixicPct 由前端从 LAST_MAP 算好后通过查询参数带入
    // 新参数（2026-10-15 拆分）：
    //   regPct = 昨日盘中（昨前收 → 昨收），prePct = 今日盘前段（昨收 → 当前盘前/夜盘）
    //   分开展示 + 同向下跌触发恐慌二次探底逻辑
    // 旧字段 qqqPct/ixicPct = 累计涨跌幅，作为 fallback 保留
    let qqqPct = parseFloat(req.query.qqqPct);
    let ixicPct = parseFloat(req.query.ixicPct);
    let qqqRegPct = parseFloat(req.query.qqqRegPct);
    let qqqPrePct = parseFloat(req.query.qqqPrePct);
    let ixicRegPct = parseFloat(req.query.ixicRegPct);
    let ixicPrePct = parseFloat(req.query.ixicPrePct);
    const debugTime = req.query.debugTime || null;

    // 后端兜底：前端没传 regPct/prePct 时（页面刚打开 pollLoop 还没回来），
    // 从 quoteCache 扫出 QQQ/IXIC 的最新 quote，自己算 regPct/prePct。
    // 实测：页面刚开 / 网络抖动时前端会拿不到 LAST_MAP，导致 logic 显示"美股数据缺失"。
    if (!isFinite(qqqRegPct) || !isFinite(qqqPrePct) || !isFinite(ixicRegPct) || !isFinite(ixicPrePct)) {
      const findQ = (sym) => {
        for (const entry of quoteCache.values()) {
          const q = (entry.data || []).find(x => x && x.symbol === sym);
          if (q) return q;
        }
        return null;
      };
      const splitRegPre = (q) => {
        if (!q) return { regPct: null, prePct: null };
        const s = q.marketState;
        const regPct = isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : 0;
        if (s === 'PRE' || s === 'PREPRE') return { regPct: null, prePct: regPct };
        if (s === 'REGULAR') return { regPct, prePct: null };
        let prePct = null;
        if (s === 'OVERNIGHT') {
          prePct = isFinite(q.overnightChangePercent) ? q.overnightChangePercent : null;
        } else {
          const closePrice = q.closePrice || q.regularMarketPrice;
          if (q.afterHoursPrice && closePrice) {
            prePct = ((q.afterHoursPrice - closePrice) / closePrice) * 100;
          } else {
            prePct = 0;
          }
        }
        return { regPct, prePct };
      };
      if (!isFinite(qqqRegPct) || !isFinite(qqqPrePct)) {
        const r = splitRegPre(findQ('QQQ'));
        if (!isFinite(qqqRegPct) && r.regPct != null) qqqRegPct = r.regPct;
        if (!isFinite(qqqPrePct) && r.prePct != null) qqqPrePct = r.prePct;
      }
      if (!isFinite(ixicRegPct) || !isFinite(ixicPrePct)) {
        const r = splitRegPre(findQ('IXIC'));
        if (!isFinite(ixicRegPct) && r.regPct != null) ixicRegPct = r.regPct;
        if (!isFinite(ixicPrePct) && r.prePct != null) ixicPrePct = r.prePct;
      }
      // 同步累计口径 fallback
      if (!isFinite(qqqPct) && isFinite(qqqRegPct) && isFinite(qqqPrePct)) {
        qqqPct = ((1 + qqqRegPct / 100) * (1 + qqqPrePct / 100) - 1) * 100;
      }
      if (!isFinite(ixicPct) && isFinite(ixicRegPct) && isFinite(ixicPrePct)) {
        ixicPct = ((1 + ixicRegPct / 100) * (1 + ixicPrePct / 100) - 1) * 100;
      }
    }
    if (!isFinite(qqqRegPct) && data.usIdx && data.usIdx.qqq && Array.isArray(data.usIdx.qqq.dates) && data.usIdx.qqq.dates.length) {
      const d = data.usIdx.qqq.dates[data.usIdx.qqq.dates.length - 1];
      const v = data.usIdx.qqq.ret && data.usIdx.qqq.ret[d];
      if (isFinite(v)) qqqRegPct = v;
    }
    if (!isFinite(ixicRegPct) && data.usIdx && data.usIdx.ixic && Array.isArray(data.usIdx.ixic.dates) && data.usIdx.ixic.dates.length) {
      const d = data.usIdx.ixic.dates[data.usIdx.ixic.dates.length - 1];
      const v = data.usIdx.ixic.ret && data.usIdx.ixic.ret[d];
      if (isFinite(v)) ixicRegPct = v;
    }
    if (!isFinite(qqqPct) && isFinite(qqqRegPct) && isFinite(qqqPrePct)) qqqPct = ((1 + qqqRegPct / 100) * (1 + qqqPrePct / 100) - 1) * 100;
    if (!isFinite(ixicPct) && isFinite(ixicRegPct) && isFinite(ixicPrePct)) ixicPct = ((1 + ixicRegPct / 100) * (1 + ixicPrePct / 100) - 1) * 100;
    const premarketModeForCache = premarketMode(ctx, debugTime, {
      qqqPct: isFinite(qqqPct) ? qqqPct : null,
      ixicPct: isFinite(ixicPct) ? ixicPct : null,
      qqqRegPct: isFinite(qqqRegPct) ? qqqRegPct : null,
      ixicRegPct: isFinite(ixicRegPct) ? ixicRegPct : null,
    });
    const planDate = data.session && data.session.lastTradingDate && premarketModeForCache === 'next'
      ? data.session.lastTradingDate + ':next'
      : todayStr;
    if (!LAST_PREMARKET_PLAN || LAST_PREMARKET_PLAN._date !== todayStr) LAST_PREMARKET_PLAN = loadEtfDayPlan(todayStr);
    if (LAST_NEXT_PREMARKET_PLAN && LAST_NEXT_PREMARKET_PLAN._date !== planDate) LAST_NEXT_PREMARKET_PLAN = null;
    const nextMode = premarketModeForCache === 'next' || premarketModeForCache === 'closed';
    const premarket = buildPremarketPlan(ctx, nextMode ? LAST_NEXT_PREMARKET_PLAN : LAST_PREMARKET_PLAN, {
      qqqPct: isFinite(qqqPct) ? qqqPct : null,
      ixicPct: isFinite(ixicPct) ? ixicPct : null,
      qqqRegPct: isFinite(qqqRegPct) ? qqqRegPct : null,
      qqqPrePct: isFinite(qqqPrePct) ? qqqPrePct : null,
      ixicRegPct: isFinite(ixicRegPct) ? ixicRegPct : null,
      ixicPrePct: isFinite(ixicPrePct) ? ixicPrePct : null,
      debugTime,
    });
    if (premarket) {
      premarket._date = planDate;
      if (nextMode) LAST_NEXT_PREMARKET_PLAN = premarket;
      else { LAST_PREMARKET_PLAN = premarket; saveEtfDayPlan(premarket); }
    }
    ctx.premarket = nextMode ? LAST_PREMARKET_PLAN : premarket;
    const intradaySignals = buildEtfIntradaySignals(ctx);
    if (ctx.premarket) {
      const observed = ctx.premarket.signalEvents || [];
      for (const event of intradaySignals.events) {
        if (intradaySignals.actionable && etfMinuteNumber(intradaySignals.asOf) - etfMinuteNumber(event.time) <= 2 && !observed.some(e => e.key === event.key)) observed.push({ ...event });
      }
      ctx.premarket.signalEvents = observed;
      intradaySignals.events = intradaySignals.events.map(e => observed.find(o => o.key === e.key) || e);
      if (!nextMode || LAST_PREMARKET_PLAN) saveEtfDayPlan(ctx.premarket);
    }
    ctx.intradaySignals = intradaySignals;
    ctx.action = buildEtfActionCard(ctx);
    const alerts = isAShareTradingTime() && data.session.trading ? buildEtfAlerts(ctx) : [];

    const { usIdx: _usIdx, ...publicData } = data;
    const payload = { success: true, ...publicData, bars: displayBars, pos, advice, alerts, todayBar, premCross, premarket, dayPlan: LAST_PREMARKET_PLAN, intradaySignals, action: ctx.action };
    if (req.query.diag === '1') {
      payload.diag = {
        klineCount: ETF_KLINES.length,
        navDates: Object.keys(ETF_NAV_CACHE.data || {}).length,
        premiumHistLen: data.premium.history.length,
        signalCount: data.signals.length,
        cachedAgoMs: Date.now() - ETF_MKT_CACHE.ts,
      };
    }
    ETF_LAST_TRACK_PAYLOAD = payload;
    res.json(payload);
  } catch (err) {
    console.error('[etf-track]', err.message);
    // 优先回最近一次完整 payload（结构一致，只是旧）；没有才退 MKT 缓存兜底
    if (ETF_LAST_TRACK_PAYLOAD) return res.json({ ...ETF_LAST_TRACK_PAYLOAD, stale: true });
    if (ETF_MKT_CACHE.data) return res.json({ success: true, ...ETF_MKT_CACHE.data, stale: true, degraded: true });
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
//  Keep-alive: self-ping every 30 minutes to reduce bandwidth
//  Note: Render free tier sleeps after 15min idle, so this
//  won't prevent cold start, but minimizes self-ping traffic.
// ═══════════════════════════════════════════════════════
function startKeepAlive() {
  const selfUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (!selfUrl) {
    console.log('[keep-alive] 本地环境未启用');
    return;
  }

  const INTERVAL = 30 * 60 * 1000; // 30 minutes

  setInterval(() => {
    const mod = selfUrl.startsWith('https') ? https : http;
    const req = mod.get(selfUrl + '/api/health', (res) => {
      // 消费响应数据但丢弃，避免占用内存
      res.resume();
      console.log(`[keep-alive] ping ${selfUrl} → ${res.statusCode}`);
    });
    req.on('error', (err) => {
      console.warn(`[keep-alive] ping failed: ${err.message}`);
    });
    req.end();
  }, INTERVAL);

  console.log(`[keep-alive] 每30分钟自动访问 ${selfUrl}/api/health`);
}

// ═══════════════════════════════════════════════════════
//  Startup
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`美股基金估值服务已启动 → http://localhost:${PORT}`);
  // 启动就把期货分钟线补进历史：否则重启后最早的基点是「当下」，漂移恒为 0
  seedFuturesHist(true);
  // 夜盘长（20:00–04:00 ET），本地采样可能因休眠中断，半小时对齐一次
  setInterval(() => seedFuturesHist(), 30 * 60_000).unref?.();
  // Warm fund cache in background
  loadHoldingsFromFile();
  // Self-ping to prevent server sleep
  startKeepAlive();
});
