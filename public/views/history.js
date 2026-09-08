import { db } from "../firebase.js";
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { navigate } from "../app.js";
import { state } from "../state.js";
import { appEl, toPoll, escapeHtml, formatDate, showError } from "../shared.js";

/** @import { Unsubscribe } from "firebase/firestore" */

/** @returns {Unsubscribe} */
export function renderHistory() {
  appEl.innerHTML = `
    <h1>投票システム</h1>
    <div class="card">
      <h2>過去に作成した投票</h2>
      <p class="muted"><a href="/" data-link id="back-link">← 戻る</a></p>
      <div id="history-list"><p class="muted">読み込み中…</p></div>
    </div>
  `;

  const listEl = /** @type {HTMLElement} */ (document.getElementById("history-list"));

  return onSnapshot(
    query(
      collection(db, "polls"),
      where("createdBy", "==", state.uid),
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
          state.copySource = { question: poll.question, options: poll.options };
          navigate("/new");
        });
      });
    },
    showError,
  );
}
