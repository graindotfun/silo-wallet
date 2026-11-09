import {SITE} from '@/lib/site-config';

export function XLink(){
 return <a className="header-social" href={SITE.twitter} target="_blank" rel="noreferrer" aria-label="grainpad on X (opens in a new tab)">
  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-7.4L5.5 22H2.3l7.3-8.5L.8 2h6.5l4.5 6.6L18.9 2Zm-1.1 18h1.8L6.3 3.9H4.4L17.8 20Z"/></svg>
 </a>;
}
