import { db, waitForUser } from "./firebase.js";
import {
  collection,
  doc,
  addDoc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

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
 * @typedef {{ type: "poll", pollId: string, admin: boolean }} PollRoute
 * @typedef {{ type: "notfound" }} NotFoundRoute
 * @typedef {RootRoute | CreateRoute | HistoryRoute | PollRoute | NotFoundRoute} Route
 */

/** @import { DocumentData, Unsubscribe } from "firebase/firestore" */

/**
 * @param {string} id
 * @param {DocumentData} data
 * @returns {Poll}
 */
function toPoll(id, data) {
  return /** @type {Poll} */ ({ id, ...data });
}

const appEl = /** @type {HTMLElement} */ (document.getElementById("app"));

/** @type {string | null} */
let uid = null;
/** @type {Poll | null} */
let myPoll = null; // most recent poll I created, or null - only consulted on "/"
/** @type {Poll | null} */
let activePoll = null; // the poll currently open for voting network-wide, or null - only consulted on "/"
/** @type {CopySource | null} */
let copySource = null; // { question, options } staged by "copy and create new" in the history list
/** @type {Route | null} */
let route = null;
/** @type {Unsubscribe[]} */
let routeUnsubs = []; // every Firestore listener the current route depends on

// ---- Router ----
//
// "/"                -> auto-redirects to whatever's relevant right now
// "/new"              -> the create-poll form, unconditionally
// "/history"          -> polls I've created, past and present
// "/poll/{id}"        -> voting view for that specific poll
// "/poll/{id}/admin"  -> management view, if I'm that poll's creator
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
function navigate(path, { replace = false } = {}) {
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
  uid = user.uid;
  route = parseRoute();

  // These two only matter for "/" - they decide where to send someone who
  // didn't arrive via a specific poll link. A transient failure here (e.g. a
  // newly-deployed composite index still building) shouldn't blow away
  // whatever the current route is actually showing, so they get their own
  // quiet error handler instead of the page-wiping showError().
  onSnapshot(
    query(collection(db, "polls"), where("isActive", "==", true), limit(1)),
    (snap) => {
      activePoll = snap.empty ? null : toPoll(snap.docs[0].id, snap.docs[0].data());
      if (route.type === "root") renderRoute();
    },
    logBackgroundError,
  );

  onSnapshot(
    query(
      collection(db, "polls"),
      where("createdBy", "==", uid),
      orderBy("createdAt", "desc"),
      limit(1),
    ),
    (snap) => {
      myPoll = snap.empty ? null : toPoll(snap.docs[0].id, snap.docs[0].data());
      if (route.type === "root") renderRoute();
    },
    logBackgroundError,
  );

  renderRoute();
}

/** @param {unknown} err */
function logBackgroundError(err) {
  console.error("background listener error:", err);
}

function renderRoute() {
  routeUnsubs.forEach((unsub) => unsub());
  routeUnsubs = [];

  if (route.type === "create") {
    renderCreateForm();
  } else if (route.type === "history") {
    renderHistory();
  } else if (route.type === "poll") {
    renderPollRoute(route.pollId, route.admin);
  } else if (route.type === "notfound") {
    renderNotFound();
  } else {
    renderRoot();
  }
}

function renderRoot() {
  // activePoll can reflect a poll I just created before the separate
  // "myPoll" (createdBy) listener catches up - check createdBy first so
  // that window is never misread as "go show me the voting form".
  const activeIsMine = activePoll && activePoll.createdBy === uid;

  if (activeIsMine) {
    navigate(`/poll/${activePoll.id}/admin`, { replace: true });
  } else if (activePoll) {
    navigate(`/poll/${activePoll.id}`, { replace: true });
  } else if (myPoll) {
    navigate(`/poll/${myPoll.id}/admin`, { replace: true });
  } else {
    renderCreateForm();
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
      if (admin && poll.createdBy === uid) {
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

function topNavHtml() {
  return `<p class="muted" style="text-align:right;margin-top:-8px"><a href="/history" data-link id="history-link">過去の投票一覧</a></p>`;
}

// ---- Create poll ----

function renderCreateForm() {
  // Staged by "コピーして新規作成" in the history list - a one-shot prefill,
  // consumed here so a later blank visit to /new doesn't reuse it.
  const prefill = copySource;
  copySource = null;

  /** @type {{ text: string, description: string, imageUrl: string }[]} */
  const optionValues = prefill
    ? prefill.options.map((o) => ({
        text: o.text || "",
        description: o.description || "",
        imageUrl: o.imageUrl || "",
      }))
    : [
        { text: "", description: "", imageUrl: "" },
        { text: "", description: "", imageUrl: "" },
      ];

  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    <div class="card">
      <h2>新しい投票を作成</h2>
      <label class="muted" for="question">質問</label>
      <input id="question" type="text" class="full-width" placeholder="例: 好きな○○は？" value="${prefill ? escapeHtml(prefill.question) : ""}" />
      <div id="options" style="margin-top:12px"></div>
      <div class="option-add-row">
        <button type="button" id="add-option" class="secondary">+ 選択肢を追加</button>
      </div>
      <p class="error" id="form-error"></p>
      <button id="create-poll" class="full-width">投票を開始する</button>
    </div>
  `;

  const optionsEl = /** @type {HTMLElement} */ (document.getElementById("options"));
  const errorEl = /** @type {HTMLElement} */ (document.getElementById("form-error"));

  function drawOptions() {
    optionsEl.innerHTML = optionValues
      .map(
        (value, i) => `
          <div class="option-editor">
            <div class="option-editor-header">
              <strong>選択肢 ${i + 1}</strong>
              ${optionValues.length > 2 ? `<button type="button" class="remove-btn" data-remove="${i}">✕ 削除</button>` : ""}
            </div>
            <input type="text" data-field="text" data-index="${i}" value="${escapeHtml(value.text)}" placeholder="選択肢のテキスト" />
            <input type="text" data-field="description" data-index="${i}" value="${escapeHtml(value.description)}" placeholder="説明（任意）" />
            <input type="url" data-field="imageUrl" data-index="${i}" value="${escapeHtml(value.imageUrl)}" placeholder="画像URL（任意・https://...）" />
            ${value.imageUrl ? `<img class="option-image-preview" src="${escapeHtml(value.imageUrl)}" alt="" onerror="this.style.display='none'" />` : ""}
          </div>
        `,
      )
      .join("");

    optionsEl.querySelectorAll("input[data-field]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const i = Number(target.dataset.index);
        const field = /** @type {"text" | "description" | "imageUrl"} */ (target.dataset.field);
        optionValues[i][field] = target.value;
        if (field === "imageUrl") drawOptions();
      });
    });
    optionsEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        optionValues.splice(Number(/** @type {HTMLElement} */ (btn).dataset.remove), 1);
        drawOptions();
      });
    });
  }

  drawOptions();

  document.getElementById("add-option").addEventListener("click", () => {
    optionValues.push({ text: "", description: "", imageUrl: "" });
    drawOptions();
  });

  document.getElementById("create-poll").addEventListener("click", async (e) => {
    const button = /** @type {HTMLButtonElement} */ (e.target);
    errorEl.textContent = "";
    const question = /** @type {HTMLInputElement} */ (document.getElementById("question")).value.trim();
    const options = optionValues
      .map((o) => ({
        text: o.text.trim(),
        description: o.description.trim(),
        imageUrl: o.imageUrl.trim(),
      }))
      .filter((o) => o.text.length > 0);

    if (!question) {
      errorEl.textContent = "質問を入力してください。";
      return;
    }
    if (options.length < 2) {
      errorEl.textContent = "選択肢は2つ以上入力してください。";
      return;
    }
    const invalidImage = options.find((o) => o.imageUrl && !isHttpUrl(o.imageUrl));
    if (invalidImage) {
      errorEl.textContent = `画像URLは http:// か https:// で始めてください（選択肢: ${invalidImage.text}）。`;
      return;
    }

    button.disabled = true;
    try {
      await createPoll(question, options);
    } catch (err) {
      console.error(err);
      errorEl.textContent = "作成に失敗しました: " + errorMessage(err);
      button.disabled = false;
    }
  });
}

/**
 * @param {string} question
 * @param {{ text: string, description: string, imageUrl: string }[]} optionInputs
 */
async function createPoll(question, optionInputs) {
  const optionIds = optionInputs.map((_, i) => String(i));
  /** @type {PollOption[]} */
  const options = optionInputs.map((o, i) => {
    /** @type {PollOption} */
    const option = { id: optionIds[i], text: o.text };
    if (o.description) option.description = o.description;
    if (o.imageUrl) option.imageUrl = o.imageUrl;
    return option;
  });

  const pollRef = await addDoc(collection(db, "polls"), {
    question,
    options,
    optionIds,
    isActive: true,
    createdAt: serverTimestamp(),
    createdBy: uid,
  });

  navigate(`/poll/${pollRef.id}/admin`);
}

// ---- Vote ----

/**
 * @param {Poll} poll
 * @returns {Unsubscribe}
 */
function renderVoter(poll) {
  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    <div class="card">
      <p class="question">${escapeHtml(poll.question)}</p>
      ${
        poll.isActive
          ? `<div id="options"></div>
             <p class="error" id="vote-error"></p>
             <button id="vote-btn" class="full-width" disabled>投票する</button>`
          : ""
      }
      <p class="muted" id="status"></p>
      ${poll.isActive ? "" : `<a href="/new" data-link id="start-new-poll" class="button-link secondary full-width">新しい投票を作成する</a>`}
    </div>
  `;

  const optionsEl = /** @type {HTMLElement} */ (document.getElementById("options"));
  const voteBtn = /** @type {HTMLButtonElement} */ (document.getElementById("vote-btn"));
  const errorEl = /** @type {HTMLElement} */ (document.getElementById("vote-error"));
  const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));

  /** @type {string | null} */
  let selected = null;

  if (poll.isActive) {
    optionsEl.innerHTML = poll.options.map((opt) => optionRowHtml(opt)).join("");

    optionsEl.querySelectorAll('input[name="option"]').forEach((input) => {
      input.addEventListener("change", (e) => {
        selected = /** @type {HTMLInputElement} */ (e.target).value;
        voteBtn.disabled = false;
      });
    });
  } else {
    statusEl.textContent = "この投票は締め切られました。";
  }

  // Watching my own vote doc both shows "already voted" and confirms success.
  // uid is guaranteed set by the time any route renders - main() awaits
  // waitForUser() before the router ever runs.
  const unsub = onSnapshot(doc(db, "polls", poll.id, "votes", /** @type {string} */ (uid)), (snap) => {
    if (snap.exists()) {
      const votedOption = poll.options.find((o) => o.id === snap.data().optionId);
      if (optionsEl) optionsEl.innerHTML = "";
      if (voteBtn) voteBtn.remove();
      statusEl.textContent = `投票済みです（選択: ${votedOption ? votedOption.text : "-"}）。結果は投票の作成者のみ閲覧できます。`;
    } else if (!poll.isActive) {
      statusEl.textContent = "この投票は締め切られました。";
    }
  });

  if (poll.isActive) {
    voteBtn.addEventListener("click", async () => {
      if (!selected) return;
      voteBtn.disabled = true;
      errorEl.textContent = "";
      try {
        await castVote(poll.id, selected);
      } catch (err) {
        console.error(err);
        errorEl.textContent = "投票に失敗しました: " + errorMessage(err);
        voteBtn.disabled = false;
      }
    });
  }

  return unsub;
}

/** @param {PollOption} opt */
function optionRowHtml(opt) {
  return `
    <label class="option-row">
      <input type="radio" name="option" value="${opt.id}" />
      ${opt.imageUrl ? `<img class="option-thumb" src="${escapeHtml(opt.imageUrl)}" alt="" onerror="this.style.display='none'" />` : ""}
      <span class="option-text-block">
        <span class="option-title">${escapeHtml(opt.text)}</span>
        ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ""}
      </span>
    </label>
  `;
}

/**
 * @param {string} pollId
 * @param {string} optionId
 */
async function castVote(pollId, optionId) {
  const voteRef = doc(db, "polls", pollId, "votes", /** @type {string} */ (uid));

  // A friendly pre-check (reading my own vote doc is always allowed); the
  // security rules are the real enforcement - votes/{uid} can only ever be
  // created once and is immutable after, so a double-vote is rejected there
  // even if this check races.
  const existing = await getDoc(voteRef);
  if (existing.exists()) {
    throw new Error("すでに投票済みです。");
  }
  await setDoc(voteRef, { optionId, votedAt: serverTimestamp() });
}

// ---- Admin (poll creator) ----

/**
 * @param {Poll} poll
 * @returns {Unsubscribe}
 */
function renderAdmin(poll) {
  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    <div class="card">
      <p class="question">${escapeHtml(poll.question)}</p>
      <p class="muted">${poll.isActive ? "投票受付中です。" : "この投票は締め切り済みです。"}</p>
      <div id="results"></div>
      ${
        poll.isActive
          ? `<button id="close-poll" class="full-width danger">投票を締め切る</button>`
          : `<a href="/new" data-link id="new-poll" class="button-link full-width">新しい投票を作成する</a>`
      }
      <p class="error" id="admin-error"></p>
    </div>
  `;

  const resultsEl = /** @type {HTMLElement} */ (document.getElementById("results"));
  const errorEl = /** @type {HTMLElement} */ (document.getElementById("admin-error"));

  // Tallies are derived live from the votes subcollection (readable only by
  // the creator) rather than a separately-writable counter - there's then
  // nothing a voter could write directly to inflate a count.
  const unsub = onSnapshot(collection(db, "polls", poll.id, "votes"), (snap) => {
    /** @type {Record<string, number>} */
    const counts = {};
    snap.forEach((d) => {
      const optionId = d.data().optionId;
      counts[optionId] = (counts[optionId] || 0) + 1;
    });
    renderResultsInto(resultsEl, poll, counts);
  });

  const closeBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("close-poll"));
  if (closeBtn) {
    closeBtn.addEventListener("click", async () => {
      closeBtn.disabled = true;
      try {
        await updateDoc(doc(db, "polls", poll.id), { isActive: false });
      } catch (err) {
        console.error(err);
        errorEl.textContent = "締め切りに失敗しました: " + errorMessage(err);
        closeBtn.disabled = false;
      }
    });
  }

  return unsub;
}

