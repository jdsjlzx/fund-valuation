#!/usr/bin/env node
/**
 * 富途 OpenAPI 凭证获取 / 刷新 / 探针（OAuth 2.1 + PKCE）
 *
 * 用法：
 *   node scripts/futu-auth.js login              # 打开浏览器授权，拿到 token 并落盘
 *   node scripts/futu-auth.js status             # 查看当前 token 状态
 *   node scripts/futu-auth.js token              # 打印一个可用的 access_token（过期自动刷新）
 *   node scripts/futu-auth.js snapshot US.SNDK   # 调用行情快照，验证夜盘字段
 *
 * 凭证落在 .futu/token.json（已在 .gitignore 中，勿提交）。
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const API_HOST = 'webapi.futunn.com';
const CALLBACK_PORT = 60355;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const CLIENT_NAME = 'fund-valuation';
const STORE_DIR = path.join(__dirname, '..', '.futu');
const STORE_FILE = path.join(STORE_DIR, 'token.json');

// ── 基础 HTTP ────────────────────────────────────────────────
function request(method, urlPath, { body, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const h = { 'User-Agent': 'fund-valuation/1.0', ...headers };
    if (form) {
      payload = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request({ host: API_HOST, path: urlPath, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 凭证存取 ────────────────────────────────────────────────
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')); } catch { return {}; }
}
function saveStore(data) {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── OAuth 步骤 1：动态注册客户端（公开客户端 + PKCE，无需鉴权）──
async function ensureClient(store) {
  if (store.client_id) return store.client_id;
  const res = await request('POST', '/oauth2/register', {
    body: {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: CLIENT_NAME,
    },
  });
  if (res.status !== 201 || !res.json?.client_id) {
    throw new Error(`注册 OAuth 客户端失败: HTTP ${res.status} ${res.raw.slice(0, 300)}`);
  }
  store.client_id = res.json.client_id;
  store.client_secret = res.json.client_secret || null;
  saveStore(store);
  console.log(`✓ 已注册 OAuth 客户端 client_id = ${store.client_id}`);
  return store.client_id;
}

// ── 预检：OAuth 授权最终会跳到 passport 统一登录域，
//    该域对部分网络（如大陆出口）会直接返回 502 空页，此时浏览器只会白屏。──
const PASSPORT_HOST = 'passport.futunn.com';

function probeHost(host, urlPath = '/') {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host, path: urlPath, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,*/*;q=0.8',
        },
      },
      (res) => {
        let n = 0;
        res.on('data', (d) => (n += d.length));
        res.on('end', () => resolve({ status: res.statusCode, bytes: n, server: res.headers.server || '-' }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, bytes: 0, error: e.message }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ status: 0, bytes: 0, error: 'timeout' }); });
    req.end();
  });
}

async function checkLoginPage() {
  const r = await probeHost(PASSPORT_HOST);
  const ok = r.status >= 200 && r.status < 400 && r.bytes > 500;
  return { ...r, ok };
}

function explainPassportFailure(r) {
  console.log('\n⚠ 登录页不可达：https://' + PASSPORT_HOST + ' 返回 ' + (r.error ? `网络错误(${r.error})` : `HTTP ${r.status}`) + (r.bytes ? `，${r.bytes} 字节` : '，空响应'));
  console.log('');
  console.log('  这不是脚本或浏览器的问题 —— 富途的 OAuth 授权最终会 302 到该登录域。');
  console.log('  常见原因：当前网络出口被富途限制（该域对部分中国大陆出口返回 502 空页面）。');
  console.log('');
  console.log('  可选做法：');
  console.log('  1) 让浏览器走境外出口（开启/切换代理，并确认代理规则覆盖 *.futunn.com），再重新执行 login');
  console.log('  2) 换网络环境（手机热点 / 境外网络）后再执行 login');
  console.log('  3) 改用 OpenD 本地网关（不走网页登录），详见 open.futunn.com 文档');
  console.log('');
  console.log('  提示：授权只需成功一次。拿到 refresh_token 后，后续刷新不再需要打开浏览器。');
  console.log('');
}

