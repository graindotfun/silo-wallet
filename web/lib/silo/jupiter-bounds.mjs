/** One UTF-8 wire/storage budget for swap reviews, durable journals and API bodies. */
export const SILO_JUPITER_BODY_MAX_BYTES=32768;
export function siloJupiterSerializedBytes(value){return new TextEncoder().encode(JSON.stringify(value)).length;}