/**
 * @param {HTMLElement} resultsEl
 * @param {Poll} poll
 * @param {Record<string, number>} counts
 */
function renderResultsInto(resultsEl, poll, counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  resultsEl.innerHTML =
    poll.options
      .map((opt) => {
        const count = counts[opt.id] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `
          <div class="result-row">
            ${opt.imageUrl ? `<img class="option-thumb" src="${escapeHtml(opt.imageUrl)}" alt="" onerror="this.style.display='none'" />` : ""}
            <span class="result-label">
              <span class="option-title">${escapeHtml(opt.text)}</span>
              ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ""}
            </span>
            <span class="result-bar-track"><span class="result-bar-fill" style="width:${pct}%"></span></span>
            <span class="result-count">${count}票</span>
          </div>
        `;
      })
      .join("") + `<p class="muted">合計 ${total} 票</p>`;
}

// ---- History (past polls I created) ----

function renderHistory() {
  appEl.innerHTML = `
    <h1>投票システム</h1>
    <div class="card">
      <h2>過去に作成した投票</h2>
      <p class="muted"><a href="/" data-link id="back-link">← 戻る</a></p>
      <div id="history-list"><p class="muted">読み込み中…</p></div>
    </div>
  `;

  const listEl = /** @type {HTMLElement} */ (document.getElementById("history-list"));

  const unsub = onSnapshot(
    query(
      collection(db, "polls"),
      where("createdBy", "==", uid),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
    (snap) => {
      if (snap.empty) {
        listEl.innerHTML = `<p class="muted">まだ投票を作成したことがありません。</p>`;
        return;
      }

      const polls = snap.docs.map((d) => toPoll(d.id, d.data()));

      listEl.innerHTML = polls
        .map(
          (poll, i) => `
            <div class="history-row">
              <a href="/poll/${poll.id}/admin" data-link class="history-item">
                <span class="history-item-question">${escapeHtml(poll.question)}</span><br>
                <span class="muted">${poll.isActive ? "投票受付中" : "締め切り済み"} ・ ${formatDate(poll.createdAt)}</span>
              </a>
              <button type="button" class="secondary copy-btn" data-copy-index="${i}">コピーして新規作成</button>
            </div>
          `,
        )
        .join("");

      listEl.querySelectorAll(".copy-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const poll = polls[Number(/** @type {HTMLElement} */ (btn).dataset.copyIndex)];
          copySource = { question: poll.question, options: poll.options };
          navigate("/new");
        });
      });
    },
    showError,
  );

  routeUnsubs.push(unsub);
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

// ---- Utilities ----

/** @param {string} value */
function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

/** @param {import("firebase/firestore").Timestamp | undefined} timestamp */
function formatDate(timestamp) {
  if (!timestamp?.toDate) return "";
  return timestamp.toDate().toLocaleString("ja-JP");
}

/** @param {unknown} str */
function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[/** @type {"&"|"<"|">"|"\""|"'"} */ (c)],
  );
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {unknown} err */
function showError(err) {
  console.error(err);
  appEl.innerHTML = `<p class="error">エラーが発生しました: ${escapeHtml(errorMessage(err))}</p>`;
}

main().catch(showError);