// ── probe：一次性体检各项依赖 ────────────────────────────────
async function probe(store) {
  console.log('== 富途 OpenAPI 接入体检 ==\n');

  process.stdout.write('[1/4] API 主机可达性 … ');
  try {
    const t = await request('GET', '/api/v1.0/server-time');
    console.log(t.status === 200 ? `✓ ${API_HOST} 正常（服务器时间 ${t.json?.server_time_ms}）` : `✗ HTTP ${t.status}`);
  } catch (e) { console.log(`✗ ${e.message}`); }

  process.stdout.write('[2/4] OAuth 客户端注册 … ');
  try {
    const cid = await ensureClient(store);
    console.log(`✓ client_id = ${String(cid).slice(0, 8)}…`);
  } catch (e) { console.log(`✗ ${e.message}`); }

  process.stdout.write('[3/4] 登录页（浏览器授权必需）… ');
  const lp = await checkLoginPage();
  console.log(lp.ok ? `✓ ${PASSPORT_HOST} 正常` : `✗ HTTP ${lp.status}${lp.error ? ' (' + lp.error + ')' : ''}`);

  process.stdout.write('[4/4] 当前凭证 … ');
  if (store.access_token) {
    const left = Math.round(((store.expires_at || 0) - Date.now()) / 60000);
    console.log(`✓ 已登录（access_token 剩余 ${left} 分钟，refresh_token ${store.refresh_token ? '有' : '无'}）`);
  } else {
    console.log('未登录');
  }

  console.log('');
  if (!lp.ok) explainPassportFailure(lp);
  else if (!store.access_token) console.log('可以执行：node scripts/futu-auth.js login');
  else console.log('凭证有效，可直接执行：node scripts/futu-auth.js snapshot US.SNDK,US.QQQ');
}

// ── OAuth 步骤 2-4：浏览器授权 → 回调取 code → 换 token ──────
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login(store) {
  const clientId = await ensureClient(store);

  // 先探一次登录页：若本网络访问不到，浏览器只会白屏，提前说清楚
  const lp = await checkLoginPage();
  if (!lp.ok) {
    explainPassportFailure(lp);
    console.log('  已取消本次授权。请按上面任一方式处理后重试。\n');
    process.exit(2);
  }
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authUrl = 'https://' + API_HOST + '/oauth2/authorize/confirm?' + new URLSearchParams({
    client_id: clientId,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
  }).toString();

  console.log('\n即将打开浏览器完成富途账号授权。若未自动打开，手动访问：\n');
  console.log(authUrl + '\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>授权完成，可以关闭本页回到终端。</h2>');
      server.close();
      if (err) return reject(new Error(`授权被拒绝: ${err}`));
      if (gotState !== state) return reject(new Error('state 校验失败，已中止'));
      if (!gotCode) return reject(new Error('回调未携带 code'));
      resolve(gotCode);
    });
    server.on('error', (e) => reject(new Error(`监听 ${CALLBACK_PORT} 失败: ${e.message}`)));
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      exec(`open "${authUrl}"`, () => {});
    });
    setTimeout(() => { server.close(); reject(new Error('等待授权超时（5 分钟）')); }, 300000);
  });

  const res = await request('POST', '/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    },
  });
  if (res.status !== 200 || !res.json?.access_token) {
    throw new Error(`换取 token 失败: HTTP ${res.status} ${res.raw.slice(0, 300)}`);
  }
  Object.assign(store, {
    access_token: res.json.access_token,
    refresh_token: res.json.refresh_token || store.refresh_token,
    scope: res.json.scope,
    expires_at: Date.now() + (res.json.expires_in || 7200) * 1000 - 60_000,
    obtained_at: new Date().toISOString(),
  });
  saveStore(store);
  console.log(`\n✓ 授权成功！token 已保存到 ${path.relative(process.cwd(), STORE_FILE)}`);
  printStatus(store);
}

// ── 刷新 access_token ───────────────────────────────────────
async function refresh(store) {
  if (!store.refresh_token || !store.client_id) throw new Error('缺少 refresh_token / client_id，请先执行 login');
  const form = { grant_type: 'refresh_token', refresh_token: store.refresh_token, client_id: store.client_id };
  if (store.client_secret) form.client_secret = store.client_secret;
  const res = await request('POST', '/oauth2/token', { form });
  if (res.status !== 200 || !res.json?.access_token) {
    throw new Error(`刷新失败: HTTP ${res.status} ${res.raw.slice(0, 300)}`);
  }
  store.access_token = res.json.access_token;
  store.scope = res.json.scope || store.scope;
  store.expires_at = Date.now() + (res.json.expires_in || 7200) * 1000 - 60_000;
  store.refreshed_at = new Date().toISOString();
  saveStore(store);
  return store.access_token;
}

