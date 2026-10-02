/**
 * 从东方财富拉取全部基金持仓明细，写入 data/holdings.json
 * 用法: npm run update-holdings
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════
//  Fund roster (same as server.js)
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

const KR_STOCKS = new Set(['000660', '005930']);

// 特例：017091 景顺长城纳斯达克科技按用户指定改为单一指数代理——
// 该基金跟踪纳斯达克科技市值加权指数（NDXTMC），持仓仅此一条，权重 94.15%。
// regularOnly：指数为现货口径，净值只在美股盘中变动 → 盘前/夜盘/盘后不参与估值。
// NDXTMC 行情走新浪 znb_ 通道（东财 push2 拒绝当前出口，不可用，见 server.js 注释）。
const FUND_OVERRIDES = {
  '017091': {
    dataMode: 'index_regular_only',
    reportDate: null,
    annualDate: null,
    totalCount: 1,
    coverageWeight: 0.9415,
    regularOnly: true,
    holdings: [
      { s: 'NDXTMC', w: 0.9415, name_cn: '纳斯达克科技市值加权指数', market: 'INDEX', source: 'user_override' },
    ],
  },
};

// ═══════════════════════════════════════════════════════
//  HTTP helper
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
//  Parse eastmoney holdings HTML
// ═══════════════════════════════════════════════════════
function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseHoldingsTable(tableHtml) {
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/g;
  const headerLabels = [];
  let th;
  while ((th = thRe.exec(tableHtml)) !== null) {
    headerLabels.push(stripTags(th[1]).replace(/\s+/g, ''));
  }
  const findIdx = (kw) => headerLabels.findIndex((l) => l.includes(kw));
  const codeIdx   = findIdx('股票代码');
  const nameIdx   = findIdx('股票名称');
  let weightIdx = findIdx('占净值比例');
  if (weightIdx < 0) weightIdx = findIdx('占净值');
  if (weightIdx < 0) return [];

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let row;
  let isFirst = true;
  while ((row = trRe.exec(tableHtml)) !== null) {
    if (isFirst) { isFirst = false; continue; }
    const inner = row[1];
    const tds = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (tds.length <= weightIdx) continue;

    const codeCell   = tds[codeIdx >= 0 ? codeIdx : 1];
    const nameCell   = tds[nameIdx >= 0 ? nameIdx : 2];
    const weightCell = tds[weightIdx];

    let ticker = null;
    let market = null;

    const urlM = codeCell.match(/quote\.eastmoney\.com\/unify\/r\/(\d+)\.([A-Za-z0-9.\-_$^]+)/);
    if (urlM) {
      market = urlM[1];
      ticker = urlM[2];
    } else {
      const tx = codeCell.match(/data-texch=['"][^'"]*['"]\s*>([^<]+)</);
      if (tx) ticker = tx[1].trim();
      if (!ticker) {
        const di = codeCell.match(/data-id=['"](?:dq|zd)([^'"]+)['"]/);
        if (di) ticker = di[1].trim();
      }
      if (!ticker) {
        const text = stripTags(codeCell);
        if (text) ticker = text;
      }
      market = 'other';
    }
    if (!ticker) continue;

    if (market === 'other') {
      if (KR_STOCKS.has(ticker) || /^\d{6}$/.test(ticker)) {
        // 韩国交易所 6位代码（009150 三星电机、402340 SK Square…）。
        // 已全量核验 26 只基金的全持仓：裸 6 位代码无一是 A 股（A 股均带行情链接）
        market = 'KR';
      } else {
        // 日股代码在天天基金持仓表里常带 JT/JP 后缀（6976JT、285AJT、6871JP），直接剥离。
        // 裸 4 位数字代码台/日难分（2330 台积电 vs 日 Forside 同码撞车）→ 标记 AMBIG，
        // 拉取完后用 resolveAmbiguousMarket 在线判别（见下方）。
        const jp = ticker.match(/^(\d{3,4}[A-Z]?)(?:JT|JP)$/);
        if (jp) {
          market = 'JP';
          ticker = jp[1];
        } else if (/^\d{3,4}[A-Z]$/.test(ticker)) {
          // 东京交易所 2024 年起的新式字母代码（285A 铠侠、215A…），天天基金持仓表里
          // 常以裸码出现（无 JT 后缀），此前不匹配任何规则 → 被当 other 剔除。
          // 台股为 4 位纯数字、A 股 6 位、韩股 6 位，不会与之撞车。
          market = 'JP';
        } else if (/^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(ticker)) {
          // ISIN 形式（JP3236330001 铠侠控股、KR7009150004 三星电机…）：
          // 韩股 ISIN 可本地解码，日股 ISIN 不含交易所代码 → 后续按名称在线解析
          market = 'ISIN';
        } else if (/^\d{4}$/.test(ticker)) {
          market = 'AMBIG';
        }
      }
    }

    const w = parseFloat(stripTags(weightCell).replace('%', '')) / 100;
    if (isNaN(w) || w <= 0) continue;

    rows.push({ s: ticker, w, name_cn: stripTags(nameCell), market });
  }
  return rows;
}

// ──────────────────────────────────────────
//  裸 4 位数字代码的市场判别（台股 vs 日股）
//  天天基金持仓表对台/日股都不带行情链接（data-texch 为空），代码同为 4 位数字，
//  且台日存在同码撞车（2330: 台积电 / 日 Forside；5706: 三井金属 / 台 凤凰），
//  直接按前缀路由会拿到完全不相干公司的行情。判别链（结果全局缓存）：
//    1) 东财 suggest 接口（按代码 + 按名称双查，取 Code 恰好等于本代码的
//       176日/177韩/178台条目）。178 台股条目名称为简体，可与持仓名直接比对；
//       多市场撞码时选名称吻合的一侧。
//    2) TWSE 实时通道存在性 + 繁简归一化名称比对：代码在 TWSE 存在且名称
//       吻合 → 台股；存在但名称不符（撞码日股）或不存在 → 日股。
// ──────────────────────────────────────────
const MARKET_BY_MKTNUM = { 176: 'JP', 177: 'KR', 178: 'TW' };
const AMBIG_MARKET = 'AMBIG';
const ambigMarketCache = new Map();  // `ticker|name` → market

const TRAD_SIMP = {
  電: '电', 積: '积', 興: '兴', 發: '发', 廣: '广', 億: '亿', 廠: '厂', 業: '业',
  鳳: '凤', 勝: '胜', 龍: '龙', 華: '华', 達: '达', 聯: '联', 創: '创', 為: '为',
  國: '国', 臺: '台', 灣: '湾', 豐: '丰', 順: '顺', 訊: '讯', 網: '网', 證: '证',
  隆: '隆', 鴻: '鸿', 遠: '远', 東: '东', 陽: '阳', 實: '实', 環: '环', 營: '营',
};
function normCn(s) {
  return String(s || '')
    .split('')
    .map((ch) => TRAD_SIMP[ch] || ch)
    .join('')
    .replace(/[-–].*$/, '');   // 剥离 "-KY" 等挂牌后缀
}

async function emSuggest(input) {
  const url =
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(input)}` +
    `&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
  const txt = await httpGet(url, { Referer: 'https://quote.eastmoney.com/' });
  let j;
  try { j = JSON.parse(txt); } catch { return []; }
  return (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
}

function nameMatches(a, b) {
  const x = normCn(a), y = normCn(b);
  return !!(x && y && (x === y || x.includes(y) || y.includes(x)));
}

async function resolveAmbiguousMarket(ticker, nameCn) {
  const key = `${ticker}|${nameCn}`;
  if (ambigMarketCache.has(key)) return ambigMarketCache.get(key);

  let decided = false;
  let result = 'JP';  // 兜底：日股（腾讯 jp 通道对绝大多数 4 位代码有行情）

  // 1) 东财 suggest：按代码 + 按名称双查，收集 Code 精确匹配的 176/177/178 条目。
  //    注意 suggest 排序不稳定（同一查询 178 台积电 时有时无），单候选不可直接采信，
  //    只有名称与持仓名吻合的候选才作数；否则继续 TWSE 判别。
  const cands = new Map();  // market → name
  try {
    for (const input of [ticker, nameCn]) {
      for (const d of await emSuggest(input)) {
        if (d.Code === ticker && MARKET_BY_MKTNUM[d.MktNum]) {
          cands.set(MARKET_BY_MKTNUM[d.MktNum], d.Name || '');
        }
      }
    }
  } catch (e) {
    console.warn(`  [ambig] suggest 查询失败 ${ticker}:`, e.message);
  }
  for (const [mkt, nm] of cands) {
    if (nameMatches(nm, nameCn)) { result = mkt; decided = true; break; }
  }

  // 2) TWSE 存在性 + 名称比对（台股在 TWSE 有行、名称繁简归一后与持仓名吻合）
  if (!decided) {
    try {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${ticker}.tw&json=1&delay=0`;
      const txt = await httpGet(url, { Referer: 'https://mis.twse.com.tw/' });
      let j;
      try { j = JSON.parse(txt); } catch { j = null; }
      const row = j && (j.msgArray || []).find((m) => m.c === ticker);
      if (row && parseFloat(row.y) > 0 && nameMatches(row.n || row.nf, nameCn)) {
        result = 'TW';
      }
      // TWSE 不存在该代码 / 名称不符 → 维持日股兜底
    } catch (e) {
      console.warn(`  [ambig] TWSE 查询失败 ${ticker}:`, e.message);
    }
  }

  ambigMarketCache.set(key, result);
  return result;
}

async function resolveAmbiguousHoldings(holdings) {
  const ambig = holdings.filter((h) => h.market === AMBIG_MARKET);
  for (const h of ambig) {
    h.market = await resolveAmbiguousMarket(h.s, h.name_cn || '');
    await new Promise((r) => setTimeout(r, 150));  // 判别接口节流
  }
  return ambig.length;
}

// ──────────────────────────────────────────
//  ISIN 形式持仓的市场解析
//  天天基金对部分海外持仓只给 ISIN（JP3236330001 铠侠控股、KR7009150004 三星电机…），
//  无法直接定价 → 此前一律按 other 剔除。解析链：
//    1) 韩国 ISIN 本地解码：KR7 + 6 位代码（KR7009150004 → 009150）→ KR
//    2) 其余按名称查东财 suggest，取名称吻合的 176/177/178（日/韩/台）条目代码
//       （日股 ISIN 不内嵌交易所代码，只能按名称反查；名称先剥离公司后缀再查）
//  仍无法解析的（欧洲 ISIN、ADR 等无可用行情通道）→ 退回 other 由既有逻辑剔除
// ──────────────────────────────────────────
const KR_ISIN_RE = /^KR7(\d{6})/;

function stripCorpSuffix(n) {
  return String(n || '')
    .replace(/(株式会社|股份有限公司|有限公司|股份公司|控股集团|控股|集团|实业|公司)/g, '')
    .trim();
}

async function resolveIsinMarket(ticker, nameCn) {
  const krm = ticker.match(KR_ISIN_RE);
  if (krm) return { market: 'KR', s: krm[1] };

  const base = stripCorpSuffix(nameCn);
  const variants = [...new Set([nameCn, base, base.slice(0, 4), base.slice(0, 2)]
    .filter((v) => v && v.length >= 2))];

  for (const v of variants) {
    let ds = [];
    try {
      ds = await emSuggest(v);
    } catch (e) {
      continue;
    }
    for (const d of ds) {
      const mk = MARKET_BY_MKTNUM[d.MktNum];
      if (!mk || d.Code === ticker) continue;      // 只要日/韩/台条目
      if (nameMatches(d.Name || '', nameCn) || nameMatches(d.Name || '', base)) {
        return { market: mk, s: d.Code };
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

async function resolveIsinHoldings(holdings) {
  const rows = holdings.filter((h) => h.market === 'ISIN');
  for (const h of rows) {
    const r = await resolveIsinMarket(h.s, h.name_cn || '');
    if (r) {
      h.market = r.market;
      h.s = r.s;                                   // ISIN → 交易所代码
    } else {
      h.market = 'other';                          // 无法定价 → 交给既有剔除逻辑
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
  return rows.length;
}

function parseAllSections(text) {
  const cm = text.match(/content\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (!cm) return [];
  const content = cm[1];

  const parts = content.split(/<h4[^>]*class='t'>/);
  const sections = [];
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const labelM = block.match(/(20\d{2}年[1-4一二三四]季度|20\d{2}年年度|20\d{2}年中报)/);
    const dateM  = block.match(/截止至[^>]*>([\d\-]+)</);
    const tableM = block.match(/<table[^>]*>([\s\S]*?)<\/table>/);
    if (!tableM) continue;
    const holdings = parseHoldingsTable(tableM[1]);
    if (holdings.length === 0) continue;
    sections.push({
      label: labelM ? labelM[1] : null,
      date: dateM ? dateM[1] : null,
      holdings,
    });
  }
  return sections;
}

async function fetchHoldingsRaw(code, year, month, topline = 200) {
  const url =
    `http://fundf10.eastmoney.com/FundArchivesDatas.aspx?` +
    `type=jjcc&code=${code}&topline=${topline}&year=${year || ''}&month=${month || ''}`;
  const html = await httpGet(url, {
    Referer: `http://fundf10.eastmoney.com/ccmx_${code}.html`,
  });
  return parseAllSections(html);
}

const MIN_WEIGHT = 0.001;
const MAX_HOLDINGS = 120;

function sectionType(sec) {
  const label = sec && sec.label ? String(sec.label) : '';
  if (label.includes('年度')) return 'annual';
  if (label.includes('中报')) return 'semi';
  if (label.includes('季度')) return 'quarter';
  return 'unknown';
}

// 注意：东财把半年报全持仓也标成「XX年2季度股票投资明细」，标签判断不可靠。
// 全持仓的判据是：同一日期下持仓数 > 10（季报固定只有前十大）。
function isFullSection(sec) {
  return sec && sec.holdings && sec.holdings.length > 10;
}

function holdingKey(h) {
  return `${String(h.market || '')}:${String(h.s || '').toUpperCase()}`;
}

function cleanHoldings(holdings, source) {
  return (holdings || [])
    .filter(h => h && h.s && h.w >= MIN_WEIGHT)
    .map(h => ({ ...h, source }))
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_HOLDINGS);
}

function mergeLatestWithFull(latest, full) {
  const map = new Map();
  for (const h of cleanHoldings(full ? full.holdings : [], 'full_report')) {
    map.set(holdingKey(h), h);
  }
  for (const h of cleanHoldings(latest ? latest.holdings : [], 'latest_report')) {
    map.set(holdingKey(h), h);
  }
  return [...map.values()]
    .sort((a, b) => b.w - a.w)
    .slice(0, MAX_HOLDINGS);
}

async function fetchFundHoldings(code) {
  let secs = await fetchHoldingsRaw(code, '', '').catch(() => []);

  if (secs.length === 0) {
    await new Promise(r => setTimeout(r, 1500));
    secs = await fetchHoldingsRaw(code, '', '').catch(() => []);
  }

  const latest0 = secs[0] || null;
  if (!latest0) return { reportDate: null, annualDate: null, totalCount: 0, holdings: [] };

  const latestYear = latest0.date ? Number(String(latest0.date).slice(0, 4)) : new Date().getFullYear();
  const years = [latestYear, latestYear - 1, latestYear - 2].filter(Boolean);

  // 东财接口不稳定：同一请求有时返回季报前十大版本、有时返回半年报全持仓版本。
  // 未发现全持仓分节（行数>10）时重试拉取，最多 3 轮。
  let byYear = [];
  let fullReport = null;
  for (let attempt = 0; attempt < 3 && !fullReport; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
    byYear = [];
    for (const y of years) {
      // month 必须传 3,6,9,12：不传 month 时东财只返回季报前十大，
      // 传了之后 6/30、12/31 分节才是半年报/年报的「全部持仓」
      const yearlySecs = await fetchHoldingsRaw(code, y, '3,6,9,12').catch(() => []);
      byYear.push(...yearlySecs);
    }
    fullReport = byYear.find(isFullSection) || null;
  }

  // 按日期分组，同一日期保留持仓数最多的版本（全持仓覆盖同日期的季报前十大）
  const byDate = new Map();
  for (const sec of [...secs, ...byYear]) {
    const d = String(sec.date || '');
    const prev = byDate.get(d);
    if (!prev || sec.holdings.length > prev.holdings.length) byDate.set(d, sec);
  }
  const mergedSecs = [...byDate.values()]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const latest = mergedSecs[0] || latest0;
  fullReport = fullReport && fullReport.date && String(fullReport.date) <= String(latest.date)
    ? fullReport
    : (mergedSecs.find(isFullSection) || null);

  let holdings = fullReport
    ? mergeLatestWithFull(latest, fullReport)
    : cleanHoldings(latest.holdings, 'latest_report');

  // 裸 4 位代码（台/日难分）在线判别市场，必须在剔除 other 之前完成
  await resolveAmbiguousHoldings(holdings);

  // ISIN 形式持仓（韩股本地解码 / 日股按名称反查代码），同样必须在剔除 other 之前完成
  await resolveIsinHoldings(holdings);

  // 剔除无法定价的市场（other）：它们进了 coverageWeight 却算不出涨跌，
  // 会造成「声称覆盖但实际没算」的系统性偏差
  const droppedOther = holdings.filter(h => !h.market || h.market === 'other');
  holdings = holdings.filter(h => h.market && h.market !== 'other');

  const coverageWeight = holdings.reduce((sum, h) => sum + h.w, 0);

  return {
    reportDate: latest.date,
    annualDate: fullReport ? fullReport.date : null,
    totalCount: holdings.length,
    coverageWeight,
    dataMode: fullReport ? 'latest_plus_full_report' : 'latest_report_only',
    holdings,
    _droppedOther: droppedOther.length,
  };
}

// ═══════════════════════════════════════════════════════
//  Main: fetch all funds and write to data/holdings.json
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('[update-holdings] 开始拉取持仓数据...');
  const results = [];
  for (const f of FUND_LIST) {
    try {
      // 特例基金：静态持仓覆盖（不走东财），或链式采用目标 ETF 的全持仓
      if (FUND_OVERRIDES[f.code]) {
        const ov = FUND_OVERRIDES[f.code];
        if (ov.holdings) {
          console.log(`  ✓ ${f.name} (${f.code}): 静态覆盖 ${ov.holdings[0].name_cn} 覆盖 ${(ov.coverageWeight * 100).toFixed(2)}%`);
          results.push({ name: f.name, code: f.code, ...ov });
          continue;
        }
        const etfData = await fetchFundHoldings(ov.etfCode);
        if (!etfData || etfData.holdings.length === 0) throw new Error(`目标ETF ${ov.etfCode} 持仓为空`);
        console.log(`  ✓ ${f.name} (${f.code}): 目标ETF ${ov.etfCode} 全持仓 ${etfData.holdings.length} 只 [${etfData.reportDate}] 覆盖 ${(etfData.coverageWeight * 100).toFixed(1)}%`);
        results.push({
          name: f.name, code: f.code,
          ...etfData,
          dataMode: ov.dataMode,
          proxyOf: ov.etfCode,
        });
        continue;
      }
      const data = await fetchFundHoldings(f.code);
      const { _droppedOther, ...clean } = data || {};
      if (!clean || clean.holdings.length === 0) {
        console.warn(`  ✗ ${f.name} (${f.code}): empty`);
        results.push({ name: f.name, code: f.code, holdings: [], reportDate: null, annualDate: null, totalCount: 0 });
      } else {
        const cov = ((clean.coverageWeight || 0) * 100).toFixed(1);
        console.log(`  ✓ ${f.name} (${f.code}): ${clean.holdings.length} holdings [${clean.reportDate}] 覆盖 ${cov}%${_droppedOther ? ` (剔除other ${_droppedOther}只)` : ''}`);
        results.push({ name: f.name, code: f.code, ...clean });
      }
    } catch (e) {
      console.error(`  ✗ ${f.name} (${f.code}) failed:`, e.message);
      results.push({ name: f.name, code: f.code, holdings: [], reportDate: null, annualDate: null, totalCount: 0 });
    }
    await new Promise(r => setTimeout(r, 500));  // 节流，避免被东财限流
  }

  // Retry empty funds once
  const emptyIdxs = results.map((r, i) => (!r.holdings || r.holdings.length === 0) ? i : -1).filter(i => i >= 0);
  if (emptyIdxs.length > 0 && emptyIdxs.length < results.length) {
    console.log(`[update-holdings] 重试 ${emptyIdxs.length} 个空基金...`);
    for (const i of emptyIdxs) {
      const f = FUND_LIST[i];
      try {
        await new Promise(r => setTimeout(r, 1000));
        const data = await fetchFundHoldings(f.code);
        if (data && data.holdings.length > 0) {
          console.log(`  ✓ 重试成功: ${f.name} (${f.code}): ${data.holdings.length} holdings`);
          results[i] = { name: f.name, code: f.code, ...data };
        }
      } catch (e) {
        console.error(`  ✗ 重试失败: ${f.name} (${f.code}):`, e.message);
      }
    }
  }

  const outPath = path.join(__dirname, '..', 'data', 'holdings.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');

  const successCount = results.filter(r => r.holdings.length > 0).length;
  console.log(`\n[update-holdings] 完成! ${successCount}/${results.length} 基金有持仓数据`);
  console.log(`[update-holdings] 已写入: ${outPath}`);
}

main().catch((e) => {
  console.error('[update-holdings] 致命错误:', e);
  process.exit(1);
});
