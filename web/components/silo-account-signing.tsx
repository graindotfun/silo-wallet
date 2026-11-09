'use client';
import {createContext,useContext} from 'react';
import {accountSigning} from '@/lib/silo/sync/signing-gate.mjs';
export type SiloAccountSigning=ReturnType<typeof accountSigning>;
/** Read at the moment of signing, so a vault locked or unlocked meanwhile is honoured. Default: account sync off. */
const Context=createContext<()=>SiloAccountSigning>(()=>accountSigning());
export const SiloAccountSigningProvider=Context.Provider;
export function useSiloAccountSigning(){return useContext(Context);}
