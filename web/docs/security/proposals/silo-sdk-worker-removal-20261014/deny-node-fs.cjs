'use strict';
const refuse=()=>{throw Error('Node filesystem is unavailable in the browser SDK candidate')};
module.exports={promises:new Proxy(Object.create(null),{get:()=>refuse})};
