#!/usr/bin/env node
// Reference command line client for the SOL -> XMR swap. See README.md. Reads every endpoint from flags or the environment, prints none of them.
//   silo-swap quote   --xmr 0.01
//   silo-swap start   --xmr 0.01 --network devnet --keypair KEY.json --xmr-address ADDR --record swap.json --maker-address ADDR --max-sol-per-xmr 8 --own-node [--yes]
//   silo-swap resume  --record swap.json --keypair KEY.json
//   silo-swap status  --record swap.json
//   silo-swap refund  --record swap.json --keypair KEY.json
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createForwardSession, checkForwardQuote, describeForwardTerms, forwardPhaseLine, forwardOutcomeOf } from './swap-lib-xmr-sol.mjs';
import { createMakerClient, createSession, createDaemonHeight, loadKeypair, SwapRefusal, outcomeOf, phaseLine, parseXmrAmount, checkQuote, describeTerms, utc, peekSwapFile, readOwnFile } from './swap-lib.mjs';
import { createLogger, describeError } from './swap-log.mjs';

const OPTIONS = {
  maker: { type: 'string' }, 'solana-rpc': { type: 'string' }, 'monero-wallet-rpc': { type: 'string' }, 'monero-node': { type: 'string' },
  'monero-login-file': { type: 'string' }, 'record-passphrase-file': { type: 'string' }, keypair: { type: 'string' }, 'xmr-address': { type: 'string' }, record: { type: 'string' },
  xmr: { type: 'string' }, network: { type: 'string' }, 'max-sol': { type: 'string' }, 'max-spread-bps': { type: 'string' },
  'maker-address': { type: 'string' }, 'allow-unverified-maker': { type: 'boolean' }, 'max-sol-per-xmr': { type: 'string' }, 'own-node': { type: 'boolean' }, 'remote-node-ok': { type: 'boolean' },
  direction: { type: 'string' }, 'sol-address': { type: 'string' }, 'monero-wallet': { type: 'string' }, 'monero-wallet-password-file': { type: 'string' }, 'min-sol-per-xmr': { type: 'string' }, 'second-solana-rpc': { type: 'string' },
  yes: { type: 'boolean' }, detach: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
};
const USAGE = `silo-swap: reference client for SOL to XMR and XMR to SOL swaps against a maker you choose (--direction sol-xmr | xmr-sol).
Commands: quote | start | resume | status | refund. See README.md.
Endpoints come from the environment (preferred, URLs may contain keys) or flags:
  SWAP_MAKER_URL  SWAP_MAKER_TOKEN (only if the maker needs one)  SWAP_SOLANA_RPC_URL  SWAP_MONERO_WALLET_RPC_URL  SWAP_MONERO_NODE_URL  SWAP_MONERO_RPC_LOGIN_FILE
The swap file is encrypted with a passphrase you choose (at least 12 characters): SWAP_RECORD_PASSPHRASE, or --record-passphrase-file, or you are asked.
Nothing else is contacted and no endpoint has a default. Not covered: Tor (connections are direct), and whether your Monero node is independent of anyone
(--own-node is your statement, this tool cannot check it). Your Monero wallet RPC receives swap private keys. status can create and open wallet files in
the wallet RPC. refund also moves the XMR to your address if the maker has already claimed.`;

const limitOf = (text) => { const n = Number(text); if (!(Number.isFinite(n) && n > 0)) throw new SwapRefusal('bad-amount', '--max-sol-per-xmr must be a positive number'); return n; };
const lamportsOf = (text) => { if (!/^\d{1,6}(\.\d{1,9})?$/.test(text)) throw new SwapRefusal('bad-amount', '--max-sol must be a decimal number such as 0.5'); const [i, f = ''] = text.split('.'); return Number(BigInt(i) * 10n ** 9n + BigInt(f.padEnd(9, '0'))); };

/** Asks for a passphrase on a terminal without echoing it. */
async function askHidden(text) {
  let muted = false;
  const sink = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  try { process.stdout.write(text); muted = true; const a = await rl.question(''); process.stdout.write('\n'); return a; } finally { muted = false; rl.close(); }
}

