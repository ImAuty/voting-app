// Shared mutable state read/written by the router (app.js) and by
// individual screens under views/. A plain exported object rather than
// separately-exported `let` bindings, since ES modules only give importers a
// read-only view of an imported `let` - mutating a property of an imported
// object works everywhere, reassigning an imported binding doesn't.

/** @import { CopySource } from "./shared.js" */

/**
 * @type {{
 *   uid: string | null,
 *   copySource: CopySource | null,
 *   recoveryError: string | null,
 * }}
 */
export const state = {
  uid: null, // signed-in (anonymous) user's uid, set once by main() before any route renders
  copySource: null, // { question, options } staged by "copy and create new" in the history list
  recoveryError: null, // set by app.js right before re-navigating to /poll/{id}/admin after a failed ?recover= attempt; consumed once by views/voter.js
};
