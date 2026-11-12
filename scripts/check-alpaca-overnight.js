#!/usr/bin/env node
// 验证 Blue Ocean ATS 夜盘直连是否可用（Alpaca 免费套餐即含 feed=overnight）。
//
// 用法：
//   node scripts/check-alpaca-overnight.js            # 默认 QQQ,SPY,IWM,SMH
//   node scripts/check-alpaca-overnight.js QQQ,SPY
//
// key 来源（二选一）：
//   export ALPACA_KEY_ID=xxx ALPACA_SECRET_KEY=yyy
//   或 data/alpaca.json  {"keyId":"xxx","secretKey":"yyy"}
//
// 判读：
//   - 账号/行情权限不对 -> 401/403，脚本会打印上游原文
//   - 夜盘时段才有 overnight feed；美东 20:00–04:00 之外返回空是正常的
//   - 顺手和本机服务 /api/night（雪球）对比，差 0.1pp 以上说明雪球这批锚已经旧了

const fs = require('fs');
const path = require('path');

function readKey() {
  let id = (process.env.ALPACA_KEY_ID || '').trim();
  let secret = (process.env.ALPACA_SECRET_KEY || '').trim();
  if (id && secret) return { id, secret, from: 'env' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'alpaca.json'), 'utf8'));
    id = String(j.keyId || j.key || '').trim();
    secret = String(j.secretKey || j.secret || '').trim();
    if (id && secret) return { id, secret, from: 'data/alpaca.json' };
  } catch { /* 未配置 */ }
  return null;
}

async function main() {
  const symbols = (process.argv[2] || 'QQQ,SPY,IWM,SMH').split(',').map(s => s.trim()).filter(Boolean);
  const cfg = readKey();
  if (!cfg) {
    console.log('未找到 key。任选一种方式配置后重跑：');
    console.log('  1) export ALPACA_KEY_ID=... ALPACA_SECRET_KEY=...');
    console.log('  2) 写 data/alpaca.json：{"keyId":"...","secretKey":"..."}');
    console.log('\nkey 申请：alpaca.markets 注册（免费）→ Home → API Keys → 生成');
    process.exit(1);
  }
  console.log(`key 来源 ${cfg.from}，标的 ${symbols.join(',')}\n`);

  const url = `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=overnight`;
  const r = await fetch(url, {
    headers: { 'APCA-API-KEY-ID': cfg.id, 'APCA-API-SECRET-KEY': cfg.secret },
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  if (!r.ok) {
    console.log(`HTTP ${r.status}`);
    console.log(text.slice(0, 400));
    console.log('\n401/403：key 错或未开通行情；422：feed 参数不被该套餐支持。');
    process.exit(1);
  }
  const body = JSON.parse(text);
  const src = body.snapshots || body;
  const bj = t => (t ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—');

  for (const sym of symbols) {
    const s = src[sym];
    if (!s) { console.log(`${sym}  无数据（可能不在夜盘时段，或该标的不支持 overnight）`); continue; }
    const q = s.latestQuote || {}, tr = s.latestTrade || {};
    const bid = Number(q.bp), ask = Number(q.ap);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    console.log(`${sym}  quote ${bid}/${ask} 中价 ${mid ? mid.toFixed(2) : '—'}  时间 ${bj(q.t)}`);
    console.log(`      trade ${Number.isFinite(Number(tr.p)) ? tr.p : '—'} @ ${bj(tr.t)}  (免费套餐成交延迟 15 分钟)`);
  }

  // 与本机服务的雪球链路对照
  for (const sym of symbols) {
    try {
      const n = await (await fetch(`http://localhost:3000/api/night?symbol=${sym}`, { signal: AbortSignal.timeout(5000) })).json();
      const a = src[sym] && src[sym].latestQuote;
      if (!n || n.percentNight == null) continue;
      const qq = await (await fetch('http://localhost:3000/api/quotes?symbols=' + sym)).json().catch(() => null);
      const ourPct = qq && qq.data && qq.data[0] && qq.data[0].overnightChangePercent;
      console.log(`\n${sym} 雪球 pct ${n.percentNight.toFixed(3)}%（批次 ${bj(n.timestampNight)}）`
        + (Number.isFinite(ourPct) ? ` · 服务给值 ${ourPct.toFixed(3)}%` : ''));
    } catch { /* 服务未启动时跳过对照 */ }
  }
}

main().catch(e => { console.error('[check-alpaca]', e.message); process.exit(1); });
