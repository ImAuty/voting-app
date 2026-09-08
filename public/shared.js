// Types and utilities used across the router (app.js) and every screen
// under views/ - kept here instead of duplicated so there's one definition
// of what a Poll looks like and one place error/HTML-escaping happens.

/**
 * @typedef {Object} PollOption
 * @property {string} id
 * @property {string} text
 * @property {string} [description]
 * @property {string} [imageUrl]
 */

/**
 * @typedef {Object} Poll
 * @property {string} id
 * @property {string} question
 * @property {PollOption[]} options
 * @property {string[]} optionIds
 * @property {boolean} isActive
 * @property {boolean} [isDraft] - true while still being edited pre-publish; absent/false means published
 * @property {import("firebase/firestore").Timestamp} createdAt
 * @property {string} createdBy
 */

/**
 * @typedef {{ question: string, options: PollOption[] }} CopySource
 */

/**
 * @typedef {{ type: "root" }} RootRoute
 * @typedef {{ type: "create" }} CreateRoute
 * @typedef {{ type: "history" }} HistoryRoute
 * @typedef {{ type: "poll", pollId: string, admin: boolean, recoverToken: string | null }} PollRoute
 * @typedef {{ type: "notfound" }} NotFoundRoute
 * @typedef {RootRoute | CreateRoute | HistoryRoute | PollRoute | NotFoundRoute} Route
 */

/** @import { DocumentData } from "firebase/firestore" */

export const appEl = /** @type {HTMLElement} */ (document.getElementById("app"));

/**
 * @param {string} id
 * @param {DocumentData} data
 * @returns {Poll}
 */
export function toPoll(id, data) {
  return /** @type {Poll} */ ({ id, ...data });
}

export function topNavHtml() {
  return `<p class="muted" style="text-align:right;margin-top:-8px"><a href="/history" data-link id="history-link">過去の投票一覧</a></p>`;
}

/** @param {string} value */
export function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

/** @param {import("firebase/firestore").Timestamp | undefined} timestamp */
export function formatDate(timestamp) {
  if (!timestamp?.toDate) return "";
  return timestamp.toDate().toLocaleString("ja-JP");
}

/** @param {unknown} str */
export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[/** @type {"&"|"<"|">"|"\""|"'"} */ (c)],
  );
}

/** @param {unknown} err */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {unknown} err */
export function showError(err) {
  console.error(err);
  appEl.innerHTML = `<p class="error">エラーが発生しました: ${escapeHtml(errorMessage(err))}</p>`;
}
