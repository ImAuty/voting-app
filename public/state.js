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
 * }}
 */
export const state = {
  uid: null, // signed-in (anonymous) user's uid, set once by main() before any route renders
  copySource: null, // { question, options } staged by "copy and create new" in the history list
};
