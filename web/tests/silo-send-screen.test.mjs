// r8 Send (owner, 6 Nov 2026): presentation only. Source checks that the Send screen and the What to send sheet change how sending looks,
// not what it does: the Solana form keeps its handlers, the sheet only fills the same inputs, and no prototype props ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
const screen=read('components/silo-send-screen.tsx'),transfer=read('components/silo-solana-transfer.tsx'),overview=read('components/silo-overview.tsx'),pad=read('components/silo-amount-pad.tsx'),css=read('app/app/silo-themes.css');

test('no art-direction props ship: no TEST SCENARIO banner, no fixture balances or test networks',()=>{
 for(const source of [screen,transfer,overview])assert.doesNotMatch(source,/TEST SCENARIO|fixture balance|Test network [A-D]|TST1/i);
});
test('the sheet only routes and fills the existing Solana inputs (SOL, USDC by its pinned mint, any token by mint); USDC is mainnet only',()=>{
 assert.match(screen,/import \{SILO_USDC_MINT\} from '@\/lib\/silo\/swap-referral\.mjs'/);
 assert.match(transfer,/if\(choice==='sol'\)\{setAsset\('SOL'\);setMint\(''\);\}else if\(choice==='usdc'\)\{setAsset\('SPL'\);setMint\(SILO_USDC_MINT\);setDecimals\('6'\);\}/);
 assert.match(screen,/mainnet\?solState:'Mainnet only'/);
 assert.doesNotMatch(screen,/\bprepare\(|\bsign[A-Z(]|\bsubmit[A-Z(]|\bfetch\(/,'the screen never prepares, signs or submits');
});
test('the Solana form keeps its money path: same prepare/send/relay functions, Review still calls prepare(), Max still prepare(true)',()=>{
 assert.match(transfer,/onClick=\{\(\)=>void prepare\(true\)\}>Max<\/button>/);
 assert.match(transfer,/aria-label="Review transfer" disabled=\{busy\|\|!ready\|\|!permitted\|\|!owner\|\|!amount\|\|!recipient\} onClick=\{\(\)=>void prepare\(\)\}/);
 for(const name of ['async function prepare(max=false)','async function send()','async function relay(row:Pending','async function check(quiet=false)'])assert.ok(transfer.includes(name),name);
});
test('Send is its own view with a back to Home; the real-funds band stays; the keys sit in the screen',()=>{
 assert.match(overview,/type View='overview'\|'wallets'\|'send'\|/);
 assert.match(overview,/\(view==='wallets'\|\|view==='send'\)&&<button type="button" className="silo-back"/);
 assert.doesNotMatch(css,/\[data-view=send\] [^{]*\.silo-network-band\{display:none\}/);
 assert.match(transfer,/data-pad-slot="silo-send-pad"/);
 assert.match(pad,/const INLINE='input\[data-amount-pad\]\[data-pad-slot\]'/);
});
test('asset fields keep 4.5:1 text: dark ink on SOL and XMR, white on USDC #2775ca',()=>{
 assert.match(css,/\[data-asset=usdc\]\{--af:var\(--silo-a-usdc\);--ai:#fff\}/);
 assert.match(css,/--silo-a-usdc:#2775ca/);
 assert.match(css,/#silo-conversion \.silo-convert-card\[data-coin=usdc\]\{--af:var\(--silo-a-usdc\);--ai:#fff\}/,'Convert shows USDC on the same blue');
});
