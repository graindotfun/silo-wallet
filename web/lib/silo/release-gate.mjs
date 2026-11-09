/** Mainnet stays held until exact-candidate external review and recovery evidence are supplied. */
/** Admission scope (Sol, review of 3d18b3cd, R5-H1): who may enter is part of what a release review covers. Evidence names the
 * scope it was reviewed for ('invite' when absent, as all earlier evidence was); the runtime may narrow it at any moment (open
 * evidence, invite runtime: always allowed, the immediate close path) but never broaden it (invite evidence, open runtime:
 * held until evidence reviewed for open admission is supplied). */
export const SILO_ADMISSION_SCOPES=Object.freeze(['invite','open']);
export function evaluateSiloRelease(evidence,{commit,assets,origin,runtime,admission='invite'}={}){
 const reasons=[];
 if(!evidence||typeof evidence!=='object')return {ready:false,reasons:['Independent security review and release evidence have not been supplied.']};
 if(!/^[a-f0-9]{40}$/.test(commit??'')||evidence.commit!==commit)reasons.push('Review must bind the exact compiled source commit.');
 if(!/^https:\/\//.test(origin??'')||evidence.origin!==origin||evidence.isolatedWalletOrigin!==true)reasons.push('A reviewed isolated HTTPS wallet origin is required.');
 if(!/^[a-f0-9]{64}$/.test(runtime??'')||evidence.runtimeFingerprint!==runtime)reasons.push('Review must bind the exact node and provider configuration.');
 if(JSON.stringify(evidence.assets)!==JSON.stringify(assets))reasons.push('Review must bind all wallet SDK assets and versions.');
 const reviewedScope=evidence.admissionScope??'invite';
 if(!SILO_ADMISSION_SCOPES.includes(reviewedScope))reasons.push('Review must name a valid admission scope.');
 else if(!SILO_ADMISSION_SCOPES.includes(admission)||(admission==='open'&&reviewedScope!=='open'))reasons.push('Open admission requires release evidence reviewed for open admission.');
 // Owner decision, 21 October 2026: the closed mainnet beta runs without an external audit. The gate accepts an explicit
 // deferral record for `independentAudit` only; it is reported as deferred, never as passed, and the product shows it.
 const audit=evidence.independentAudit,auditDeferred=audit?.deferred===true&&audit?.decidedBy==='owner'&&/^\d{4}-\d{2}-\d{2}$/.test(audit?.decidedOn??'')&&typeof audit?.note==='string'&&audit.note.length>0;
 const warnings=auditDeferred?[`Independent security audit deferred by owner decision (${audit.decidedOn}); this beta is not externally audited.`]:[];
 for(const field of ['independentAudit','restoreRecovery','mainnetReadOnly','cspAndDelivery','noServerKeys','providerPrivacy','ownerRiskAcceptance','sendFlowReview']){
  if(field==='independentAudit'&&auditDeferred)continue;
  if(evidence[field]?.passed!==true||!/^[a-f0-9]{64}$/.test(evidence[field]?.reportSha256??''))reasons.push(`${field} requires a passing review and report hash.`);
 }
 if(evidence.openCriticalFindings!==0||evidence.openHighFindings!==0)reasons.push('Critical and high findings must be closed.');
 return {ready:reasons.length===0,reasons,warnings,auditDeferred};
}
export function authorizeSiloNetwork(zone,network,release){
 // Bitcoin: test networks are always allowed; Bitcoin mainnet needs a ready release (exact-candidate review evidence) like the other real-funds zones.
 if(zone==='btc'){if(network==='testnet'||network==='signet')return;if(network==='mainnet'&&release?.ready===true)return;throw Error('Bitcoin mainnet is held pending release review.');}
 if((zone==='xmr'&&network==='stagenet')||(zone==='zec'&&network==='testnet'))return;
 if(network!=='mainnet'||!release?.ready)throw Error('Real-funds wallet actions are held pending exact-candidate release review.');
 if(!['xmr','zec'].includes(zone))throw Error('Unsupported Silo zone.');
}
