/** Beta terms (owner decision, 23 October 2026): entering, with or without a code, requires accepting this exact version of
 * the terms page (served by the signup Worker at /silo-beta-terms-v1). The entry route refuses any other value, so publishing
 * a later version asks every new entry again. Shared by the page and the server; nothing here is secret. */
export const SILO_BETA_TERMS='silo-beta-terms-v1';
