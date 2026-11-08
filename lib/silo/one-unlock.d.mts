// SPDX-License-Identifier: AGPL-3.0-only
export type OneUnlockStatus='locked'|'opening'|'open'|'needs-own'|'other-tab';
export const ONE_UNLOCK_STATUS:Readonly<Record<'locked'|'opening'|'open'|'needsOwn'|'otherTab',OneUnlockStatus>>;
export const ONE_UNLOCK_MESSAGES:Readonly<{none:string;wrong:string;trouble:string}>;
export function createOneUnlock(options?:{onChange?:()=>void;timeoutMs?:number;heavyTimeoutMs?:number;setTimer?:(fn:()=>void,ms:number)=>unknown;clearTimer?:(id:unknown)=>void}):{
 setPresent(zone:string,here:boolean):void;setOpen(zone:string):void;submit(passphrase:string):{version:number;accepted:boolean};
 canOpen(zone:string,version:number):boolean;started(zone:string,version:number):boolean;report(zone:string,outcome:string,version:number):{accept:boolean};
 lockAll():void;passphraseFor(version:number):string;statuses():Record<string,OneUnlockStatus>;message():string;version():number;
};
