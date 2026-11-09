import {SiloAssetIcon} from './silo-asset-icon';
/** Presentation-only native header. The mounted NativeZone retains all controllers,
 * backup gates, refusal codes, locking and payment recovery. */
export function SiloNativeWorkspaceHeader({name,asset,zone,networkLabel}:{name:string;asset:string;zone:'xmr'|'zec';networkLabel:string}){return <div className="silo-zone-head silo-native-workspace-head"><SiloAssetIcon asset={zone}/><div><span className="silo-eyebrow">{zone==='xmr'?'PRIVATE WINDOW':'SHIELDED WINDOW'}</span><h2>{name} <small className="silo-zone-network">{asset}</small></h2><span className="silo-zone-network">{networkLabel}</span></div><span className="silo-tag">{zone==='xmr'?'Private':'Shielded'}</span></div>;}
