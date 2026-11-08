// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/* eslint-disable @next/next/no-img-element -- Packaged wallet logos, no external image optimizer. */
import {useState} from 'react';
export function SiloAssetIcon({asset}:{asset:'xmr'|'zec'|'sol'|'usdc'|'grain'|'token'|'eth'|'base'|'bnb'|'evm'}){
 const [failed,setFailed]=useState(false);
 if(asset==='evm')return <span className="silo-asset-icon silo-evm-icons" data-asset="evm" aria-hidden="true">{['eth','base','bnb'].map(chain=><img key={chain} src={`/silo-icons/${chain}.svg`} alt="" width={26} height={26}/>)}</span>;
 const icon=asset==='xmr'?'xmr-color':asset==='sol'?'sol-color':asset==='usdc'?'usdc-color':asset;
 return <span className="silo-asset-icon" data-asset={asset} aria-hidden="true">{asset==='token'||failed?<span>{asset==='token'?'○':asset.toUpperCase().slice(0,1)}</span>:<img src={`/silo-icons/${icon}.svg`} alt="" width={40} height={40} onError={()=>setFailed(true)}/>}</span>;
}
