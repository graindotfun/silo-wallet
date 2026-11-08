// SPDX-License-Identifier: AGPL-3.0-only
import {Buffer} from 'buffer';

// Initialize before Solana dependencies evaluate, rather than in a click handler.
globalThis.Buffer ??= Buffer;
