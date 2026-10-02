// 雅虎美股夜盘(fullday)代理 — Vercel Serverless Function
// 用法: GET /api/fullday?symbol=ASML → { symbol, fulldayPrice, fulldayChangePercent,
//        fulldayChange, previousClose, regularMarketPrice }
// 背景：主应用本地出口访问雅虎被墙(403)、Render 出口被 429 限流；
//       雪球夜盘源被限流时，本函数提供真实的夜盘盘前盘后价（与富途口径一致）。
// 夜盘成交稀疏，CDN 缓存 60s 足够，同时保护雅虎调用量。
module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!/^[A-Za-z0-9.\-]{1,20}$/.test(symbol)) {
    return res.status(400).json({ error: 'bad symbol' });
  }
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr = 'no host tried';
  for (const host of hosts) {
    try {
      const url =
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1d&range=1d&includePrePost=true`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      if (!r.ok) { lastErr = `yahoo ${r.status}`; continue; }
      const j = await r.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!meta) { lastErr = 'empty result'; continue; }
      if (!meta.hasPrePostMarketData) {
        // 当前没有盘前/盘后/夜盘活动，fulldayPrice 不可用
        return res.status(200).json({ symbol, noPrePost: true });
      }
      return res.status(200).json({
        symbol,
        fulldayPrice: meta.fulldayPrice,
        fulldayChange: meta.fulldayChange,
        fulldayChangePercent: meta.fulldayChangePercent,
        previousClose: meta.chartPreviousClose || meta.previousClose,
        regularMarketPrice: meta.regularMarketPrice,
      });
    } catch (e) {
      lastErr = e.message;
    }
  }
  return res.status(502).json({ error: lastErr });
};
