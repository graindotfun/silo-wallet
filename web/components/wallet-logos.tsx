import Image from "next/image";
import {Wallet as WalletGlyph} from "lucide-react";

/** Official icons for the known injected wallets (from each wallet's brand kit); Wallet Standard entries use the image the wallet reports. */
const KNOWN_ICONS:Record<string,string>={phantom:"/brand/wallets/phantom.svg?v=64e60dc565ab",solflare:"/brand/wallets/solflare.svg?v=15dcc5af153e"};

export function WalletLogo({brand,icon,size=40}:{brand:string;icon?:string|null;size?:number}){
 const src=icon||KNOWN_ICONS[brand.trim().toLowerCase()];
 const mark=src?<Image unoptimized src={src} alt="" width={size} height={size} draggable={false}/>:<span className="wallet-logo-generic"><WalletGlyph size={Math.round(size*.5)}/></span>;
 return <span className="wallet-logo" style={{width:size,height:size}} aria-hidden="true">{mark}</span>;
}
