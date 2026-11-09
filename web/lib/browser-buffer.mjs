import {Buffer} from 'buffer';

// Initialize before Solana dependencies evaluate, rather than in a click handler.
globalThis.Buffer ??= Buffer;
