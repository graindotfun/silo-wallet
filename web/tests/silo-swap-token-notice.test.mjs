import test from 'node:test';import assert from 'node:assert/strict';
import {siloSwapTokenNotices,SILO_UNVERIFIED_TOKEN_NOTICE,SILO_TOKEN_2022_NOTICE,SILO_TOKEN_2022_PROGRAM} from '../lib/silo/swap-token-notice.mjs';
const SOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',T='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',X='9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E';
test('known pair: no notice',()=>assert.deepEqual(siloSwapTokenNotices({inputMint:SOL,outputMint:USDC,inputProgram:T,outputProgram:T}),[]));
test('unknown mint: unverified notice',()=>assert.deepEqual(siloSwapTokenNotices({inputMint:SOL,outputMint:X,inputProgram:T,outputProgram:T}),[SILO_UNVERIFIED_TOKEN_NOTICE]));
test('Token-2022 owner: fee notice, both directions',()=>{for(const c of [{inputProgram:SILO_TOKEN_2022_PROGRAM,outputProgram:T},{inputProgram:T,outputProgram:SILO_TOKEN_2022_PROGRAM}])assert.deepEqual(siloSwapTokenNotices({inputMint:SOL,outputMint:USDC,...c}),[SILO_TOKEN_2022_NOTICE]);});
test('both notices, and no dashes in copy',()=>{const n=siloSwapTokenNotices({inputMint:SOL,outputMint:X,inputProgram:T,outputProgram:SILO_TOKEN_2022_PROGRAM});assert.equal(n.length,2);for(const s of n)assert.ok(!/[–—]/.test(s));});