/** main(argv, { env, out, err, fetcher, now, sleep, confirm }) -> exit code. Everything outside the user's three endpoints is injectable for tests. */
export async function main(argv, { env = process.env, out: outRaw = (s) => console.log(s), err: errRaw = (s) => console.error(s), fetcher = fetch, now = Date.now, sleep, confirm: confirmIn, passphraseAsk = askHidden, recordKdf, recordMinKdfN } = {}) {
  // ONE logging boundary: everything printed goes through it. `secrets` fills as settings are read; the boundary reads it at every call.
  const secrets = [];
  const outLog = createLogger({ sink: outRaw, secrets: () => secrets }), errLog = createLogger({ sink: errRaw, secrets: () => secrets });
  const out = outLog.show, err = errLog.show;   // program-authored lines (terms with public addresses); phase lines and errors use .line / .error below
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }); } catch (e) { err(`${e.message}\n${USAGE}`); return 1; }
  const { values: v, positionals } = parsed, cmd = positionals[0];
  if (v.help || !cmd) { out(USAGE); return cmd ? 0 : 1; }
  const pick = (flag, envName) => { const x = v[flag] ?? env[envName]; if (x) secrets.push(x); return x; };
  const token = env.SWAP_MAKER_TOKEN ?? null; if (token) secrets.push(token);
  try {
    const makerUrl = pick('maker', 'SWAP_MAKER_URL'), solanaRpcUrl = pick('solana-rpc', 'SWAP_SOLANA_RPC_URL');
    const walletUrl = pick('monero-wallet-rpc', 'SWAP_MONERO_WALLET_RPC_URL'), nodeUrl = pick('monero-node', 'SWAP_MONERO_NODE_URL');
    const loginFile = v['monero-login-file'] ?? env.SWAP_MONERO_RPC_LOGIN_FILE;
    const login = loginFile ? readFileSync(loginFile, 'utf8').trim() : null; if (login) secrets.push(login);
    const need = (x, what) => { if (!x) throw new SwapRefusal('missing-setting', `Missing ${what}. Nothing was contacted.`); return x; };
    const key = v.keypair ? loadKeypair(v.keypair) : null;
    if (key?.looseMode) err('Warning: the key file can be read by other users. Restrict it (chmod 600).');
    const passphraseFile = v['record-passphrase-file'] ?? env.SWAP_RECORD_PASSPHRASE_FILE;
    let passphrase = env.SWAP_RECORD_PASSPHRASE ?? (passphraseFile ? readOwnFile(passphraseFile).replace(/[\r\n]+$/, '') : null);
    const needPassphrase = async () => { if (passphrase) return passphrase; if (!process.stdin.isTTY && !confirmIn) throw new SwapRefusal('passphrase-missing', 'The swap file is encrypted: set SWAP_RECORD_PASSPHRASE or pass --record-passphrase-file.'); passphrase = await passphraseAsk('Swap file passphrase (at least 12 characters, not shown): '); if (!passphrase) throw new SwapRefusal('passphrase-missing', 'No passphrase was given.'); secrets.push(passphrase); return passphrase; };
    if (passphrase) secrets.push(passphrase);
    const maker = createMakerClient({ url: need(makerUrl, 'maker URL (SWAP_MAKER_URL or --maker)'), token, fetcher });

    const minLimit = v['min-sol-per-xmr'] ? limitOf(v['min-sol-per-xmr']) : null;
    const fileDirection = () => peekSwapFile(v.record)?.direction ?? 'sol-xmr';   // the clear, authenticated-on-open header
    const direction = (cmd === 'quote' || cmd === 'start') ? (v.direction ?? 'sol-xmr') : (v.record ? fileDirection() : 'sol-xmr');
    if (direction !== 'sol-xmr' && direction !== 'xmr-sol') throw new SwapRefusal('bad-direction', '--direction must be sol-xmr or xmr-sol.');

    if (cmd === 'quote' && direction === 'xmr-sol') {
      const xmr = need(v.xmr, '--xmr'); const atomic = parseXmrAmount(xmr);
      const q = await maker.quoteForward(xmr);
      const terms = checkForwardQuote(q, { xmrAtomic: atomic, now: Math.floor(now() / 1000), minSolPerXmr: minLimit, maxSpreadBps: v['max-spread-bps'] ? Number(v['max-spread-bps']) : undefined });
      if (v.json) out(JSON.stringify({ ok: true, ...terms })); else for (const l of describeForwardTerms(terms, { network: v.network === 'mainnet' ? 'mainnet' : 'devnet', solAddress: v['sol-address'] ?? '<your Solana address>' })) out(l);
      return 0;
    }
    if (cmd === 'quote') {
      // Quote only: one request to the maker. No chain, no Monero, no state.
      const xmr = need(v.xmr, '--xmr'); const atomic = parseXmrAmount(xmr);
      const q = await maker.quote(xmr);
      const terms = checkQuote(q, { xmrAtomic: atomic, now: Math.floor(now() / 1000), owner: key?.address ?? null, maxLamports: v['max-sol'] ? lamportsOf(v['max-sol']) : null, maxSolPerXmr: v['max-sol-per-xmr'] ? limitOf(v['max-sol-per-xmr']) : null, expectedMaker: v['maker-address'] ?? env.SWAP_MAKER_ADDRESS ?? null, maxSpreadBps: v['max-spread-bps'] ? Number(v['max-spread-bps']) : undefined });
      if (v.json) out(JSON.stringify({ ok: true, ...terms })); else for (const l of describeTerms(terms, { network: v.network === 'mainnet' ? 'mainnet' : 'devnet', now: Math.floor(now() / 1000) })) out(l);
      if (terms.tiers !== null && !v.json) out(`The maker also lists ${terms.tiers} optional tier(s); this client ignores them.`);
      return 0;
    }

    const record = need(v.record, '--record (the swap file)');
    // resume, status and refund read the network from the swap file; start needs it named.
    let network = v.network; if (!network && cmd !== 'start') network = peekSwapFile(record)?.network;
    const recordPassphrase = cmd === 'status' || cmd === 'start' || cmd === 'resume' || cmd === 'refund' ? await needPassphrase() : null;
    if (direction === 'xmr-sol') return await forwardCommands({ cmd, v, env, out, err, outLog, fetcher, now, sleep, confirmIn, maker, secrets, record, network, solanaRpcUrl, walletUrl, nodeUrl, login, minLimit, need, recordPassphrase, recordKdf, recordMinKdfN });
    const session = createSession({
      network: need(network, '--network (mainnet or devnet)'), solanaRpcUrl: need(solanaRpcUrl, 'Solana RPC URL (SWAP_SOLANA_RPC_URL)'), moneroWalletRpcUrl: need(walletUrl, 'Monero wallet RPC URL (SWAP_MONERO_WALLET_RPC_URL)'),
      moneroLogin: login, daemonHeight: nodeUrl ? createDaemonHeight({ url: nodeUrl, fetchImpl: fetcher }) : null, keypair: key?.keypair ?? null, owner: key?.address ?? null,
      xmrAddress: v['xmr-address'] ?? null, recordPath: record, recordPassphrase, recordKdf, recordMinKdfN, secrets, maker, fetcher, now, sleep, log: (s) => out(s),
      maxLamports: v['max-sol'] ? lamportsOf(v['max-sol']) : null, maxSolPerXmr: v['max-sol-per-xmr'] ? limitOf(v['max-sol-per-xmr']) : null, maxSpreadBps: v['max-spread-bps'] ? Number(v['max-spread-bps']) : undefined,
      expectedMaker: v['maker-address'] ?? env.SWAP_MAKER_ADDRESS ?? null, allowUnverifiedMaker: !!v['allow-unverified-maker'],
      nodeOwnership: v['own-node'] ? 'own' : v['remote-node-ok'] ? 'remote-accepted' : null,
    });
    const onPhase = (x) => outLog.line(`[${utc(Math.floor(now() / 1000))}] ${phaseLine(x)}`);
    const need2 = () => { if (!key) throw new SwapRefusal('keypair-missing', 'This command needs --keypair.'); };
    let result;
    if (cmd === 'start') {
      const confirm = confirmIn ?? (async () => {
        if (v.yes) return true;
        if (!process.stdin.isTTY) throw new SwapRefusal('confirm-needed', 'Not a terminal: pass --yes to confirm the terms shown above.');
        const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return (await rl.question('Type "lock" to accept these terms: ')).trim() === 'lock'; } finally { rl.close(); }
      });
      result = await session.start({ xmr: need(v.xmr, '--xmr'), confirm, until: v.detach ? 'locked' : 'done', onPhase });
    } else if (cmd === 'resume') { need2(); result = await session.resume({ until: v.detach ? 'locked' : 'done', onPhase }); }
    else if (cmd === 'refund') {
      need2(); result = await session.refund();
      if (result?.phase === 'not-refundable') { out('No refund is possible right now (the swap has not locked, or the swap rules do not allow one yet). Run status for the times.'); return 4; }
    } else if (cmd === 'status') {
      const s = await session.status();
      if (v.json) out(JSON.stringify({ phase: s.phase, schedule: s.schedule, result: s.record?.result ?? null })); else {
        out(s.record ? `Swap ${s.record.swapId.slice(0, 16)}: ${phaseLine({ ...(s.view ?? {}), phase: s.phase, record: s.record })}` : 'The swap file has no swap in it yet.');
        if (s.record?.t0) out(`Times: confirm by ${utc(s.schedule.confirmBy)}, t0 ${utc(s.schedule.t0)}, t1 ${utc(s.schedule.t1)}; refund after a confirmation: ${utc(s.schedule.refundAfterConfirmEarliest)} to ${utc(s.schedule.refundAfterConfirmLatest)}.`);
      }
      return s.record?.status === 'done' ? outcomeOf(s.view ?? { record: s.record }).code : 0;
    } else { err(USAGE); return 1; }
    const o = outcomeOf(result); out(`Outcome: ${o.text}`); return o.code;
  } catch (e) {
    // A refusal of this tool prints its own (scrubbed) message with its code; anything else prints only a fixed public code, never the raw message.
    errLog.error(e instanceof SwapRefusal ? Object.assign(e, { message: `${e.message} [${e.code}]` }) : new Error(`[${describeError(e, secrets)}]`)); return e instanceof SwapRefusal ? 2 : 1;
  }
}

