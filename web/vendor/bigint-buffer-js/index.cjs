'use strict';
// CommonJS is required by the upstream SPL layout consumers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {Buffer} = require('buffer');
const MAX_BYTES = 65536;
function bytes(input) {
  if (!Buffer.isBuffer(input)) throw new TypeError('Expected Buffer.');
  if (input.length > MAX_BYTES) throw new RangeError('Integer buffer exceeds 64 KiB.');
  return input;
}
function toBigIntBE(input) {
  const hex = bytes(input).toString('hex');
  return hex ? BigInt('0x' + hex) : 0n;
}
function toBigIntLE(input) {
  return toBigIntBE(Buffer.from(bytes(input)).reverse());
}
function toBufferBE(value, width) {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('Expected unsigned bigint.');
  if (!Number.isSafeInteger(width) || width < 0 || width > MAX_BYTES) throw new RangeError('Invalid integer width.');
  if (width === 0) {
    if (value !== 0n) throw new RangeError('Integer does not fit width.');
    return Buffer.alloc(0);
  }
  const hex = value.toString(16);
  if (hex.length > width * 2) throw new RangeError('Integer does not fit width.');
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}
function toBufferLE(value, width) { return toBufferBE(value, width).reverse(); }
exports.toBigIntBE = toBigIntBE;
exports.toBigIntLE = toBigIntLE;
exports.toBufferBE = toBufferBE;
exports.toBufferLE = toBufferLE;
