'use strict';
// Diagnostic candidate: no Node crypto operation is available in the browser.
module.exports = new Proxy(Object.create(null), {get(_target, name){if(name==='__esModule')return false;throw new Error('Node crypto is unavailable in the browser SDK candidate');}});