/** XMR to SOL commands. Same endpoints, plus the user's funding wallet; the Solana address that receives the SOL needs no key file. */
async function forwardCommands({ cmd, v, env, out, err, outLog, recordPassphrase, recordKdf, recordMinKdfN, fetcher, now, sleep, confirmIn, maker, secrets, record, network, solanaRpcUrl, walletUrl, nodeUrl, login, minLimit, need }) {
  const second = v['second-solana-rpc'] ?? env.SWAP_SECOND_SOLANA_RPC_URL ?? null; if (second) secrets.push(second);
  const pwFile = v['monero-wallet-password-file'] ?? env.SWAP_MONERO_WALLET_PASSWORD_FILE;
  const walletPassword = pwFile ? readFileSync(pwFile, 'utf8').replace(/[\r\n]+$/, '') : ''; if (walletPassword) secrets.push(walletPassword);
  const prompt = async (text, word) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return (await rl.question(text)).trim() === word; } finally { rl.close(); } };
  const ask = (word, text) => async () => { if (v.yes) return true; if (!process.stdin.isTTY) throw new SwapRefusal('confirm-needed', 'Not a terminal: pass --yes to confirm.'); return prompt(text, word); };
  const session = createForwardSession({
    network: need(network, '--network (mainnet or devnet)'), solanaRpcUrl: need(solanaRpcUrl, 'Solana RPC URL (SWAP_SOLANA_RPC_URL)'), secondSolanaRpcUrl: second,
    moneroWalletRpcUrl: need(walletUrl, 'Monero wallet RPC URL (SWAP_MONERO_WALLET_RPC_URL)'), moneroLogin: login, fundingWallet: v['monero-wallet'] ?? env.SWAP_MONERO_WALLET ?? null, fundingWalletPassword: walletPassword,
    daemonHeight: nodeUrl ? createDaemonHeight({ url: nodeUrl, fetchImpl: fetcher }) : null, solAddress: v['sol-address'] ?? null, xmrAddress: v['xmr-address'] ?? null,
    expectedMaker: v['maker-address'] ?? env.SWAP_MAKER_ADDRESS ?? null, minSolPerXmr: minLimit, maxSpreadBps: v['max-spread-bps'] ? Number(v['max-spread-bps']) : undefined,
    recordPath: record, recordPassphrase, recordKdf, recordMinKdfN, secrets, maker, fetcher, now, sleep, log: (s) => out(s),
    confirmPayment: confirmIn ? async (info) => confirmIn(info) : async (info) => {
      out(`About to pay ${info.amount} XMR to the shared address ${info.address} from your wallet.`);
      out(`You receive ${info.sol} SOL at ${info.solAddress}. You must claim before ${utc(info.claimBy)} (t1 ${utc(info.t1)}).`);
      out('If you miss that time and the maker stays silent, you cannot move this XMR alone.');
      return ask('pay', 'Type "pay" to send the XMR: ')();
    },
  });
  const onPhase = (x) => outLog.line(`[${utc(Math.floor(now() / 1000))}] ${forwardPhaseLine(x)}`);
  let result;
  if (cmd === 'start') {
    const confirm = confirmIn ? async () => true : ask('accept', 'Type "accept" to register with the maker on these terms: ');
    result = await session.start({ xmr: need(v.xmr, '--xmr'), confirm, until: v.detach ? 'paid' : 'done', onPhase });
  } else if (cmd === 'resume') result = await session.resume({ until: v.detach ? 'paid' : 'done', onPhase });
  else if (cmd === 'refund') { out('XMR to SOL has no refund command: the maker refunds its own SOL after t1, and resume then moves your XMR back to your address. Run status or resume.'); return 4; }
  else if (cmd === 'status') {
    const s = await session.status();
    out(s.record ? `Swap ${s.record.swapId.slice(0, 16)}: ${forwardPhaseLine({ ...(s.view ?? {}), phase: s.phase, record: s.record })}` : 'The swap file has no swap in it yet.');
    if (s.schedule) out(`Times: pay by ${utc(s.schedule.fundBy)}, t0 ${utc(s.schedule.t0)}, claim by ${utc(s.schedule.claimBy)}, t1 ${utc(s.schedule.t1)}.`);
    return s.record?.status === 'done' ? forwardOutcomeOf(s.view ?? { record: s.record }).code : 0;
  } else { err(USAGE); return 1; }
  const o = forwardOutcomeOf(result); out(`Outcome: ${o.text}`); return o.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
