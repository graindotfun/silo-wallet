// SPDX-License-Identifier: AGPL-3.0-only
/** Refuses guessable passphrases for a new wallet. An exported backup can be attacked offline at full speed, so the
 * passphrase has to carry the strength: 600,000 PBKDF2 rounds only multiply the cost of each guess. Accepted: 16+ characters,
 * or 12+ with at least three character kinds; it refuses runs, repeats, keyboard walks and passphrases built
 * from a short list of very common words (also in l33t spelling). It is a heuristic, not a guarantee of strength. Returns a reason or null. */
const COMMON=/pass(word|phrase)?|qwert|asdf|zxcv|letmein|welcome|monero|solana|grain|silo|wallet|bitcoin|crypto|admin|iloveyou|abc123|111111|123456|654321|dragon|monkey|sunshine|princess|football|master|secret|trustno|shadow|starwars|hello/i;
// Keyboard walks typed down or across the rows (1q2w3e…, qazwsx…, 1qaz2wsx…).
const ROWS=['1234567890','qwertyuiop','asdfghjkl','zxcvbnm'];
const COLUMN_WALKS=['1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik,9ol.0p;/','qazwsxedcrfvtgbyhnujmikolp','zaq1xsw2cde3vfr4bgt5nhy6mju7'];
const KEY_POSITION=new Map(ROWS.flatMap((row,y)=>[...row].map((key,x)=>[key,[x,y]])));
function keyboardWalk(value){
 const keys=[...value.toLowerCase()].map(key=>KEY_POSITION.get(key)??null);
 let run=1,longest=1;for(let i=1;i<keys.length;i++){const a=keys[i-1],b=keys[i];run=a&&b&&Math.abs(a[0]-b[0])<=1&&Math.abs(a[1]-b[1])<=1&&(a[0]!==b[0]||a[1]!==b[1])?run+1:1;longest=Math.max(longest,run);}
 if(longest>=6)return longest;
 // Column walks (qazwsx, 1qaz2wsx) run diagonally on a staggered keyboard; match them against the known sequences.
 const lower=value.toLowerCase();for(let i=0;i+6<=lower.length;i++){const piece=lower.slice(i,i+6);if(COLUMN_WALKS.some(walk=>walk.includes(piece)))return 6;}
 return longest;
}
const LEET={'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s','!':'i'};
const deleet=value=>value.toLowerCase().replace(/[013457@$!]/g,character=>LEET[character]);
export function siloPassphraseProblem(value){
 if(typeof value!=='string'||value.length<12)return 'Use at least 12 characters.';
 if(value.length>256)return 'Use at most 256 characters.';
 const unique=new Set(value.toLowerCase()).size;
 if(unique<8)return 'Too many repeated characters. Use several unrelated words or a longer mix.';
 if(/(.{1,4})\1{2,}/.test(value)||/^(.{3,})\1+$/.test(value.toLowerCase()))return 'Avoid repeated patterns such as abcabcabc or a word typed twice.';
 if(keyboardWalk(value)>=6)return 'Avoid keyboard patterns such as 1q2w3e4r or qazwsx.';
 let run=1,longest=1;for(let i=1;i<value.length;i++){const step=value.charCodeAt(i)-value.charCodeAt(i-1);run=step===1||step===-1?run+1:1;longest=Math.max(longest,run);}
 if(longest>=5)return 'Avoid sequences such as 12345 or abcde.';
 const stripped=value.replace(/[^a-z]/gi,'');
 const plain=deleet(value);
 if(COMMON.test(plain)&&plain.replace(new RegExp(COMMON.source,'gi'),'').replace(/[^a-z]/g,'').length<8)return 'This is close to a common passphrase. Add unrelated words.';
 const kinds=[/[a-z]/,/[A-Z]/,/[0-9]/,/[^A-Za-z0-9]/].filter(kind=>kind.test(value)).length;
 if(value.length<16&&kinds<3)return 'Use 16 or more characters, or mix three of: lower case, upper case, digits, symbols.';
 if(stripped.length===0&&value.length<20)return 'Digits alone are easy to guess. Use words.';
 return null;
}
