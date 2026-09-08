import { db } from "../firebase.js";
import {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { navigate } from "../app.js";
import { appEl, topNavHtml, escapeHtml, isHttpUrl, errorMessage } from "../shared.js";
import { emptyOptionInput, buildPollOptions, mountOptionEditor } from "./option-editor.js";

/** @import { Poll } from "../shared.js" */
/** @import { OptionInput } from "./option-editor.js" */

/** @param {Poll} poll */
export function renderDraftEditor(poll) {
  /** @type {OptionInput[]} */
  const optionValues = poll.options.length
    ? poll.options.map((o) => ({
        text: o.text || "",
        description: o.description || "",
        imageUrl: o.imageUrl || "",
      }))
    : [emptyOptionInput(), emptyOptionInput()];

  appEl.innerHTML = `
    <h1>投票システム</h1>
    ${topNavHtml()}
    <div class="card">
      <h2>下書きを編集</h2>
      <p class="muted">まだ公開されていません。公開すると質問・選択肢は変更できなくなります。</p>
      <label class="muted" for="question">質問</label>
      <input id="question" type="text" class="full-width" placeholder="例: 好きな○○は？" value="${escapeHtml(poll.question)}" />
      <div id="options" style="margin-top:12px"></div>
      <div class="option-add-row">
        <button type="button" id="add-option" class="secondary">+ 選択肢を追加</button>
      </div>
      <p class="error" id="form-error"></p>
      <div class="option-add-row">
        <button type="button" id="delete-draft" class="secondary">下書きを削除</button>
        <button type="button" id="save-draft" class="secondary full-width">一時保存する</button>
      </div>
      <button type="button" id="publish-poll" class="full-width" style="margin-top:8px">投票を開始する</button>
    </div>
  `;

  const optionsEl = /** @type {HTMLElement} */ (document.getElementById("options"));
  const errorEl = /** @type {HTMLElement} */ (document.getElementById("form-error"));
  const editor = mountOptionEditor(optionsEl, optionValues);

  document.getElementById("add-option").addEventListener("click", () => {
    optionValues.push(emptyOptionInput());
    editor.redraw();
  });

  function readForm() {
    const question = /** @type {HTMLInputElement} */ (document.getElementById("question")).value.trim();
    const options = optionValues
      .map((o) => ({
        text: o.text.trim(),
        description: o.description.trim(),
        imageUrl: o.imageUrl.trim(),
      }))
      .filter((o) => o.text.length > 0);
    return { question, options };
  }

  /**
   * @param {OptionInput[]} options
   * @returns {string | null}
   */
  function findImageError(options) {
    const invalidImage = options.find((o) => o.imageUrl && !isHttpUrl(o.imageUrl));
    return invalidImage
      ? `画像URLは http:// か https:// で始めてください（選択肢: ${invalidImage.text}）。`
      : null;
  }

  document.getElementById("save-draft").addEventListener("click", async (e) => {
    const button = /** @type {HTMLButtonElement} */ (e.target);
    errorEl.textContent = "";
    const { question, options } = readForm();
    const imageError = findImageError(options);
    if (imageError) {
      errorEl.textContent = imageError;
      return;
    }

    button.disabled = true;
    try {
      const builtOptions = buildPollOptions(options);
      await updateDoc(doc(db, "polls", poll.id), {
        question,
        options: builtOptions,
        optionIds: builtOptions.map((o) => o.id),
      });
    } catch (err) {
      console.error(err);
      errorEl.textContent = "一時保存に失敗しました: " + errorMessage(err);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("publish-poll").addEventListener("click", async (e) => {
    const button = /** @type {HTMLButtonElement} */ (e.target);
    errorEl.textContent = "";
    const { question, options } = readForm();

    if (!question) {
      errorEl.textContent = "質問を入力してください。";
      return;
    }
    if (options.length < 2) {
      errorEl.textContent = "選択肢は2つ以上入力してください。";
      return;
    }
    const imageError = findImageError(options);
    if (imageError) {
      errorEl.textContent = imageError;
      return;
    }

    button.disabled = true;
    try {
      const builtOptions = buildPollOptions(options);
      await updateDoc(doc(db, "polls", poll.id), {
        question,
        options: builtOptions,
        optionIds: builtOptions.map((o) => o.id),
        isDraft: false,
        isActive: true,
      });

      // A one-time secret for reclaiming admin access from another browser/
      // device later - see firestore.rules (private/recovery) and
      // functions/index.js's recoverAdmin. Only written now, at the moment
      // of publishing, since a not-yet-public draft isn't at risk the same
      // way a live poll is.
      const secret = crypto.randomUUID();
      await setDoc(doc(db, "polls", poll.id, "private", "recovery"), { secret });

      navigate(`/poll/${poll.id}/admin?recover=${secret}`);
    } catch (err) {
      console.error(err);
      errorEl.textContent = "公開に失敗しました: " + errorMessage(err);
      button.disabled = false;
    }
  });

  document.getElementById("delete-draft").addEventListener("click", async () => {
    if (!confirm("この下書きを削除しますか？")) return;
    try {
      await deleteDoc(doc(db, "polls", poll.id));
      navigate("/history");
    } catch (err) {
      console.error(err);
      errorEl.textContent = "削除に失敗しました: " + errorMessage(err);
    }
  });
}
