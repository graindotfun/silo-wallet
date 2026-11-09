#!/bin/sh
# Grain Silo ZEC core on upstream librustzcash (zcash_client_backend 0.25.0-pre.1, zcash_client_sqlite 0.23.0-pre.1; NU7 testnet) for the browser.
# Research build: it creates, signs and sends nothing. Output: .silo-sdk-build/zec-core/generated (wasm-bindgen web target and
# silo-zec-core-bundle.js, the single verified script the page runs).
set -eu
silo_repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
silo_build=${1:-"$silo_repo/.silo-sdk-build/zec-core"}
case "$silo_build" in /*) ;; *) silo_build="$silo_repo/$silo_build" ;; esac
silo_toolchain=nightly-2026-09-15
# Prerequisites: the pinned nightly with rust-src and wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129, LLVM clang.
[ "$(wasm-bindgen --version)" = 'wasm-bindgen 0.2.129' ] || { echo 'Use wasm-bindgen 0.2.129 (matches Cargo.lock).' >&2; exit 1; }
[ ! -e "$silo_build" ] || { echo 'Use a fresh build directory; existing output is preserved.' >&2; exit 1; }
mkdir -p "$silo_build/vendor"
cp -R "$silo_repo/vendor/silo/zec-core/." "$silo_build/"
cd "$silo_build"
# Two crates.io sources are patched (patches/): zcash_client_sqlite moves to rusqlite 0.40, whose bundled SQLite builds for
# wasm32-unknown-unknown (sqlite-wasm-rs), and fails closed if its extension authorizer cannot be installed;
# schemerz-rusqlite (its migration runner) follows the same rusqlite. Sources are checksum-pinned.
for crate in zcash_client_sqlite-0.23.0-pre.1 schemerz-rusqlite-0.370.0; do
  name=${crate%%-[0-9]*}
  curl -fsSL -o "$crate.crate" "https://static.crates.io/crates/$name/$crate.crate"
done
sha256sum -c CRATES.sha256
for crate in zcash_client_sqlite-0.23.0-pre.1 schemerz-rusqlite-0.370.0; do
  name=${crate%%-[0-9]*}
  tar -xzf "$crate.crate" -C vendor && mv "vendor/$crate" "vendor/$name" && rm -f "vendor/$name/Cargo.toml.orig"
  patch -p1 -d "vendor/$name" < "patches/$crate.patch"
done
# Threads: upstream scanning runs on rayon, so memory is shared and imported; the bundled SQLite C object is compiled with the
# same features. 1 GiB maximum as for the current engine. Paths are remapped so the bytes do not depend on the machine.
silo_sysroot=$(rustc +"$silo_toolchain" --print sysroot)
export CFLAGS_wasm32_unknown_unknown="-matomics -mbulk-memory -mmutable-globals -ffile-prefix-map=$silo_build=/silo-zec-core -ffile-prefix-map=${CARGO_HOME:-$HOME/.cargo}=/cargo"
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=1073741824 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base --remap-path-prefix=$silo_build=/silo-zec-core --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$silo_sysroot=/rust"
cargo +"$silo_toolchain" build --locked --release --target wasm32-unknown-unknown -Z build-std=panic_abort,std
wasm-bindgen target/wasm32-unknown-unknown/release/silo_zec_core.wasm --target web --no-typescript --out-dir generated
node "$silo_repo/scripts/silo/bundle-zec-core.mjs" generated
sha256sum generated/silo_zec_core_bg.wasm generated/silo-zec-core-bundle.js
# To serve it: node scripts/silo/package-zec-core.mjs .silo-sdk-build/zec-core (from the repository root).
