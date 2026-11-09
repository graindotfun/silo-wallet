/** Display only. Concatenating groups must always return the exact original address.
 * Group from the end so its final four characters form a complete check group. */
export function siloAddressGroups(address){
 if(typeof address!=='string')throw Error('Address text required.');
 if(!/^[A-Za-z0-9]{1,4096}$/.test(address))return [address];
 const first=address.length%4||4,groups=[address.slice(0,first)];for(let offset=first;offset<address.length;offset+=4)groups.push(address.slice(offset,offset+4));return groups;
}
