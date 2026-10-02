// 雅虎官方日K代理 — Vercel Serverless Function（仓库根目录 api/，git push 自动部署）
// 用法: GET /api/hist?symbol=2330.TW&tz=8 → { symbol, rows: [{date, close}] }
// 背景：主应用部署在 Render（免费层），其出口 IP 被 Yahoo 429 限流；
//       本函数跑在 Vercel（不同平台 IP 池）兜底取数，仅被 Render 服务端调用。
// 注意：根目录 package.json 为 CommonJS（server.js 用 require），此处用 module.exports。
module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const tz = Number(req.query.tz) || 8;
  if (!/^[A-Za-z0-9.\-]{1,20}$/.test(symbol)) {
    return res.status(400).json({ error: 'bad symbol' });
  }
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  // 双主机容灾：query1 失败（限流/抖动）时换 query2 再试
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr = 'no host tried';
  for (const host of hosts) {
    try {
      const url =
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1d&range=1mo`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      if (!r.ok) { lastErr = `yahoo ${r.status}`; continue; }
      const j = await r.json();
      const result = j && j.chart && j.chart.result && j.chart.result[0];
      if (!result || !result.timestamp) { lastErr = 'empty result'; continue; }
      const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
      const rows = [];
      for (let i = 0; i < result.timestamp.length; i++) {
        const c = closes[i];
        if (c == null || !isFinite(c)) continue;
        rows.push({
          date: new Date(result.timestamp[i] * 1000 + tz * 3600_000).toISOString().slice(0, 10),
          close: c,
        });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      return res.status(200).json({ symbol, rows });
    } catch (e) {
      lastErr = e.message;
    }
  }
  return res.status(502).json({ error: lastErr });
};
