// Shared mutable state read/written by the router (app.js) and by
// individual screens under views/. A plain exported object rather than
// separately-exported `let` bindings, since ES modules only give importers a
// read-only view of an imported `let` - mutating a property of an imported
// object works everywhere, reassigning an imported binding doesn't.

/** @import { Poll, CopySource } from "./shared.js" */

/**
 * @type {{
 *   uid: string | null,
 *   myPoll: Poll | null,
 *   activePoll: Poll | null,
 *   copySource: CopySource | null,
 * }}
 */
export const state = {
  uid: null, // signed-in (anonymous) user's uid, set once by main() before any route renders
  myPoll: null, // most recent poll I created, or null - only consulted on "/"
  activePoll: null, // the poll currently open for voting network-wide, or null - only consulted on "/"
  copySource: null, // { question, options } staged by "copy and create new" in the history list
};
