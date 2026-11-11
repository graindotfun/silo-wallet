#!/usr/bin/env node
// Conformance runner: node conformance/run.mjs --maker-url <url> [options]. See docs/OPEN_MAKER_PROTOCOL.md, "Conformance suite".
// The bearer token comes only from an environment variable (default MAKER_API_TOKEN) and is never printed. No transaction is ever sent from here.
import { runConformance, formatTable, SCOPE_NOTE } from './checks.mjs';

const HELP = `Usage: node conformance/run.mjs --maker-url <url> [options]
  --maker-url <url>             base URL of the maker (required)
  --token-env <NAME>            environment variable holding the bearer token (default MAKER_API_TOKEN; unset = no token sent)
  --direction both|forward|reverse   forward = XMR to SOL, reverse = SOL to XMR (default both; reverse is skipped by health when disabled)
  --amount <xmr>                decimal XMR amount to quote (default 0.002, or the per-swap cap if lower)
  --reference-price <solPerXmr> price you got elsewhere; the quote must stay within --max-deviation-bps of it (default 500)
  --max-deviation-bps <n>
  --program-id <base58>         escrow program id the maker uses (default: the client core default)
  --wait-ttl                    also wait for a quote to expire (about 2 minutes) and check it is refused
  --allow-registration stagenet|devnet
                                OPT IN, test networks only: makes the maker record a swap (XMR to SOL: it locks SOL and pays gas to a
                                throwaway address). Never use against a mainnet maker.
  --solana-rpc <url>            required with --allow-registration: a Solana RPC you trust. Before any registration the suite reads its genesis hash,
                                the maker's own network (GET /v1/status, needs the token) and that the maker address is funded on it; any doubt refuses.
  --allow-mainnet-registration  second flag: without it a mainnet Solana RPC or a mainnet maker is refused. Never use for a quick test.
  --allow-insecure-token        send the token over plain http to a non-local host (refused otherwise)
  --json                        print results as JSON instead of a table
Exit code: 0 when no MUST check failed, 1 otherwise, 2 for a usage error.`;

function parse(argv) {
  const a = { direction: 'both', tokenEnv: 'MAKER_API_TOKEN', maxDeviationBps: 500 };
  const need = (i) => { if (i + 1 >= argv.length) throw new Error(`missing value for ${argv[i]}`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--maker-url': a.makerUrl = need(i++); break;
      case '--token-env': a.tokenEnv = need(i++); break;
      case '--direction': a.direction = need(i++); break;
      case '--amount': a.amount = need(i++); break;
      case '--reference-price': a.referencePrice = Number(need(i++)); break;
      case '--max-deviation-bps': a.maxDeviationBps = Number(need(i++)); break;
      case '--program-id': a.programId = need(i++); break;
      case '--wait-ttl': a.waitTtl = true; break;
      case '--allow-registration': a.allowRegistration = need(i++); break;
      case '--solana-rpc': a.solanaRpc = need(i++); break;
      case '--allow-mainnet-registration': a.allowMainnetRegistration = true; break;
      case '--allow-insecure-token': a.allowInsecureToken = true; break;
      case '--json': a.json = true; break;
      case '--help': case '-h': a.help = true; break;
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  return a;
}

async function main() {
  let a;
  try { a = parse(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n\n' + HELP); return 2; }
  if (a.help) { console.log(HELP); return 0; }
  let url;
  try { url = new URL(a.makerUrl); } catch { console.error('--maker-url is required and must be a URL\n\n' + HELP); return 2; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { console.error('--maker-url must be http(s) without credentials'); return 2; }
  if (!['both', 'forward', 'reverse'].includes(a.direction)) { console.error('bad --direction'); return 2; }
  if (a.amount !== undefined && !/^\d{1,4}(\.\d{1,12})?$/.test(a.amount)) { console.error('bad --amount'); return 2; }
  if (a.referencePrice !== undefined && !(a.referencePrice > 0)) { console.error('bad --reference-price'); return 2; }
  if (a.allowRegistration && !['stagenet', 'devnet'].includes(a.allowRegistration)) { console.error('--allow-registration takes stagenet or devnet'); return 2; }
  if (a.allowRegistration && !a.solanaRpc) { console.error('--allow-registration needs --solana-rpc <url> so the network can be checked before anything is registered'); return 2; }
  if (a.allowMainnetRegistration && !a.allowRegistration) { console.error('--allow-mainnet-registration only modifies --allow-registration'); return 2; }
  if (a.solanaRpc) { try { const r = new URL(a.solanaRpc); if (!['http:', 'https:'].includes(r.protocol)) throw new Error('x'); } catch { console.error('--solana-rpc must be an http(s) URL'); return 2; } }
  const token = process.env[a.tokenEnv] || null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (token && url.protocol === 'http:' && !local && !a.allowInsecureToken) { console.error('refusing to send a token over plain http to a non-local host (use https, or --allow-insecure-token)'); return 2; }
  const { results, maker } = await runConformance({ makerUrl: url.origin + url.pathname.replace(/\/+$/, ''), token, direction: a.direction, amount: a.amount, referencePrice: a.referencePrice, maxDeviationBps: a.maxDeviationBps, programId: a.programId, waitTtl: a.waitTtl, allowRegistration: a.allowRegistration || false, solanaRpc: a.solanaRpc, allowMainnetRegistration: a.allowMainnetRegistration === true });
  if (a.json) console.log(JSON.stringify({ makerUrl: url.origin, maker, results }, null, 2));
  else { console.log(`maker ${url.origin}${maker ? `  address ${maker}` : ''}\n`); console.log(formatTable(results)); console.log(`\n${SCOPE_NOTE}`); }
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
process.exitCode = await main();
