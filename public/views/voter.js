import { db, functions } from "../firebase.js";
import {
  doc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";
import { state } from "../state.js";
import { appEl, topNavHtml, escapeHtml, errorMessage } from "../shared.js";

/** @import { Poll, PollOption } from "../shared.js" */
/** @import { Unsubscribe } from "firebase/firestore" */

/**
 * @param {Poll} poll
 * @returns {Unsubscribe}
 */
export function renderVoter(poll) {
  // Set by app.js right before landing here after a failed /admin?recover=
  // attempt (wrong or already-used token) - shown once, then cleared.
  const recoveryError = state.recoveryError;
  state.recoveryError = null;

  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    ${recoveryError ? `<p class="error">復旧に失敗しました: ${escapeHtml(recoveryError)}</p>` : ""}
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
  const unsub = onSnapshot(doc(db, "polls", poll.id, "votes", /** @type {string} */ (state.uid)), (snap) => {
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
  const voteRef = doc(db, "polls", pollId, "votes", /** @type {string} */ (state.uid));

  // A friendly pre-check (reading my own vote doc is always allowed) so an
  // obvious repeat click doesn't even round-trip to the function. The real
  // enforcement is the castVote Cloud Function itself, which also rejects a
  // second vote from the same IP address - something a direct Firestore
  // write (and these rules) can't see at all. See functions/index.js.
  const existing = await getDoc(voteRef);
  if (existing.exists()) {
    throw new Error("すでに投票済みです。");
  }
  await httpsCallable(functions, "castVote")({ pollId, optionId });
}
