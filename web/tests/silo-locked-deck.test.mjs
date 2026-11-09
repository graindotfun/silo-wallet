// r8 Locked screen, one unlock for all (owner, 6 Nov 2026): presentation only. Source checks of the state contract with the unlock logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const deck=readFileSync(new URL('../components/silo-locked-deck.tsx',import.meta.url),'utf8');
test('statuses are words: Locked, Opening <name>…, Open, Needs its own passphrase, Open in another tab',()=>{
 assert.match(deck,/export type SiloUnlockStatus='locked'\|'opening'\|'open'\|'own-passphrase'\|'other-tab'/);
 for(const word of ['`Opening ${row.name}…`',"'Open'","'Needs its own passphrase'","'Open in another tab'","'Locked'"])assert.ok(deck.includes(word),word);
});
test('one fixed wrong-passphrase line that never names a wallet; the screen takes no error text from outside',()=>{
 assert.match(deck,/SILO_UNLOCK_WRONG='Nothing was opened\. Check the passphrase and try again\.'/);
 assert.match(deck,/wrong:boolean/);assert.doesNotMatch(deck,/error:string/);
});
test('the passphrase is cleared when handed over, never stored, and this screen touches no keys or storage',()=>{
 assert.match(deck,/const value=passphrase;setPassphrase\(''\);onUnlock\(value\);/);
 assert.doesNotMatch(deck,/localStorage|sessionStorage|indexedDB|decrypt[A-Z(]|crypto\.subtle|fetch\(/);
 assert.match(deck,/type=\{shown\?'text':'password'\}/);assert.match(deck,/aria-label=\{shown\?'Hide passphrase':'Show passphrase'\}/);
});
test('rows follow the unlock logic: solana, one EVM row, xmr; a wallet that needs its own passphrase is sent to its own area',()=>{
 assert.match(deck,/id:'solana'\|'evm'\|'btc'\|'xmr';asset:'sol'\|'evm'\|'btc'\|'xmr'/);assert.doesNotMatch(deck,/zec|onUnlockOne|chainId/);
 assert.match(deck,/onClick=\{\(\)=>onOpenWallet\(row\.id\)\}>Open \{row\.name\} with its own passphrase/);
 assert.match(deck,/\{onCreate&&<button/);
});
test('the deck shows supported colours, never holdings',()=>{
 assert.match(deck,/<div className="silo-locked-deck" aria-hidden="true"><i style=\{siloLookStyle\(SILO_ASSET_LOOKS\.sol\)\}\/><i style=\{siloLookStyle\(SILO_ASSET_LOOKS\.usdc\)\}\/><i style=\{siloLookStyle\(SILO_ASSET_LOOKS\.xmr\)\}\/>/);
});
