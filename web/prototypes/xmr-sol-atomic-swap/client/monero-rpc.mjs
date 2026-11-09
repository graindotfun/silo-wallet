// grainpad-private-scope: xmr-rewards-vouchers
// JSON-RPC with HTTP Digest authentication for loopback wallet RPC; no secrets in URLs/logs.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
const md5 = (s) => createHash('md5').update(s).digest('hex');
export function rpcClient(url, { timeoutMs = 60000, username, password, fetchImpl = fetch } = {}) {
  const base = new URL(url);
  if (base.username || base.password) throw Error('RPC credentials must not be embedded in URLs');
  if (username && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && base.protocol !== 'https:') throw Error('Authenticated remote RPC requires HTTPS');
  let nc = 0;
  const transport = base.protocol === 'https:' ? https : http;
  const agent = username ? new transport.Agent({ keepAlive: true, maxSockets: 1 }) : null;
  const authFetch = (target, opts) => new Promise((resolve, reject) => {
    const req = transport.request(target, { method: opts.method, headers: opts.headers, agent, signal: opts.signal }, (res) => {
      const chunks = []; res.on('data', (x) => chunks.push(x)); res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(opts.body);
  });
  async function postOnce(path, body) {
    const target = url.replace(/\/$/, '') + path, data = JSON.stringify(body);
    const send = (auth) => (username && fetchImpl === fetch ? authFetch : fetchImpl)(target, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: data, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    let r = await send();
    if (r.status === 401 && username) {
      const challenge = (r.headers.get('www-authenticate') || '').split(/,\s*Digest /)[0];
      if (!challenge.startsWith('Digest ')) throw Error('RPC requires unsupported authentication');
      const attrs = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      if (!attrs.realm || !attrs.nonce || (attrs.algorithm && attrs.algorithm.toUpperCase() !== 'MD5') || !attrs.qop?.split(',').includes('auth')) throw Error('Unsupported RPC digest challenge');
      const uri = new URL(target).pathname + new URL(target).search, cnonce = randomBytes(16).toString('hex'), count = (++nc).toString(16).padStart(8, '0');
      const response = md5(`${md5(`${username}:${attrs.realm}:${password}`)}:${attrs.nonce}:${count}:${cnonce}:auth:${md5(`POST:${uri}`)}`);
      const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const auth = `Digest username=${q(username)}, realm=${q(attrs.realm)}, nonce=${q(attrs.nonce)}, uri=${q(uri)}, response=${q(response)}, algorithm=MD5, qop="auth", nc=${count}, cnonce=${q(cnonce)}` + (attrs.opaque ? `, opaque=${q(attrs.opaque)}` : '');
      await r.arrayBuffer(); r = await send(auth);
    }
    if (!r.ok) throw Error(`RPC HTTP ${r.status}`);
    return r.json();
  }
  const readMethods = new Set(['get_info','get_version','get_block','get_block_header_by_height','get_height','get_balance','get_address']);
  // monero-wallet-rpc's digest auth breaks when two authenticated requests interleave (each 401
  // challenge replaces the nonce the other is answering). Authenticated calls therefore run one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  async function post(path, body) { return username ? serial(() => postDirect(path, body)) : postDirect(path, body); }
  async function postDirect(path, body) {
    const readOnly = ['127.0.0.1','localhost','[::1]'].includes(base.hostname) && (path === '/get_transactions' || (path === '/json_rpc' && readMethods.has(body.method)));
    for (let attempt=0;;attempt++) {
      try { return await postOnce(path, body); }
      catch (e) {
        const reset = (e instanceof TypeError && ['fetch failed','terminated'].includes(e.message)) || ['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(e.code);
        // A closed keep-alive socket can race a new read. Never replay a signer, wallet mutation or broadcast.
        if (!readOnly || attempt >= 1 || !reset) throw e;
      }
    }
  }
  const call = async (method, params = {}) => {
    const j = await post('/json_rpc', { jsonrpc: '2.0', id: '0', method, params });
    if (j.error) { const e = Error(`${method}: ${j.error.message}`); e.code = j.error.code; throw e; }
    if (!j.result) throw Error('RPC response has no result');
    return j.result;
  };
  call.close = () => agent?.destroy();
  call.other = (path, body = {}) => post(path, body);
  return call;
}
