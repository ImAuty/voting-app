import { db } from "../firebase.js";
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { state } from "../state.js";
import { appEl, toPoll, topNavHtml, escapeHtml, showError } from "../shared.js";

/** @import { Unsubscribe } from "firebase/firestore" */

/** @returns {Unsubscribe} */
export function renderRootList() {
  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    <div class="card">
      <h2>現在進行中の投票</h2>
      <a href="/new" data-link class="button-link full-width">+ 新しい投票を作成する</a>
      <div id="root-list" style="margin-top:16px"><p class="muted">読み込み中…</p></div>
    </div>
  `;

  const listEl = /** @type {HTMLElement} */ (document.getElementById("root-list"));

  // Live: a poll appearing or disappearing here (someone starts or closes
  // one) updates this list for everyone looking at "/" without a reload.
  return onSnapshot(
    query(
      collection(db, "polls"),
      where("isActive", "==", true),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
    (snap) => {
      if (snap.empty) {
        listEl.innerHTML = `<p class="muted">現在進行中の投票はありません。</p>`;
        return;
      }

      const polls = snap.docs.map((d) => toPoll(d.id, d.data()));

      listEl.innerHTML = polls
        .map((poll) => {
          const isMine = poll.createdBy === state.uid;
          const href = isMine ? `/poll/${poll.id}/admin` : `/poll/${poll.id}`;
          return `
            <a href="${href}" data-link class="history-item">
              <span class="history-item-question">${escapeHtml(poll.question)}</span><br>
              <span class="muted">${isMine ? "あなたが作成した投票です（結果を見る）" : "投票を受け付けています"}</span>
            </a>
          `;
        })
        .join("");
    },
    showError,
  );
}
