// Node-only helper (tests, maker). Kept out of sol.mjs so the browser bundle never sees node:fs.
import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
export const loadKeypair = async (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
