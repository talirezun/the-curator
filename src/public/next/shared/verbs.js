/**
 * shared/verbs.js — THE VERB LIST (kit v1).
 *
 * One name per action, app-wide. The 2026-11-27 inventory found one verb
 * under four names (Refresh · Re-check · Check again · Sync now) and a fifth
 * on the domain page. New views name these buttons from here.
 *
 * NOT MIGRATED IN KIT v1: the existing buttons keep their words until their
 * view is rebuilt on the kit (phases 2–5), because many shipped suites pin
 * those words and a rename belongs with the rebuild that owns the screen.
 */

/** Re-read a state that may have changed (was Refresh / Re-check). */
export const CHECK_AGAIN = 'Check again';
/** Send and receive with the GitHub backup. */
export const SYNC_NOW = 'Sync now';
/** Join this app to something outside it (an agent, a provider, a repo). */
export const CONNECT = 'Connect';
/** Put a new thing into a list (a source, a document, a domain). */
export const ADD = 'Add';
/** Show a thing in the reader or its own page. */
export const OPEN = 'Open';

export const VERBS = Object.freeze({ CHECK_AGAIN, SYNC_NOW, CONNECT, ADD, OPEN });
