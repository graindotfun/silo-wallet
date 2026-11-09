/** Grainy, the Silo helper: all static, written help text plus the small pure helpers around it (no network, no AI, no wallet data).
 * English only. Nothing here reads or sends anything from the wallet. */
export const GRAINY_TUTORIAL_KEY='grain-silo-grainy-tour-v1';
export const GRAINY_SUPPORT_EMAIL='hello@silo.trading';
export const GRAINY_SECRET_WARNING='Never paste a seed phrase, passphrase or private key here. The team will never ask for one.';

/** Short, skippable first-visit steps. `target` names the wallet menu Grainy hops next to for that step (the page finds it; a
 * missing menu just leaves Grainy where it is). */
export const GRAINY_TOUR=Object.freeze([
 {title:'Hi, I am Grainy',body:'Silo is one wallet for Solana and private Monero. Your keys stay on this device. My friends and I will show you around.',target:'home',grain:'mori'},
 {title:'Create or open your wallet',body:'Pick a wallet, choose a passphrase and you are in. Opening it later asks for the same passphrase.',target:'home',grain:'nori'},
 {title:'Back it up',body:'Save your backup and keep your passphrases somewhere safe. If you lose both, nobody can get your money back, including us.',target:'settings',grain:'pip'},
 {title:'Receive and send',body:'Receive shows your address to share. Send asks for an address and an amount, then you review and confirm.',target:'home',grain:'rolo'},
 {title:'Convert',body:'Convert swaps one coin for another. You see the amount you get before anything moves.',target:'swap',grain:'peb'},
 {title:'I will wait here',body:'I am staying in the bottom right corner. Tap me on any screen for help, or to write to the team.',target:'corner',grain:'mori'},
]);
export const GRAINY_NO_EMAIL_NOTE='No email needed. We read every message, but without one we cannot reply. To get an answer without sharing an email, send a direct message to @SiloXMR on X.';

/** Help topics. Each line explains the real state a newcomer meets (see docs/product/SILO_GRAINY_HELP_AUDIT_20261103.md). Grainy
 * explains; it never performs a wallet action and never replaces a warning, review detail or confirm button. */
export const GRAINY_TOPICS=Object.freeze([
 {id:'start',label:'Create or open a wallet',screens:['overview'],lines:[
  'Create a new wallet, or unlock the one already saved in this browser with its passphrase.',
  'Account sign-in, the account vault and each wallet have separate passphrases. Unlocking one does not unlock the others.',
  'If the wallet says it is open in another tab, close that tab or allow site storage, then reload.']},
 {id:'backup',label:'Backup and passphrases',screens:['settings'],lines:[
  'Saved in this browser is not a backup. Export the file, keep it somewhere else, and verify that it restores before you rely on it.',
  'Keep passphrases apart from the backup file. Anyone with both can open the wallet.',
  'Silo cannot reset a passphrase or recover a wallet. Lose the passphrase and the backup and the money is gone.',
  'A wrong passphrase changes nothing. Check capital letters and spaces, and that the backup is for this network.']},
 {id:'receive',label:'Receive',screens:['wallets'],lines:[
  'Share only the address shown, for the network shown. Solana and Monero have different addresses, and a payment sent on the wrong network is usually lost.',
  'Some builds can receive before they can send. Receiving does not mean sending is open.',
  'New Monero funds become spendable after about 10 confirmations, roughly 20 minutes.']},
 {id:'send',label:'Send',screens:['wallets'],lines:[
  'Check the address, the network and the amount on the review screen, then confirm yourself. Sends cannot be undone.',
  'Held or expired means nothing was sent. Not confirmed yet means Silo is still checking.',
  'Never send a second time until Activity shows what happened to the first one.']},
 {id:'convert',label:'Convert',screens:['swap'],lines:[
  'Open and sync your Monero wallet first. Conversion uses it to check what arrives.',
  'The provider sees both addresses and may delay a deposit or ask for checks. A refund is not guaranteed. Send the exact amount inside the window shown.',
  'When the provider says it sent your coins, that is its own claim. Only your synced wallet showing the amount proves it arrived.']},
 {id:'activity',label:'Activity',screens:['activity'],lines:[
  'Solana activity is public on the chain. Monero activity stays private to you.',
  'Rows finish after confirmations. Not confirmed yet is normal for a few minutes.']},
 {id:'errors',label:'Something went wrong',screens:[],lines:[
  'Most messages say what happened to your money. Read that line first: Nothing was changed means you are safe.',
  'Paused means the team stopped new payments for a moment. Your funds, addresses and backups stay available.',
  'Too many requests means wait a minute and try again.']},
]);

