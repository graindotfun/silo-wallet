// Child process of swap-lock-race.test.mjs. Throwaway test helper: argv = mode, record path, log file, start time (ms), then mode arguments.
// Environment: SWAP_TEST_EIO=1 makes the FIRST read of a competing lock entry fail with EIO (a live holder whose entry momentarily cannot be read).
import fs, { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

if (process.env.SWAP_TEST_EIO) {
  const openSync = fs.openSync, linkSync = fs.linkSync, mine = new Set(); let fired = false;
  fs.linkSync = (a, b) => { mine.add(b); return linkSync(a, b); };
  fs.openSync = (p, flags, ...rest) => {
    if (!fired && typeof p === 'string' && p.includes('.lock.h.') && !mine.has(p) && (flags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY) { fired = true; throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); }
    return openSync(p, flags, ...rest);
  };
  syncBuiltinESMExports();
}
const lib = await import('./swap-lib.mjs');

const [mode, path, logFile, startAt, a1, a2] = process.argv.slice(2);
const KDF = { N: 1024, r: 8, p: 1 }, PASS = 'correct horse battery staple';
const note = (line) => appendFileSync(logFile, `${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = lib.createSwapFile(path, { passphrase: PASS, kdf: KDF, minKdfN: 1024 });
const intent = (wallet) => ({ walletId: wallet, amountAtomic: '50000000000', address: '5' + 'A'.repeat(94) });

async function lockWithRetry() {
  const until = Date.now() + 6000;
  for (;;) {
    try { file.lock(); return; } catch (e) { if (e.code !== 'swap-file-busy' || Date.now() > until) throw e; await sleep(5 + Math.floor(Math.random() * 15)); }
  }
}

// 'pay': the REAL production path. A forward session (createForwardSession) over a fake maker, a fake Solana chain and a fake wallet RPC; the chain state is rebuilt from the
// preset file the parent wrote after registering the swap. The wallet RPC is SHARED between children through `<log>.wallet` (what one run relayed, the other sees).
let session = null;
if (mode === 'pay') {
  const { makeWorldFactory } = await import('./swap-test-world.mjs');
  const preset = JSON.parse(readFileSync(a1, 'utf8'));
  const world = makeWorldFactory({ tmp: dirname(path), nextId: () => `c${process.pid}`, REC: { recordPassphrase: PASS, recordKdf: KDF, recordMinKdfN: 1024 } });
  const w = world({ preset });
  const walletFile = `${logFile}.wallet`;
  w.W.onTransfer = () => note(`transfer ${process.pid}`);
  w.W.onRelay = () => { note(`relay ${process.pid}`); appendFileSync(walletFile, `${JSON.stringify({ txid: w.W.built.tx_hash, confirmations: 0, destinations: [{ address: w.W.built.address, amount: w.W.built.amount }] })}\n`); };
  const walletFetcher = async (url, init) => {
    if (existsSync(walletFile)) for (const l of readFileSync(walletFile, 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); if (!w.W.out.some((x) => x.txid === e.txid)) w.W.out.push(e); }
    return w.fetcher(url, init);
  };
  session = w.session({ recordPath: path, walletFetcher, log: (l) => note(`log ${l}`), confirmPayment: async () => { note(`confirm ${process.pid}`); await sleep(Number(a2 || 0)); return true; } });
}
while (Date.now() < Number(startAt)) { /* spin to a shared start time */ }

try {
  if (mode === 'lock') {                         // take the lock, hold it, release it; the log must show strictly one holder at a time
    await lockWithRetry(); note(`enter ${process.pid}`); await sleep(Number(a1)); note(`exit ${process.pid}`); file.unlock();
  } else if (mode === 'crash-after-lock') {      // the owner dies between taking the lock and writing any intent
    file.lock(); note(`locked ${process.pid}`); process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'crash-after-claim') {     // the owner dies after the intent is on disk but before it built anything
    file.lock(); file.claimIntent(intent(a1)); note(`claimed ${a1}`); process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'plant-and-die') {         // a reservation made for the real record (a1 = JSON of the intent) by a run that then dies
    file.lock(); file.claimIntent(JSON.parse(a1)); process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'claim') {                 // no lock at all: the intent file alone must keep a second wallet out
    try { const r = file.claimIntent(intent(a1)); if (r.status === 'created') note(`build ${a1}`); else note(`same ${a1}`); } catch (e) { note(`refused ${a1} ${e.code}`); }
  } else if (mode === 'fund') {                  // lock, claim the intent, build only when this process created it (a simplified caller; 'pay' is the real one)
    await lockWithRetry();
    try {
      const r = file.claimIntent(intent(a1));
      if (r.status === 'created') { note(`build ${a1}`); await sleep(Number(a2 || 20)); } else note(`same ${a1}`);
    } catch (e) { note(`refused ${a1} ${e.code}`); }
    file.unlock();
  } else if (mode === 'pay') {                   // one resume through the production code, once: a busy swap or a refusal is a result, not a retry
    try { const v = await session.resume({ pollMs: 60_000, maxTicks: 1 }); note(`done ${process.pid} ${v?.phase}`); } catch (e) { note(`refused ${process.pid} ${e.code ?? 'x'}`); }
  }
} catch (e) { note(`error ${mode} ${e.code ?? 'x'}`); process.exitCode = 3; }
