// The browser's top bar (phone status bar, Safari tab tint) takes the page's theme-color. The invitation gate and the
// opening moment fill the whole screen with Silo orange, so the bar must be orange there too; a dark or cream bar above
// an orange screen reads as a stray strip. The wallet itself keeps the skin colour public/theme-init.js chose.
export const SILO_BRAND_THEME_COLOR='#ff6600';
/** Sets the orange bar and returns a function that puts back what was there before. */
export function holdBrandThemeColor(doc=globalThis.document){
 const meta=doc?.querySelector?.('meta[name="theme-color"]');
 if(!meta)return()=>{};
 const before=meta.getAttribute('content');
 meta.setAttribute('content',SILO_BRAND_THEME_COLOR);
 return()=>{if(meta.getAttribute('content')===SILO_BRAND_THEME_COLOR&&before!==null)meta.setAttribute('content',before);};
}
