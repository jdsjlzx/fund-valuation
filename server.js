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
  { name: '易方达标普信息科技',    code: '161128' },
  { name: '易方达全球成长精选',    code: '012920' },
  { name: '国富全球科技互联',      code: '006373' },
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
  { name: '摩根太平洋科技对冲',   code: '968061' },
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

// Known international tickers handled by a non-Sina fetcher
// (国内财经 API 不覆盖韩/日/台/欧实时行情，需要单独走 Naver/Yahoo Japan 等)
const KR_STOCKS = new Set(['000660', '005930']);  // SK海力士、三星电子

function isKoreanSymbol(s) { return KR_STOCKS.has(s); }

// 台股: 用 TWSE 官方 API (mis.twse.com.tw)，无频率限制
function isTaiwanSymbol(s) { return /\.TW$/i.test(s); }
// Yahoo Finance: 日股 (.T)、新加坡 (.SI) 等其他国际市场
function isYahooSymbol(s) { return /\.(T|SI)$/i.test(s); }

function toSinaId(symbol) {
  if (symbol === 'USDCNY=X') return 'fx_susdcny';
  if (symbol === 'IXIC' || symbol === '^IXIC') return 'gb_$ixic';
  if (symbol === 'DJI'  || symbol === '^DJI')  return 'gb_$dji';
  if (symbol === 'INX'  || symbol === '^GSPC') return 'gb_$inx';
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
  if (/^\d{4,5}$/.test(symbol)) return 'hk' + symbol.padStart(5, '0');
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
//  Sina/Tencent/eastmoney 都不覆盖 KRX；Naver 是 EUC-KR 编码的纯 HTML 页面
// ──────────────────────────────────────────
function fetchNaverHtml(ticker) {
  const url = `https://finance.naver.com/item/main.naver?code=${encodeURIComponent(ticker)}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          'Accept-Language': 'ko-KR,en;q=0.9',
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // Naver finance now serves UTF-8 (used to be EUC-KR).
          // Pick decoder from response Content-Type, default to utf-8.
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          const enc = /euc-kr/.test(ct) ? 'euc-kr' : 'utf-8';
          try {
            resolve(new TextDecoder(enc).decode(Buffer.concat(chunks)));
          } catch {
            resolve(Buffer.concat(chunks).toString('utf-8'));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Naver request timeout')));
    req.on('error', reject);
  });
}

function parseNaverQuote(html, ticker) {
  // Naver embeds an accessibility-labelled <dl class="blind"> with ordered fields:
  //   [0] 거래소 timestamp  [1] 시장 (코스피/코스닥)
  //   [2] 종목 + 시장코드
  //   [3] "현재가 X,XXX 전일대비 보합/상승/하락 +Y -Y.YY 등락률"
  //   [4]+ open/high/low/52w/...
  const m = html.match(/<dl class="blind">([\s\S]*?)<\/dl>/);
  if (!m) return null;
  const dds = [...m[1].matchAll(/<dd>([^<]+)<\/dd>/g)].map((x) => x[1].trim());
  if (dds.length < 4) return null;

  const priceLine = dds[3];
  // Detect sign: 상승=up, 하락=down, 보합=unchanged
  let sign = 1;
  if (/하락/.test(priceLine)) sign = -1;
  else if (/상승/.test(priceLine)) sign = 1;
  else if (/보합/.test(priceLine)) sign = 0;

  // Extract numbers in priceLine: [price, changeAbs, changePct]
  const nums = (priceLine.match(/[\d,]+\.?\d*/g) || []).map((n) =>
    parseFloat(n.replace(/,/g, ''))
  );
  if (nums.length < 1 || isNaN(nums[0])) return null;
  const price = nums[0];
  // changeAbs and changePct are unsigned in the page; apply sign
  const changeAbs = sign * Math.abs(nums[1] || 0);
  const changePct = sign * Math.abs(nums[2] || 0);
  const prevClose = price - changeAbs;

  return {
    symbol: ticker,
    regularMarketPrice: price,
    regularMarketPreviousClose: prevClose,
    regularMarketChangePercent: changePct,
    preMarketChangePercent: changePct,
    postMarketChangePercent: 0,
    marketState: 'REGULAR',
  };
}

async function fetchKoreanQuote(ticker) {
  const html = await fetchNaverHtml(ticker);
  return parseNaverQuote(html, ticker);
}

// ──────────────────────────────────────────
//  TWSE fetcher (台湾证券交易所，官方实时 API，无频率限制)
//  ticker 格式: "2330.TW"  → ex_ch: "tse_2330.tw"
// ──────────────────────────────────────────
async function fetchTaiwanQuotes(symbols) {
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
    const sym = `${code}.TW`;
    const price = parseFloat(m.z);
    const prev  = parseFloat(m.y);
    if (isNaN(price) || isNaN(prev) || price <= 0) return null;
    const chgPct = ((price - prev) / prev) * 100;
    return {
      symbol: sym,
      regularMarketPrice: price,
      regularMarketChangePercent: chgPct,
      regularMarketPreviousClose: prev,
      preMarketChangePercent: chgPct,
      postMarketChangePercent: 0,
      marketState: 'REGULAR',
    };
  }).filter(Boolean);
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
  return 'CLOSED';
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

    if (id.startsWith('gb_')) {
      let upper = id.slice(3).toUpperCase();
      if (upper.startsWith('$')) {
        const stripped = upper.slice(1);
        upper = symMap.has(stripped) ? stripped
              : symMap.has('^' + stripped) ? '^' + stripped
              : stripped;
      }
      const symbol = symMap.get(upper) || upper;
      const price = parseFloat(fields[1]);
      const chgPct = parseFloat(fields[2]);
      if (isNaN(price) || isNaN(chgPct)) continue;
      const prevClose = parseFloat(fields[26]) || parseFloat(fields[8]) || null;
      // After-hours / pre-market price from Sina field[21]
      const ahPrice = parseFloat(fields[21]);
      let postChgPct = 0;
      if (!isNaN(ahPrice) && ahPrice > 0 && price > 0) {
        // post-market change relative to regular close price
        postChgPct = ((ahPrice - price) / price) * 100;
      }
      map[symbol] = {
        symbol,
        regularMarketPrice: price,
        closePrice: price,
        regularMarketChangePercent: chgPct,
        regularMarketPreviousClose: prevClose,
        preMarketChangePercent: chgPct,
        postMarketChangePercent: postChgPct,
        afterHoursPrice: (!isNaN(ahPrice) && ahPrice > 0) ? ahPrice : null,
        marketState: usState,
      };
      continue;
    }

    if (id.startsWith('hk')) {
      // HK stock fields:
      //  [2] open  [3] prev_close  [4] high  [5] low
      //  [6] current  [7] change_amt  [8] change_%
      const ticker = id.slice(2);
      const symbol = symMap.get(ticker) || symMap.get(ticker.replace(/^0+/, '')) || ticker;
      const price = parseFloat(fields[6]);
      const chgPct = parseFloat(fields[8]);
      if (isNaN(price) || isNaN(chgPct)) continue;
      map[symbol] = {
        symbol,
        regularMarketPrice: price,
        regularMarketChangePercent: chgPct,
        regularMarketPreviousClose: parseFloat(fields[3]) || null,
        preMarketChangePercent: chgPct,
        postMarketChangePercent: 0,
        marketState: 'REGULAR',
      };
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
      map[symbol] = {
        symbol,
        regularMarketPrice: price,
        regularMarketPreviousClose: prevClose,
        regularMarketChangePercent: chgPct,
        preMarketChangePercent: chgPct,
        postMarketChangePercent: 0,
        marketState: 'REGULAR',
      };
    }
  }
  return map;
}

app.get('/api/quotes', async (req, res) => {
  const raw = (req.query.symbols || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols required' });
  const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const cacheKey = [...symbols].sort().join(',');
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < QUOTE_TTL) {
    return res.json({ success: true, data: cached.data, cached: true });
  }

  // Route each symbol: eastmoney(US) → Naver(KR) → TWSE(TW) → Yahoo(JP/SG) → Sina(forex/HK/A股/兜底)
  const krSymbols   = symbols.filter((s) =>  isKoreanSymbol(s));
  const twSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && isTaiwanSymbol(s));
  const yhSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && isYahooSymbol(s));
  const emSymbols   = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isYahooSymbol(s) && emSecid(s));
  const sinaSymbols = symbols.filter((s) => !isKoreanSymbol(s) && !isTaiwanSymbol(s) && !isYahooSymbol(s) && !emSecid(s));
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
    // Always fetch Sina for all US stocks to get after-hours data (field[21])
    const sinaAll = [...sinaSymbols, ...emMissing, ...emSymbols.filter((s) => emMap[s])];

    const [emData, sinaData, krData, twData, yhData] = await Promise.all([
      emSymbols.map((s) => emMap[s]).filter(Boolean),
      (async () => {
        if (sinaAll.length === 0) return [];
        const text = await fetchSina(sinaAll.map(toSinaId));
        const m = parseSinaResponse(text, sinaAll);
        return { map: m, list: sinaAll.map((s) => m[s]).filter(Boolean) };
      })(),
      Promise.all(
        krSymbols.map((s) =>
          fetchKoreanQuote(s).catch((e) => {
            console.error('[naver]', s, e.message);
            return null;
          })
        )
      ).then((arr) => arr.filter(Boolean)),
      twSymbols.length
        ? fetchTaiwanQuotes(twSymbols).catch((e) => {
            console.error('[twse]', e.message);
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
    ]);

    // Merge: for symbols that have both eastmoney and sina data,
    // use eastmoney as base but overlay after-hours data from sina.
    // 盘前(PRE)时 eastmoney f2/f3 已是盘前实时价(vs昨收)，不需要叠加 sina 的旧 post 数据。
    const sinaMap = (sinaData && sinaData.map) || {};
    const usState = getUSMarketState();
    const mergedEmData = emData.map((em) => {
      const sina = sinaMap[em.symbol];
      if (sina && sina.postMarketChangePercent !== undefined) {
        // 盘前时段: eastmoney f2/f3 已反映盘前实时价 vs 昨收，
        // 保留 sina 收盘价和盘后价供24h视图计算盘后涨跌
        if (usState === 'PRE') {
          return {
            ...em,
            regularMarketPreviousClose: sina.regularMarketPreviousClose || em.regularMarketPreviousClose,
            postMarketChangePercent: sina.postMarketChangePercent || 0,
            afterHoursPrice: sina.afterHoursPrice || null,
            // sina的regularMarketPrice是收盘价，存为closePrice供24h视图使用
            closePrice: sina.regularMarketPrice || null,
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
    const emSymSet = new Set(emSymbols.filter((s) => emMap[s]));
    const puresinaData = (sinaData && sinaData.list || []).filter((q) => !emSymSet.has(q.symbol));

    const data = [...mergedEmData, ...puresinaData, ...krData, ...twData, ...yhData];
    if (data.length === 0) throw new Error('No quotes returned');
    quoteCache.set(cacheKey, { data, ts: Date.now() });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[quotes]', err.message);
    const stale = quoteCache.get(cacheKey);
    if (stale) return res.json({ success: true, data: stale.data, stale: true });
    res.status(500).json({ error: err.message });
  }
});

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
//  /api/fund-history — 基金近15/30/60天净值涨跌幅
//  数据来源：天天基金净值历史 API
// ═══════════════════════════════════════════════════════
const HISTORY_CACHE = new Map(); // code → { data, ts }
const HISTORY_TTL = 3600_000;   // 1小时缓存

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
          const item = { code, name, d15, d30, d60 };
          HISTORY_CACHE.set(code, { data: item, ts: Date.now() });
          return item;
        } catch (e) {
          console.error(`[fund-history] ${code}`, e.message);
          return { code, name, d15: null, d30: null, d60: null };
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
