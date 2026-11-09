/** A post permalink, deliberately separate from an X profile or community. */
export function canonicalLaunchTweet(value){
 if(value===undefined||value==='')return '';
 if(typeof value!=='string'||value.length>300)throw Error('Enter an X launch post URL below 300 characters.');
 const text=value.trim();if(!text)return '';
 let url;try{url=new URL(text);}catch{throw Error('Enter a complete HTTPS X launch post URL.');}
 const match=url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{0,19})\/?$/);
 if(url.protocol!=='https:'||url.username||url.password||url.port||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||!match)throw Error('Use an X post link such as https://x.com/your_project/status/123456789.');
 // Shared-post tracking parameters do not form part of the signed permalink.
 return `https://x.com/${match[1]}/status/${match[2]}`;
}
