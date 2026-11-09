declare const __GRAINPAD_COMMIT__: string | null;

// Replaced by Vite from the exact deployed GitHub main SHA. No runtime secrets.
export const BUILD_COMMIT: string | null =
  typeof __GRAINPAD_COMMIT__ === "undefined" ? null : __GRAINPAD_COMMIT__;
