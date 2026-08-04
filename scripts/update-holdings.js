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
  { name: '易方达标普信息科技',    code: '161128' },
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
  { name: '摩根太平洋科技对冲',   code: '968061' },
  { name: '华夏大中华混合(QDII)', code: '002230' },
];

const KR_STOCKS = new Set(['000660', '005930']);

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

    if (market === 'other' && KR_STOCKS.has(ticker)) market = 'KR';

    const w = parseFloat(stripTags(weightCell).replace('%', '')) / 100;
    if (isNaN(w) || w <= 0) continue;

    rows.push({ s: ticker, w, name_cn: stripTags(nameCell), market });
  }
  return rows;
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
const MAX_HOLDINGS = 80;

function sectionType(sec) {
  const label = sec && sec.label ? String(sec.label) : '';
  if (label.includes('年度')) return 'annual';
  if (label.includes('中报')) return 'semi';
  if (label.includes('季度')) return 'quarter';
  return 'unknown';
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

  const latest = secs[0] || null;
  if (!latest) return { reportDate: null, annualDate: null, totalCount: 0, holdings: [] };

  const latestYear = latest.date ? Number(String(latest.date).slice(0, 4)) : new Date().getFullYear();
  const years = [latestYear, latestYear - 1, latestYear - 2].filter(Boolean);
  const byYear = [];
  for (const y of years) {
    const yearlySecs = await fetchHoldingsRaw(code, y, '').catch(() => []);
    byYear.push(...yearlySecs);
  }

  const allSecs = [...secs, ...byYear];
  const fullReport = allSecs
    .filter(sec => sectionType(sec) === 'annual' || sectionType(sec) === 'semi')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;

  const holdings = fullReport
    ? mergeLatestWithFull(latest, fullReport)
    : cleanHoldings(latest.holdings, 'latest_report');
  const coverageWeight = holdings.reduce((sum, h) => sum + h.w, 0);

  return {
    reportDate: latest.date,
    annualDate: fullReport ? fullReport.date : null,
    totalCount: holdings.length,
    coverageWeight,
    dataMode: fullReport ? 'latest_plus_full_report' : 'latest_report_only',
    holdings,
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
      const data = await fetchFundHoldings(f.code);
      if (!data || data.holdings.length === 0) {
        console.warn(`  ✗ ${f.name} (${f.code}): empty`);
        results.push({ name: f.name, code: f.code, holdings: [], reportDate: null, annualDate: null, totalCount: 0 });
      } else {
        console.log(`  ✓ ${f.name} (${f.code}): ${data.holdings.length} holdings [${data.reportDate}]`);
        results.push({ name: f.name, code: f.code, ...data });
      }
    } catch (e) {
      console.error(`  ✗ ${f.name} (${f.code}) failed:`, e.message);
      results.push({ name: f.name, code: f.code, holdings: [], reportDate: null, annualDate: null, totalCount: 0 });
    }
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