async function getToken(store) {
  if (!store.access_token) throw new Error('尚未登录，请先执行: node scripts/futu-auth.js login');
  if (Date.now() >= (store.expires_at || 0)) {
    console.log('（token 已过期，正在刷新…）');
    return refresh(store);
  }
  return store.access_token;
}

// ── 行情快照探针（验证夜盘字段）─────────────────────────────
const OVERNIGHT_FIELDS = [
  'overnight_price', 'overnight_change_val', 'overnight_change_rate', 'overnight_amplitude',
  'overnight_high_price', 'overnight_low_price', 'overnight_volume', 'overnight_turnover',
];

async function snapshot(store, codes) {
  const token = await getToken(store);
  const headers = { Authorization: `Bearer ${token}` };
  if (process.env.FUTU_NNID) headers['X-Futu-Client-Nnid'] = process.env.FUTU_NNID;
  const res = await request('POST', '/api/v1.0/quote/snapshot', { body: { code_list: codes }, headers });
  if (res.status !== 200 || res.json?.ret_code !== 0) {
    console.log(`HTTP ${res.status} —— ${res.raw.slice(0, 600)}`);
    return;
  }
  for (const s of res.json.data.snapshot_list || []) {
    console.log(`\n── ${s.code}  ${s.sc_name || s.name || ''}`);
    console.log(`   最新价 ${s.last_price}   昨收 ${s.prev_close_price}   数据日期 ${s.data_date}`);
    console.log(`   盘前 ${s.pre_price} (${s.pre_change_rate}%)   盘后 ${s.after_price} (${s.after_change_rate}%)`);
    const has = OVERNIGHT_FIELDS.filter((f) => s[f] !== undefined && s[f] !== 0 && s[f] !== '');
    if (has.length) {
      for (const f of has) console.log(`   夜盘 ${f} = ${s[f]}`);
    } else {
      console.log('   夜盘字段全为 0 / 空 —— 当前非夜盘时段，或该标的无夜盘成交');
    }
  }
}

function printStatus(store) {
  if (!store.access_token) { console.log('状态：未登录'); return; }
  const left = Math.round(((store.expires_at || 0) - Date.now()) / 60000);
  console.log(`client_id     : ${store.client_id}`);
  console.log(`scope         : ${store.scope}`);
  console.log(`access_token  : ${String(store.access_token).slice(0, 12)}…  (剩余 ${left} 分钟)`);
  console.log(`refresh_token : ${store.refresh_token ? String(store.refresh_token).slice(0, 12) + '…' : '（无）'}`);
  console.log(`凭证文件      : ${STORE_FILE}`);
}

// ── 入口 ────────────────────────────────────────────────────
(async () => {
  const cmd = process.argv[2] || 'status';
  const store = loadStore();
  try {
    if (cmd === 'login') await login(store);
    else if (cmd === 'probe') await probe(store);
    else if (cmd === 'refresh') { await refresh(store); console.log('✓ 已刷新'); printStatus(store); }
    else if (cmd === 'status') printStatus(store);
    else if (cmd === 'token') console.log(await getToken(store));
    else if (cmd === 'snapshot') {
      const codes = (process.argv[3] || 'US.SNDK,US.QQQ,US.SPY').split(',').map((s) => s.trim()).filter(Boolean);
      await snapshot(store, codes);
    } else {
      console.log('用法: node scripts/futu-auth.js [probe|login|status|token|refresh|snapshot US.SNDK,US.QQQ]');
      console.log('  probe    体检：API 主机 / 客户端注册 / 登录页可达性 / 当前凭证');
      console.log('  login    打开浏览器完成账号授权（需能访问富途登录页）');
      console.log('  status   查看 token 状态');
      console.log('  token    打印可用的 access_token（过期自动刷新）');
      console.log('  refresh  手动刷新 access_token');
      console.log('  snapshot 拉行情快照，验证夜盘字段');
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
})();
