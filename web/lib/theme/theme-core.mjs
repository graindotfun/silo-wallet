/* Theme state shared by the pre-paint init script (public/theme-init.js mirrors the same rules in plain ES5),
   the Silo appearance picker and the site header switch. Presentation only: no wallet, key or money data.
   Three skins: b Cold Brew (today's dark), a Campfire, c Oat Milk (owner dropped the orange Tangerine Dream, 4 Nov 2026). Design: design-lab/terminal-mono-20261104. */
export const SKINS=['b','a','c'];
export const SKIN_INFO={
 b:{name:'Cold Brew',blurb:'Dark ink with one orange accent. The current look.',strip:['#101010','#161616','#ff6600','#ffffff']},
 a:{name:'Campfire',blurb:'Warm near-black with orange heat.',strip:['#14110e','#3a2b20','#ff6600','#f3ebde']},
 c:{name:'Oat Milk',blurb:'Light and warm.',strip:['#3a2b20','#e9dac6','#ff6600','#1a1714']},
};
/* Which skins each surface can actually show. Silo shows all four (phase 2). The site still has only its old light/dark pair: c there is the
   old white, not Oat Milk, until the GRAIN token page tokens land. */
export const READY={silo:['b','a','c'],site:['b','c']};
export const SURFACES={
 silo:{key:'silo-skin-v1',legacyKey:'silo-display-theme-v1',fallback:'b'},
 /* grainpad.fun opens white today (brand book). Kept as is until the owner decides whether the site default becomes b. */
 site:{key:'grain-skin-v1',legacyKey:'grainpad-theme',fallback:'c'},
};
export const LEGACY_TO_SKIN={light:'c',dark:'b'};
export function isSkin(value){return typeof value==='string'&&SKINS.includes(value);}
/* Old two-value attribute that ~380 existing site rules still select on; derived, never stored. */
export function legacyAppearance(skin){return skin==='c'?'light':'dark';}
export function themeColor(skin){return skin==='c'?'#ffffff':'#101010';}
/* The Silo wallet's own ground per skin: the browser bar colour (theme-color) and the page behind the phone's safe areas. */
export const SILO_GROUND=Object.freeze({b:'#101010',a:'#14110e',c:'#e9dac6'});
export function siloThemeColor(skin){return SILO_GROUND[skin]??SILO_GROUND.b;}
function read(storage,key){try{return storage.getItem(key);}catch{return null;}}
/** Saved choice, else the migrated old choice (light -> c, dark -> b, system -> default), else the surface default.
    A skin the surface cannot show yet falls back to the default. */
export function resolveSkin(storage,surface){
 const cfg=SURFACES[surface],ready=READY[surface];
 for(const raw of [read(storage,cfg.key),LEGACY_TO_SKIN[read(storage,cfg.legacyKey)]]){if(isSkin(raw)&&ready.includes(raw))return raw;}
 return cfg.fallback;
}
/** Returns true when the choice reached storage. */
export function saveSkin(storage,surface,skin){
 if(!isSkin(skin))return false;
 try{storage.setItem(SURFACES[surface].key,skin);return true;}catch{return false;}
}
