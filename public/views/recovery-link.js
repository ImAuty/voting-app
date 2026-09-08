import { db } from "../firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { renderCopyableLink, errorMessage } from "../shared.js";

/**
 * Mounts a "show admin recovery link" button into `container` for the
 * given poll. Clicking it fetches the poll's recovery secret (readable
 * only by its current creator - see firestore.rules) and reveals a
 * copyable /admin?recover= link, rather than showing it unconditionally on
 * every visit - it's effectively a spare key to the poll, so minimizing
 * how often it sits on-screen is worth the one extra click. Shared by the
 * published-poll admin view and the draft editor, since either can lose
 * its creator's session the same way.
 *
 * @param {HTMLElement} container
 * @param {string} pollId
 */
export function mountRecoveryLinkReveal(container, pollId) {
  container.innerHTML = `
    <button type="button" class="secondary full-width">管理用の復旧リンクを表示する</button>
    <p class="error"></p>
    <div style="margin-top:8px"></div>
  `;

  const button = /** @type {HTMLButtonElement} */ (container.querySelector("button"));
  const errorEl = /** @type {HTMLElement} */ (container.querySelector(".error"));
  const linkEl = /** @type {HTMLElement} */ (container.querySelector("div"));

  button.addEventListener("click", async () => {
    button.disabled = true;
    errorEl.textContent = "";
    try {
      const snap = await getDoc(doc(db, "polls", pollId, "private", "recovery"));
      const secret = snap.exists() ? snap.data().secret : null;
      if (!secret) throw new Error("復旧リンクが見つかりませんでした。");
      renderCopyableLink(linkEl, `${location.origin}/poll/${pollId}/admin?recover=${secret}`);
      button.remove();
    } catch (err) {
      console.error(err);
      errorEl.textContent = "取得に失敗しました: " + errorMessage(err);
      button.disabled = false;
    }
  });
}
