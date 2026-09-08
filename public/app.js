import { db, functions, waitForUser } from "./firebase.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";
import { state } from "./state.js";
import { appEl, toPoll, escapeHtml, errorMessage, showError } from "./shared.js";
import { renderCreateForm } from "./views/create.js";
import { renderVoter } from "./views/voter.js";
import { renderAdmin } from "./views/admin.js";
import { renderDraftEditor } from "./views/draft.js";
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
  if (m) {
    return {
      type: "poll",
      pollId: decodeURIComponent(m[1]),
      admin: true,
      recoverToken: new URLSearchParams(location.search).get("recover"),
    };
  }
  m = path.match(/^\/poll\/([^/]+)$/);
  if (m) return { type: "poll", pollId: decodeURIComponent(m[1]), admin: false, recoverToken: null };
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
    renderPollRoute(route.pollId, route.admin, route.recoverToken);
  } else if (route.type === "notfound") {
    renderNotFound();
  } else {
    routeUnsubs.push(renderRootList());
  }
}

/**
 * @param {string} pollId
 * @param {string} secret
 */
function recoverAdmin(pollId, secret) {
  return httpsCallable(functions, "recoverAdmin")({ pollId, secret });
}

/**
 * @param {string} pollId
 * @param {boolean} admin
 * @param {string | null} recoverToken
 */
function renderPollRoute(pollId, admin, recoverToken) {
  appEl.innerHTML = `<p class="muted">読み込み中…</p>`;

  /** @type {Unsubscribe | null} */
  let innerUnsub = null;
  function clearInner() {
    if (innerUnsub) {
      innerUnsub();
      innerUnsub = null;
    }
  }

  // Whether to act on recoverToken at all is decided ONLY from the very
  // first snapshot, i.e. from the state the poll was in when this page
  // loaded. Without this, a stale recoverToken sitting in this closure
  // would make a tab that started out as the creator try to reclaim
  // adminship right back the moment someone else legitimately recovers it
  // (its later snapshots would see "I'm not the creator anymore, but I do
  // remember a valid recovery token" and fire the call below all over
  // again) - an automatic tug-of-war neither side asked for.
  let firstSnapshot = true;

  const outerUnsub = onSnapshot(
    doc(db, "polls", pollId),
    (snap) => {
      clearInner();
      const isFirstSnapshot = firstSnapshot;
      firstSnapshot = false;

      if (!snap.exists()) {
        renderNotFound();
        return;
      }
      const poll = toPoll(snap.id, snap.data());

      if (admin && poll.createdBy === state.uid) {
        // Strip a spent or self-owned ?recover= token from the visible URL
        // either way - there's nothing left to do with it once we already
        // know we're the creator.
        if (recoverToken) history.replaceState({}, "", `/poll/${pollId}/admin`);
        if (poll.isDraft) {
          renderDraftEditor(poll);
        } else {
          innerUnsub = renderAdmin(poll);
        }
        return;
      }

      if (admin && isFirstSnapshot && recoverToken) {
        appEl.innerHTML = `<p class="muted">管理者として復旧しています…</p>`;
        recoverAdmin(pollId, recoverToken).catch(
          /** @param {unknown} err */
          (err) => {
            state.recoveryError = errorMessage(err);
            navigate(`/poll/${pollId}/admin`, { replace: true });
          },
        );
        return;
      }

      // Either a voter link, an admin link opened by someone who isn't the
      // creator and has no recovery token, or a spent/invalid one (the
      // error from that attempt, if any, is picked up by renderVoter via
      // state.recoveryError). The security rules still gate results/votes
      // by createdBy, so this falls back to the voting view instead of a
      // dead end.
      innerUnsub = renderVoter(poll);
    },
    (err) => {
      // A draft is only readable by its own creator (see firestore.rules) -
      // a stranger hitting one's URL gets a permission error rather than
      // poll data. Treated the same as a made-up id instead of the generic
      // error page, so a denied read doesn't read as "something's broken"
      // and doesn't confirm "a poll exists at this id" either.
      if (err.code === "permission-denied") {
        renderNotFound();
      } else {
        showError(err);
      }
    },
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