/** Which topic a wallet screen opens first. `hash` is location.hash ("#wallets/sol"); nothing else is read. */
export function grainyTopicForHash(hash){
 const match=/^#(overview|wallets|swap|activity|settings)(?:\/([a-z]+))?$/.exec(typeof hash==='string'?hash:'');
 if(!match)return 'start';
 const view=match[1];
 if(view==='settings')return 'backup';
 if(view==='wallets')return 'receive';
 if(view==='swap')return 'convert';
 if(view==='activity')return 'activity';
 return 'start';
}

/** Guarded localStorage: a blocked store never throws and never blocks the wallet. */
export function grainyTourSeen(storage){try{return storage.getItem(GRAINY_TUTORIAL_KEY)!==null;}catch{return false;}}
export function grainyMarkTourSeen(storage){try{storage.setItem(GRAINY_TUTORIAL_KEY,'1');return true;}catch{return false;}}

export const GRAINY_MESSAGE_MAX=2000;
export const GRAINY_CONTACT_MAX=254;
const EMAIL=/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const STOP=new Set('the and to my me is it of in for on with that this not can cannot when but are was have has you your please help hello hi after because before while then than from into about over also just still keeps there here they them what which would could should will does did how why who its our out off one two get got use used try tried'.split(' '));
/** True when the text looks like a private key (long base58 or 64 hex characters, even split into chunks, or a list of 32 or more
 * byte values) or a seed phrase (a run of 12 or more words with almost no ordinary sentence words, whatever the punctuation, numbering
 * or labels around it). A safety net, not a promise: the on-screen warning is the real protection, and a false alarm only asks the
 * person to take the text out. */
export function grainyLooksSecret(text){
 if(typeof text!=='string')return false;
 if(/\b[1-9A-HJ-NP-Za-km-z]{64,}\b/.test(text)||/\b[0-9a-fA-F]{64}\b/.test(text))return true;
 if(/(?:\b\d{1,3}\s*,\s*){31,}\d{1,3}\b/.test(text))return true;
 const chunks=text.split(/[^0-9A-Za-z]+/).filter(Boolean);
 let hex=0,base58=0;
 for(const chunk of chunks){
  hex=/^[0-9a-fA-F]{4,}$/.test(chunk)?hex+chunk.length:0;if(hex>=64)return true;
  base58=/^[1-9A-HJ-NP-Za-km-z]{4,}$/.test(chunk)&&/\d/.test(chunk)?base58+chunk.length:0;if(base58>=64)return true;
 }
 const words=text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
 // Any 12 words in a row, each 3 to 12 letters, with at most 2 ordinary sentence words among them. Short words (a, I, my, is) break a
 // run on their own, and ordinary sentence words are never trimmed off the ends, because many seed words (about, after, before) are
 // ordinary words too. Too lenient on purpose: a false alarm only asks the person to rephrase.
 let run=0;
 for(let index=0;index<=words.length;index++){
  if(index<words.length&&/^[a-z]{3,12}$/.test(words[index])){run++;if(run>=12){let ordinary=0;for(let back=index-11;back<=index;back++)if(STOP.has(words[back]))ordinary++;if(ordinary<=2)return true;}}
  else run=0;
 }
 return false;
}
/** Normalises and validates a support request. Returns {ok:true,message,contact} or {ok:false,reason}. */
export function grainySupportRequest(input){
 const message=typeof input?.message==='string'?input.message.replace(/\r\n?/g,'\n').trim():'';
 const contact=typeof input?.contact==='string'?input.contact.trim():'';
 if(message.length<5)return {ok:false,reason:'Tell us a little more so we can help.'};
 if(message.length>GRAINY_MESSAGE_MAX)return {ok:false,reason:`Please keep it under ${GRAINY_MESSAGE_MAX} characters.`};
 if(contact&&(contact.length>GRAINY_CONTACT_MAX||!EMAIL.test(contact)))return {ok:false,reason:'That email does not look right. Leave it empty if you prefer.'};
 if(grainyLooksSecret(message)||grainyLooksSecret(contact))return {ok:false,reason:'This looks like a seed phrase or a private key. Remove it, we never need it.'};
 return {ok:true,message,contact};
}
export function grainyMailto(message=''){
 const body=typeof message==='string'?message.slice(0,1500):'';
 return `mailto:${GRAINY_SUPPORT_EMAIL}?subject=${encodeURIComponent('Silo help')}${body?`&body=${encodeURIComponent(body)}`:''}`;
}
