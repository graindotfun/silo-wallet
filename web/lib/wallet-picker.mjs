/** Picker layout for discovered providers. Display only: every discovered provider stays selectable. */
export const WALLET_INSTALL_LINKS=[{brand:'Phantom',href:'https://phantom.com/'},{brand:'Solflare',href:'https://solflare.com/'}];
const LAST_USED_KEY='grainpad-wallet-last-used';
const brandKey=brand=>String(brand||'').trim().toLowerCase();

/**
 * One row per wallet brand. A known injected provider keeps the main row; a same-name Wallet Standard entry is a
 * self-reported name, so it never takes over that row and moves to "More options" instead. Repeated Standard names
 * also move there. The last-used provider is listed first.
 */
export function groupWalletProviders(providers,lastUsed=''){
 const rows=[],more=[],seen=new Set();
 const injected=providers.filter(p=>p.kind==='injected'),standard=providers.filter(p=>p.kind!=='injected');
 for(const p of injected){rows.push({provider:p,label:p.name});seen.add(brandKey(p.brand||p.name));}
 for(const p of standard){const key=brandKey(p.brand);
  if(seen.has(key))more.push({provider:p,label:p.name});
  else{seen.add(key);rows.push({provider:p,label:p.brand||p.name});}
 }
 const last=rows.findIndex(r=>r.provider.name===lastUsed);
 if(last>0)rows.unshift(...rows.splice(last,1));
 const install=WALLET_INSTALL_LINKS.filter(link=>!seen.has(brandKey(link.brand)));
 return {rows,more,install,lastUsed:last>=0?lastUsed:''};
}

export function readLastUsedWallet(){try{return localStorage.getItem(LAST_USED_KEY)||'';}catch{return '';}}
export function rememberLastUsedWallet(name){try{localStorage.setItem(LAST_USED_KEY,name);}catch{}}

/** Wallet prompts reject with provider-specific text; show people a short, consistent reason. */
export function walletConnectError(error,label){
 const message=error instanceof Error?error.message:String(error||'');
 if(/reject|denied|declined|cancel|closed/i.test(message))return `The request was declined in ${label}.`;
 if(/compatible Solana account/i.test(message))return `${label} has no compatible Solana mainnet account.`;
 if(/locked|unlock/i.test(message))return `Unlock ${label} and try again.`;
 return `Couldn't connect to ${label}. Try again.`;
}

/** Deterministic two-tone avatar for a public address. */
export function addressGradient(address){
 let h=0;for(const c of String(address))h=(h*31+c.charCodeAt(0))>>>0;
 const a=h%360,b=(a+40+(h>>>9)%120)%360;
 return `linear-gradient(135deg,hsl(${a} 70% 58%),hsl(${b} 72% 46%))`;
}
export const shortAddress=address=>`${address.slice(0,4)}…${address.slice(-4)}`;
