import { db, waitForUser } from "./firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { state } from "./state.js";
import { appEl, toPoll, escapeHtml, showError } from "./shared.js";
import { renderCreateForm } from "./views/create.js";
import { renderVoter } from "./views/voter.js";
import { renderAdmin } from "./views/admin.js";
import { renderHistory } from "./views/history.js";
import { renderRootList } from "./views/root.js";

/** @import { Route } from "./shared.js" */
/** @import { Unsubscribe } from "firebase/firestore" */

/** @type {Route | null} */
let route = null;
/** @type {Unsubscribe[]} */
let routeUnsubs = []; // every Firestore listener the current route depends on

// ---- Router ----
//
// "/"                 -> list of every currently-active poll (any creator)
// "/new"               -> the create-poll form, unconditionally
// "/history"           -> polls I've created, past and present
// "/poll/{id}"         -> voting view for that specific poll
// "/poll/{id}/admin"   -> management view, if I'm that poll's creator
//
// Deep links work because every poll-specific view is looked up by the id in
// the URL rather than "whichever poll happens to be active" - visiting
// "/poll/xyz" always shows poll xyz, whether or not it's still open.

/** @returns {Route} */
function parseRoute() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { type: "root" };
  if (path === "/new") return { type: "create" };
  if (path === "/history") return { type: "history" };
  let m = path.match(/^\/poll\/([^/]+)\/admin$/);
  if (m) return { type: "poll", pollId: decodeURIComponent(m[1]), admin: true };
  m = path.match(/^\/poll\/([^/]+)$/);
  if (m) return { type: "poll", pollId: decodeURIComponent(m[1]), admin: false };
  return { type: "notfound" };
}

/**
 * @param {string} path
 * @param {{ replace?: boolean }} [options]
 */
export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  route = parseRoute();
  renderRoute();
}

window.addEventListener("popstate", () => {
  route = parseRoute();
  renderRoute();
});

// Delegated once: nav links (data-link) are re-rendered often enough that
// per-element listeners would need constant rewiring, and option thumbnails
// (voter list + results) need the same treatment for the lightbox.
appEl.addEventListener("click", (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const link = target.closest("a[data-link]");
  if (link) {
    e.preventDefault();
    navigate(/** @type {string} */ (link.getAttribute("href")));
  } else if (target.classList.contains("option-thumb")) {
    e.preventDefault();
    showLightbox(/** @type {string} */ (target.getAttribute("src")));
  }
});

/** @param {string} src */
function showLightbox(src) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `<img src="${escapeHtml(src)}" alt="" />`;
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

async function main() {
  const user = await waitForUser();
  state.uid = user.uid;
  route = parseRoute();
  renderRoute();
}

function renderRoute() {
  routeUnsubs.forEach((unsub) => unsub());
  routeUnsubs = [];

  if (route.type === "create") {
    renderCreateForm();
  } else if (route.type === "history") {
    routeUnsubs.push(renderHistory());
  } else if (route.type === "poll") {
    renderPollRoute(route.pollId, route.admin);
  } else if (route.type === "notfound") {
    renderNotFound();
  } else {
    routeUnsubs.push(renderRootList());
  }
}

/**
 * @param {string} pollId
 * @param {boolean} admin
 */
function renderPollRoute(pollId, admin) {
  appEl.innerHTML = `<p class="muted">読み込み中…</p>`;

  /** @type {Unsubscribe | null} */
  let innerUnsub = null;
  function clearInner() {
    if (innerUnsub) {
      innerUnsub();
      innerUnsub = null;
    }
  }

  const outerUnsub = onSnapshot(
    doc(db, "polls", pollId),
    (snap) => {
      clearInner();
      if (!snap.exists()) {
        renderNotFound();
        return;
      }
      const poll = toPoll(snap.id, snap.data());
      if (admin && poll.createdBy === state.uid) {
        innerUnsub = renderAdmin(poll);
      } else {
        // Either a voter link, or an admin link opened by someone who isn't
        // the creator (URL-based admin access isn't supported - the
        // security rules still gate results/votes by createdBy, so this
        // falls back to the voting view instead of a dead end).
        innerUnsub = renderVoter(poll);
      }
    },
    showError,
  );

  routeUnsubs.push(outerUnsub, clearInner);
}

function renderNotFound() {
  appEl.innerHTML = `
    <h1>投票システム</h1>
    <div class="card">
      <p>指定された投票が見つかりませんでした。</p>
      <p class="muted"><a href="/" data-link>トップに戻る</a></p>
    </div>
  `;
}

main().catch(showError);
