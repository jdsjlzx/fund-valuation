// 雪球美股夜盘代理 — Vercel Serverless Function
// 用法: GET /api/night?symbol=MKSI → { symbol, currentNight, percentNight,
//        chgNight, timestampNight }
// 背景：主应用本地出口 IP 被雪球反爬拉黑（返回防爬 HTML「访问提示」页），
//       Render 出口也可能被拉黑；本函数跑在 Vercel（不同平台 IP 池）兜底取数。
//       percent_night_session 即富途 App「夜盘」涨幅（同源 Blue Ocean，相对正股收盘价）。
// 夜盘成交稀疏，CDN 缓存 30s 足够，同时保护雪球调用量。
module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!/^[A-Za-z0-9_\-]{1,10}$/.test(symbol)) {
    return res.status(400).json({ error: 'bad symbol' });
  }
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  try {
    // 访问主站拿 session cookie（xq_a_token 等），直接调 quote.json 会 400016 鉴权失败
    const home = await fetch('https://xueqiu.com/hq', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
    });
    const setCookies = home.headers.getSetCookie ? home.headers.getSetCookie() : [];
    const cookie = setCookies.map((s) => s.split(';')[0]).join('; ');

    const url = `https://stock.xueqiu.com/v5/stock/quote.json?symbol=${encodeURIComponent(symbol)}&extend=detail`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://xueqiu.com/', ...(cookie ? { Cookie: cookie } : {}) },
    });
    if (!r.ok) return res.status(r.status).json({ error: `xueqiu ${r.status}` });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) {
      // 防爬 HTML（访问提示页）→ 视为被限流
      return res.status(502).json({ error: 'anti-crawl html' });
    }
    const q = j && j.data && j.data.quote;
    if (!q || q.current_night_session == null) {
      return res.status(404).json({ error: 'no night data' });
    }
    return res.status(200).json({
      symbol,
      currentNight: q.current_night_session,
      percentNight: q.percent_night_session,
      chgNight: q.chg_night_session,
      timestampNight: q.timestamp_night_session,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
