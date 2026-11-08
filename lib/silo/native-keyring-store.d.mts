// SPDX-License-Identifier: AGPL-3.0-only
import type { NativeChain, NativeKeyringStore, NativeNetwork } from './native-keyring.mjs';
export function openNativeKeyringStore(chain:NativeChain, options?:{factory?:IDBFactory;locks?:LockManager;network?:NativeNetwork}):Promise<NativeKeyringStore>;
