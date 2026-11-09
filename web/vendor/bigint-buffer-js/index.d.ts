import {Buffer} from 'buffer';
export declare function toBigIntBE(value: Buffer): bigint;
export declare function toBigIntLE(value: Buffer): bigint;
export declare function toBufferBE(value: bigint, width: number): Buffer;
export declare function toBufferLE(value: bigint, width: number): Buffer;
