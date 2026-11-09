"use client";
import {chooseSiteTheme,useSiteTheme} from "@/components/theme-toggle";

/* Footer and mobile-menu Appearance control. Two skins exist on the site today: Cold Brew (dark) and Oat Milk (light and warm; the stored choice is still the old light value).
   Campfire, Oat Milk and Tangerine Dream are Silo-only for now. Native radios: arrow keys and screen readers work. */
const OPTIONS=[
 {theme:"dark" as const,name:"Cold Brew",note:"Dark",strip:["#101010","#171717","#ff6600","#ffffff"]},
 {theme:"light" as const,name:"Oat Milk",note:"Light and warm",strip:["#3a2b20","#e9dac6","#ff6600","#1a1714"]},
];
export function AppearanceControl(){
 const current=useSiteTheme();
 return <fieldset className="gx-appearance"><legend className="gx-label">appearance</legend>
  <div className="gx-appearance-options">{OPTIONS.map(option=><label key={option.theme} className="gx-appearance-option" data-theme-option={option.theme}>
   <input type="radio" name="site-appearance" value={option.theme} checked={current===option.theme} onChange={()=>chooseSiteTheme(option.theme)}/>
   <span className="gx-appearance-strip" aria-hidden="true">{option.strip.map((color,index)=><i key={index} style={{background:color}}/>)}</span>
   <span className="gx-appearance-name">{option.name}</span><span className="gx-appearance-note">{option.note}</span>
  </label>)}</div>
 </fieldset>;
}
