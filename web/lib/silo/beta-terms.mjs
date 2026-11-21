/** Beta terms (owner decision, 23 October 2026): entering, with or without a code, requires accepting this exact version of
 * the terms page (served by the signup Worker at /silo-beta-terms-v2). The entry route refuses any other value, so publishing
 * a later version asks every new entry again. Shared by the page and the server; nothing here is secret. */
export const SILO_BETA_TERMS='silo-beta-terms-v2';
/** One plain sentence on the entry gate saying what terms v2 changes. Anyone holding an entry proof made under terms v1 is asked to accept again,
 * because the proof carries the terms version (lib/silo/beta-guard.mjs). Display only. */
export const SILO_BETA_TERMS_CHANGE_NOTE='Terms v2 adds a section on what happens if the maker does not complete an XMR to SOL swap.';
