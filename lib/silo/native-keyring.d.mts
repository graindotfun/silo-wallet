// SPDX-License-Identifier: AGPL-3.0-only
export type NativeChain = 'solana' | 'evm';
/** 'devnet' is the test-network profile (Solana only); everything else is 'mainnet'. */
export type NativeNetwork = 'mainnet' | 'devnet';
export interface NativeEnvelope {scope:'silo-native-keyring-v1';version:1;chain:NativeChain;network:NativeNetwork;address:string;kdf:'PBKDF2-SHA256';iterations:600000;cipher:'AES-256-GCM';salt:string;iv:string;ciphertext:string}
export interface NativeKeyringStore {readonly closed?:boolean;read():Promise<NativeEnvelope|null>;create(envelope:NativeEnvelope):Promise<boolean>;replace?(envelope:NativeEnvelope):Promise<boolean>;remove():Promise<boolean>;close():void;onClose?(callback:()=>void):void}
export interface NativeKeyringSession {metadata():{chain:NativeChain;network:NativeNetwork;address:string};exportBackup():NativeEnvelope;verifyBackup(backup:NativeEnvelope,passphrase:string):Promise<true>;revealSecretKey(passphrase:string):Promise<string>;signTransaction(...args:unknown[]):Promise<never>;transferIdentity():unknown;signReviewedTransfer(encoded:string,ticket:unknown):string;signReviewedManaged(encoded:string,ticket:unknown):string;signTestNetworkTransaction(encoded:string):string;lock():void}
export function createNativeKeyring(options:{chain:NativeChain;passphrase:string;store:NativeKeyringStore;network?:NativeNetwork}):Promise<NativeKeyringSession>;
export function importNativeKeyring(options:{chain:NativeChain;privateKey:string;passphrase:string;store:NativeKeyringStore;network?:NativeNetwork}):Promise<NativeKeyringSession>;
export function unlockNativeKeyring(options:{chain:NativeChain;passphrase:string;store:NativeKeyringStore;network?:NativeNetwork}):Promise<NativeKeyringSession>;
export function restoreNativeKeyring(options:{chain?:NativeChain;backup:NativeEnvelope;passphrase:string;store:NativeKeyringStore;network?:NativeNetwork}):Promise<NativeKeyringSession>;

export function previewNativePrivateKey(options:{chain:NativeChain;privateKey:string;network?:NativeNetwork}):{chain:NativeChain;network:NativeNetwork;address:string};

export function resealNativeBackup(options:{chain:NativeChain;backup:NativeEnvelope;originalPassphrase:string;newPassphrase:string;network?:NativeNetwork}):Promise<NativeEnvelope>;
