import qrcode from 'qrcode-generator';
/** Public receive address only; no external QR service or arbitrary URI execution. */
export function siloReceiveQr(address){
 if(typeof address!=='string'||! /^[A-Za-z0-9]{20,512}$/.test(address))throw Error('A receive address is required.');
 const qr=qrcode(0,'M');qr.addData(address,'Byte');qr.make();
 const size=qr.getModuleCount();let path='';
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.isDark(y,x))path+=`M${x+4} ${y+4}h1v1h-1z`;
 return {size:size+8,path};
}
/** QR for a Monero payment request URI (monero:<subaddress>?tx_amount=..&tx_description=..). Built locally; nothing is fetched. */
export function siloRequestUriQr(uri){
 if(typeof uri!=='string'||uri.length>600||!/^monero:[A-Za-z0-9]{95}(\?[A-Za-z0-9_=&.%~-]*)?$/.test(uri))throw Error('A Monero payment request is required.');
 const qr=qrcode(0,'M');qr.addData(uri,'Byte');qr.make();
 const size=qr.getModuleCount();let path='';
 for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.isDark(y,x))path+=`M${x+4} ${y+4}h1v1h-1z`;
 return {size:size+8,path};
}
