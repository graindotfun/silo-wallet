import {SITE} from '@/lib/site-config';

export function DiscordLink(){
 return <a className="header-social" href={SITE.discord} target="_blank" rel="noreferrer" aria-label="Join the grainpad Discord (opens in a new tab)">
  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M19.73 4.51a19.8 19.8 0 0 0-4.89-1.52l-.6 1.23a18.4 18.4 0 0 0-4.48 0l-.6-1.23a19.8 19.8 0 0 0-4.89 1.52C1.18 9.1.34 13.58.76 18a19.9 19.9 0 0 0 6 3.02l1.23-2a12.9 12.9 0 0 1-1.94-.93l.48-.37c3.75 1.74 7.81 1.74 11.52 0l.48.37a12.9 12.9 0 0 1-1.94.93l1.23 2a19.9 19.9 0 0 0 6-3.02c.5-5.13-.86-9.57-4.09-13.49ZM8.5 15.5c-1.1 0-2-1.01-2-2.25S7.4 11 8.5 11s2 1.01 2 2.25-.9 2.25-2 2.25Zm7 0c-1.1 0-2-1.01-2-2.25s.9-2.25 2-2.25 2 1.01 2 2.25-.9 2.25-2 2.25Z"/></svg>
 </a>;
}
