import { db } from "../firebase.js";
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { appEl, topNavHtml, escapeHtml, errorMessage } from "../shared.js";

/** @import { Poll } from "../shared.js" */
/** @import { Unsubscribe } from "firebase/firestore" */

/**
 * @param {Poll} poll
 * @param {string | null} [recoverToken]
 * @returns {Unsubscribe}
 */
export function renderAdmin(poll, recoverToken) {
  const recoveryUrl = recoverToken ? `${location.origin}/poll/${poll.id}/admin?recover=${recoverToken}` : "";

  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    ${
      recoverToken
        ? `<div class="card" style="border:2px solid #2563eb">
             <h2>管理用の復旧リンク</h2>
             <p class="muted">
               他の端末やブラウザ、またはこのブラウザのデータが消えた場合に備えて、このリンクを
               保存してください。このリンクを知っている人は誰でもこの投票の管理者になれるので、
               他人に共有しないでください。
             </p>
             <input type="text" class="full-width" readonly value="${escapeHtml(recoveryUrl)}" id="recovery-url" />
             <button type="button" id="copy-recovery-url" class="secondary full-width" style="margin-top:8px">リンクをコピー</button>
             <p class="muted" id="copy-status"></p>
           </div>`
        : ""
    }
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

  if (recoverToken) {
    document.getElementById("copy-recovery-url").addEventListener("click", async () => {
      const status = /** @type {HTMLElement} */ (document.getElementById("copy-status"));
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        status.textContent = "コピーしました。";
      } catch {
        status.textContent = "コピーに失敗しました。上の欄から手動でコピーしてください。";
      }
    });
  }

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
