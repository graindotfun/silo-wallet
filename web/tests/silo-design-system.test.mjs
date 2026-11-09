import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
/** Round 2 (15 October 2026): Ledger shell with windows. Updated deliberately from the round 1 contract; no security or disclosure assertion was weakened. Guards the Silo design system against drifting from the brand book (design/brand-system.md,
 * design/silo-v1/DIRECTION.md, design/silo-v2/MAPPING.md). Source scan only: rendered checks live in the browser audits recorded in design/silo-v1/RESULTS.md. */
const css=readFileSync(new URL('../app/app/silo.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
const overview=readFileSync(new URL('../components/silo-overview.tsx',import.meta.url),'utf8');
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m=>({selector:m[1].trim(),body:m[2]}));
test('type: Albert Sans 600 for text and Plex Mono 400 only; no other weights',()=>{
 const weights=[...css.matchAll(/font-weight\s*:\s*([^;}!]+)/g)].map(m=>m[1].trim());
 assert.ok(weights.length>0);
 assert.deepEqual([...new Set(weights)].sort(),['400','600']);
 for(const {selector,body} of rules)if(/font-weight\s*:\s*400/.test(body))assert.match(body,/font-family\s*:\s*var\(--silo-mono\)|font-family\s*:\s*'IBM Plex Mono'/,`400 is for Plex Mono only: ${selector}`);
});
test('type: nothing under 12px except the 11px asset-initial glyph',()=>{
 const small=rules.flatMap(({selector,body})=>[...body.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)].filter(m=>Number(m[1])<12).map(()=>selector));
 assert.ok(small.every(selector=>selector.includes('.silo-asset-icon')),small.join(' | '));
});
test('brand orange: hover never lightens or darkens, no filters, accent never mixed with black',()=>{
 assert.doesNotMatch(css,/filter\s*:/);
 assert.doesNotMatch(css,/color-mix\([^)]*(var\(--silo-accent\)|var\(--grain-orange\))[^)]*,\s*(black|#000)/);
 assert.match(css,/--grain-orange-ring/);
});
test('headlines: lower-case source copy, never a CSS text-transform on headings',()=>{
 for(const {selector,body} of rules)if(/(^|[\s,>])h[1-4]\b/.test(selector))assert.doesNotMatch(body,/text-transform/,selector);
 assert.match(overview,/view==='overview'\?'home':view==='activity'\?'activity':view==='swap'\?'swap'/);
 assert.match(overview,/className="silo-stop"/);
 // The full stop is orange on dark and the darker orange text token on light (white-on-orange is 2.94:1).
 assert.match(css,/\.silo-stop\{color:var\(--silo-accent-text\)\}/);
 assert.match(css,/--silo-accent-text:var\(--grain-orange-ink\)/);
});
test('round 2: the primary action is the inverse pill, orange is the Private window, mark and title stop only',()=>{
 assert.match(css,/--silo-primary:#fff;--silo-on-primary:#101010/);
 assert.match(css,/--silo-primary:#101010;--silo-on-primary:#fff/);
 assert.match(css,/\.silo-app \.silo-button\[data-variant=primary\]\{background:var\(--silo-primary\)/);
 assert.doesNotMatch(css,/background:var\(--silo-accent\)/,'no button or control is filled with the accent');
 const orangeFills=[...css.matchAll(/([^{}]+)\{[^{}]*background:var\(--grain-orange\)[^{}]*\}/g)].map(match=>match[1].trim());
 for(const selector of orangeFills)assert.match(selector,/silo-window\[data-zone=private\]|zone-mark|split-bar|silo-zone-head|silo-next\[data-tone=private\]|silo-xmr|silo-zec|silo-secret-caret|silo-backup-banner|^\.silo-money$/,`orange fill outside the Private zone: ${selector}`);
 assert.match(css,/\.silo-window\[data-zone=private\]\{background:var\(--grain-orange\);color:#101010/);
 assert.match(css,/\.silo-window\[data-zone=public\]\{border:2px solid var\(--silo-public\)\}/);
 assert.match(css,/\.silo-window\[data-zone=soon\]\{border:2px dashed/);
});
test('tokens: light muted is #666666 (4.5:1 on raised), controls are 52px, disabled controls are a flat muted fill (r8: dashed only means not yet)',()=>{
 assert.match(css,/--silo-muted:#666666;--silo-faint:#666666/);
 assert.doesNotMatch(css,/--silo-muted:#6b6b6b/);
 assert.match(css,/min-height:52px;padding:0 24px;border:1\.5px solid var\(--silo-control-line\)/);
 assert.match(css,/\.silo-app \.silo-button\[aria-disabled=true\]\{[^}]*border:2px solid transparent!important/);
 assert.match(css,/outline:3px solid var\(--silo-focus\);outline-offset:3px/);
});
test('zones: Private is orange, Public an outline, Off and Soon dashed; status is text, never a pill',()=>{
 assert.match(css,/\.silo-zone-mark\[data-zone=private\]\{[^}]*background:var\(--grain-orange\)/);
 assert.match(css,/\.silo-zone-mark\[data-zone=public\]\{[^}]*border:2px solid var\(--silo-public\)/);
 assert.match(css,/\.silo-zone-mark\[data-zone=soon\]\{[^}]*border:2px dashed/);
 assert.match(css,/\.silo-zone-chip\[data-zone=soon\]\{border:1\.5px dashed/);
 const state=rules.find(rule=>rule.selector==='.silo-state');
 assert.ok(state);assert.match(state.body,/border:0/);assert.match(state.body,/padding:0/);
 assert.match(overview,/xmrOff\?'Off in this build'/);
});
// 23 Oct (owner: the simplest wallet; Opus UX consultation): one column, Monero first. 6 Nov (owner, r8 Home): the total leads,
// then one stack of asset cards on their own colours (Monero, Solana, tokens, other networks), Swap when open, recent activity.
test('Home: header sentence, total, asset stack (Monero, Solana, tokens, other networks), Swap when open, recent activity; one column',()=>{
 const home=overview.slice(overview.indexOf('const home=<div className="silo-home">'));
 const order=['className="silo-total"','className="silo-asset-stack"','data-zone={xmrOff?\'soon\':\'private\'}','className="silo-window silo-window-public"','aria-label="Solana actions"','tokenRows.map(','evm!==null&&shown(\'evm\')','silo-recent-title'].map(marker=>home.indexOf(marker));
 assert.equal(home.indexOf('className="silo-home-side"'),-1,'no side column on Home');
 assert.ok(order.every(index=>index>0),`every Home part is present: ${order}`);
 assert.deepEqual([...order].sort((a,b)=>a-b),order);
 assert.match(overview,/<p className="silo-state-line">\{stateLine\}<\/p>/);
 // Peer actions share one equal-width row; a held action is aria-disabled with its reason listed under the row.
 assert.match(css,/\.silo-actions\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,132px\),1fr\)\)/);
 assert.match(overview,/aria-disabled=\{enabled\?undefined:true\}/);
 assert.match(overview,/className="silo-whynot"/);
 // Held and preview copy comes from real runtime state, not constants for the screen.
 assert.match(overview,/swapMode==='held'/);assert.match(overview,/releaseHeld&&!xmr\.opened/);
 // Not enabled in this build is never presented as Locked.
 assert.match(overview,/xmrOff\?'Off in this build'/);
});
test('navigation: Home, Swap, Activity, Settings; wallets are reached from Home; bottom bar below 700, rail to 1099, sidebar from 1100',()=>{
 assert.match(overview,/\[\{id:'overview' as View,label:'Home'.*\{id:'swap' as View,label:'Swap'.*\{id:'activity' as View,label:'Activity'.*\{id:'settings' as View,label:'Settings'/);
 assert.doesNotMatch(overview.match(/const views=\[[^\n]*\]/)[0],/Wallets/);
 assert.match(css,/@media\(max-width:699px\)\{/);
 assert.match(css,/@media\(max-width:1099px\)\{/);
 assert.match(css,/\.silo-app \.silo-view-tabs\{display:grid;grid-template-columns:repeat\(5/);
 assert.match(css,/position:fixed;left:0;right:0;bottom:0/);
 assert.match(overview,/<nav className="silo-view-tabs"[^\n]*<span>Home<\/span>[^\n]*navigate\('send'[^\n]*<span>Send<\/span>[^\n]*views\.slice\(1\)/);
 assert.match(css,/body:has\(\.grainy\) \.silo-main\{padding-bottom:calc\(160px \+ env\(safe-area-inset-bottom\)\)\}/);
 assert.match(css,/padding:16px 16px calc\(96px \+ env\(safe-area-inset-bottom\)\)/);
 assert.match(css,/min-height:56px/);
 assert.match(css,/grid-template-columns:minmax\(0,640px\) 320px/);
});
test('swap: one place with two tasks; the network is one small header badge on every screen, never a row of copy',()=>{
 assert.match(overview,/role="radiogroup" aria-label="What do you want to do"/);
 assert.match(css,/\[data-view=swap\]\[data-task=swap\] #silo-conversion\{display:none\}/);
 assert.match(css,/\[data-view=swap\]\[data-task=cashout\] #silo-swap\{display:none\}/);
 assert.match(overview,/className="silo-net-badge"/);
 assert.match(overview,/This uses real funds\./);
 assert.doesNotMatch(overview,/aria-label="Active wallet networks"|className="silo-network-band"/);
});
test('logo clear space is half the logo height (18px at 36px), the wordmark is never narrower than 100px and phones use the approved symbol',()=>{
 assert.match(css,/\.silo-wordmark\{[^}]*padding:18px/);
 assert.match(css,/\.silo-wordmark \.silo-logo-full\{min-width:104px/);
 assert.match(css,/\.silo-mobile-logo\{display:block;flex:none;width:32px;height:34px\}/); // the approved symbol, 16px clear space
});
test('wallet keeps its own tokens when the grainpad site sheet recolours bare dt and footer',()=>{
 assert.match(css,/\.silo-app \.silo-app-footer,\.silo-app \.silo-app-footer \*\{color:var\(--silo-muted\)!important\}/);
 assert.match(css,/\.silo-app dt\{color:var\(--silo-muted\)!important\}/);
});
test('the slogan is rendered from lib/silo-brand.ts, exactly, beside the navigation and on About, never on a review or a footer',()=>{
 assert.match(overview,/<p className="silo-sidebar-line">\{SILO_TAGLINE\}<\/p>/);
 assert.match(overview,/<dt>Slogan<\/dt><dd>\{SILO_TAGLINE\}<\/dd>/);
 assert.doesNotMatch(overview.slice(overview.indexOf('<footer')),/SILO_TAGLINE/);
 const brand=readFileSync(new URL('../lib/silo-brand.ts',import.meta.url),'utf8');
 assert.match(brand,/'ape in public\.', 'cash out private\.'/);
 // The beta line stays on the sidebar, Home context column and About.
 assert.match(overview,/Beta, not externally audited\. Use small amounts\./);
 assert.match(overview,/<strong>Beta, not externally audited\.<\/strong>/);
});

test('the gate and opening screens sit outside .silo-app, so their orange surface must carry a root-level fallback',()=>{
 const uses=[...css.matchAll(/var\(--silo-brand-surface([^)]*\)?)\)/g)];
 assert.ok(uses.length>=2,'the gate and the opening splash use the brand surface alias');
 for(const use of uses)assert.match(use[0],/var\(--silo-brand-surface,var\(--grain-orange\)\)/,'an alias defined only inside .silo-app resolves to transparent on the gate and the opening splash');
 assert.match(readFileSync(new URL('../app/globals.css',import.meta.url),'utf8'),/--grain-orange:\s*#ff6600/,'the fallback token is defined at the document root');
});

test('the fixed bottom bar steps aside while a text field is focused (iOS keyboard)',()=>{
 const css=readFileSync(new URL('../app/app/silo.css',import.meta.url),'utf8');
 const guard=readFileSync(new URL('../components/silo-keyboard-guard.tsx',import.meta.url),'utf8');
 const overview=readFileSync(new URL('../components/silo-overview.tsx',import.meta.url),'utf8');
 assert.match(css,/html\[data-silo-keyboard\] \.silo-app \.silo-view-tabs\{[^}]*translateY\(110%\)/);
 assert.match(guard,/focusin/);assert.match(guard,/data-silo-keyboard/);
 assert.match(overview,/useSiloKeyboardGuard\(\);/);
});

test('passphrase fields use the supplied asterisk, offer Show, and nothing zooms the wallet',()=>{
 const css=readFileSync(new URL('../app/app/silo.css',import.meta.url),'utf8');
 const field=readFileSync(new URL('../components/silo-secret-field.tsx',import.meta.url),'utf8');
 const page=readFileSync(new URL('../app/app/page.tsx',import.meta.url),'utf8');
 assert.match(field,/viewBox="0 0 3244\.74 3642\.73"/);assert.match(field,/aria-pressed/);assert.equal(/\{shown\?'Hide':'Show'\}/.test(field),false,'the toggle text lives in CSS so the field label stays exact');assert.match(field,/shown\?'text':'password'/);
 assert.match(css,/\.silo-secret-stars\{[^}]*color:var\(--grain-orange/);
 assert.match(css,/font-size:16px/);assert.match(css,/touch-action:manipulation/);
 assert.match(page,/maximumScale:1/);assert.match(page,/userScalable:false/);
 for(const name of ['silo-native-zone','silo-native-public-wallet','silo-account-panel','silo-inline-account-unlock']){
  const source=readFileSync(new URL(`../components/${name}.tsx`,import.meta.url),'utf8');
  assert.equal(/<input[^>]*type="password"/.test(source),false,`${name} still renders a native password input`);
 }
});
