"use client";
import {usePathname} from "next/navigation";
import {ContractAddressBar} from "./contract-address-bar";
import {PriceTab} from "./price-tab";
/** Solana's GRAIN address and SOL/wXMR rates must not look like Robinhood assets. */
export function ChainContextChrome({slot}: {slot: "contract" | "prices"}) {
  const path = usePathname();
  if (path === "/app" || path?.startsWith("/app/") || path?.startsWith("/launch/robinhood/mainnet") || path?.startsWith("/network/robinhood/mainnet")) return null;
  return slot === "contract" ? <ContractAddressBar/> : <PriceTab/>;
}
