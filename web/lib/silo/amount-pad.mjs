// Silo's on-screen number pad: the pure editing rules (5 Nov 2026, from the r8 art direction's amount.js). UI input only: the pad edits the
// text of an ordinary amount field and hands it to that field's own change handler, so parsing, limits and every money rule stay where
// they are. Only digits and one decimal point; never more decimals than the field's coin allows; a refusal leaves the text unchanged.

export const PAD_KEYS=Object.freeze(['1','2','3','4','5','6','7','8','9','.','0','del']);
export const PAD_MAX_DIGITS=20;
export const PAD_MODE_KEY='silo-amount-input-v1';

const SHAPE=/^\d*\.?\d*$/;
const digits=text=>text.replace('.','').length;

/** Drop superfluous leading zeros and give a bare leading point its zero ("007" -> "7", ".5" -> "0.5", "0.5" stays). Returns the
 * normalised text and how many characters were added (+1) or removed (negative) before the caret position. */
function normalise(text,caret){
 let out=text,shift=0;
 if(out.startsWith('.')){out='0'+out;shift+=1;}
 const zeros=/^0+(?=\d)/.exec(out)?.[0].length??0;
 if(zeros){out=out.slice(zeros);shift-=Math.min(zeros,caret+shift);}
 return {text:out,caret:Math.max(0,Math.min(out.length,caret+shift))};
}

function check(text,decimals){
 if(!SHAPE.test(text))return 'shape';
 const [,fraction]=text.split('.');
 if(fraction!==undefined&&fraction.length>decimals)return 'decimals';
 if(digits(text)>PAD_MAX_DIGITS)return 'long';
 return null;
}

/** One pad key at the caret (or over the selection). key: '0'..'9', '.', 'del' (deletes the selection, else one character before the
 * caret) or 'clear'. Returns {value, caret} or {refused, value, caret} with the original text and caret untouched. */
export function padEdit(value,start,end,key,decimals){
 const text=String(value??''),a=Math.max(0,Math.min(start??text.length,text.length)),b=Math.max(a,Math.min(end??a,text.length));
 const keep={value:text,caret:a};
 if(!Number.isInteger(decimals)||decimals<0)return {...keep,refused:'decimals'};
 if(key==='clear')return {value:'',caret:0};
 if(key==='del'){
  if(a===b&&a===0)return keep;
  const next=a===b?text.slice(0,a-1)+text.slice(b):text.slice(0,a)+text.slice(b),caret=a===b?a-1:a;
  if(next==='')return {value:'',caret:0};
  const n=normalise(next,caret);return {value:n.text,caret:n.caret};
 }
 if(!/^[0-9.]$/.test(key))return {...keep,refused:'key'};
 const before=text.slice(0,a),after=text.slice(b);
 if(key==='.'&&(before+after).includes('.'))return {...keep,refused:'point'};
 const raw=before+key+after,n=normalise(raw,a+1),why=check(n.text,decimals);
 if(why)return {...keep,refused:why};
 return {value:n.text,caret:n.caret};
}

/** Pasted text becomes an amount only when it is one: digits with at most one point (spaces and thousands commas like 1,234.5 are
 * dropped), within the coin's decimals and the digit limit. Anything else is refused and the field keeps its text. */
export function padPaste(text,decimals){
 let t=String(text??'').replace(/[\s  ]/g,'');
 if(/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(t))t=t.replace(/,/g,'');
 if(t===''||t==='.'||!/^(\d+\.?\d*|\.\d+)$/.test(t))return {refused:'shape'};
 const n=normalise(t,t.length),why=check(n.text,decimals);
 return why?{refused:why}:{value:n.text};
}

/** What a refusal tells the person, plainly. */
export function padRefusal(reason,decimals,symbol){
 if(reason==='point')return 'An amount has one decimal point.';
 if(reason==='decimals')return `${symbol} has up to ${decimals} decimal places.`;
 if(reason==='long')return 'That number is too long.';
 return 'That is not an amount.';
}

/** Pad or the phone's own keyboard. A saved choice wins; otherwise touch screens get the pad and a mouse or trackpad types directly. */
export function padModeFor({coarse,saved}){
 if(saved==='pad'||saved==='keyboard')return coarse?saved:'keyboard';
 return coarse?'pad':'keyboard';
}
