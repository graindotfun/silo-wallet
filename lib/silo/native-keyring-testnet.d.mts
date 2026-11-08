// SPDX-License-Identifier: AGPL-3.0-only
export const SILO_TEST_NETWORK_SIGNING_MARKER:string;
export const SILO_TEST_NETWORK_SIGNING_BUILD:boolean;
export function signTestNetworkTransaction(input:{chain:string;network:string;address:string;secret:Uint8Array;assert:()=>void;encoded:string}):string;
