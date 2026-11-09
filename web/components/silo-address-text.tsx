import {siloAddressGroups} from '@/lib/silo/address-groups.mjs';
export function SiloAddressText({address}:{address:string}){return <code className="exposure-address">{siloAddressGroups(address).map((group,index)=><span key={index} className="silo-address-group">{group}</span>)}</code>;}
