import { db } from "../firebase.js";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { navigate } from "../app.js";
import { state } from "../state.js";
import { appEl, topNavHtml, escapeHtml, isHttpUrl, errorMessage } from "../shared.js";
import { emptyOptionInput, buildPollOptions, mountOptionEditor } from "./option-editor.js";

/** @import { OptionInput } from "./option-editor.js" */

export function renderCreateForm() {
  // Staged by "コピーして新規作成" in the history list - a one-shot prefill,
  // consumed here so a later blank visit to /new doesn't reuse it.
  const prefill = state.copySource;
  state.copySource = null;

  /** @type {OptionInput[]} */
  const optionValues = prefill
    ? prefill.options.map((o) => ({
        text: o.text || "",
        description: o.description || "",
        imageUrl: o.imageUrl || "",
      }))
    : [emptyOptionInput(), emptyOptionInput()];

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
      <div class="option-add-row">
        <button type="button" id="save-draft" class="secondary full-width">一時保存する</button>
        <button id="create-poll" class="full-width">投票を開始する</button>
      </div>
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
      await saveDraft(question, options);
    } catch (err) {
      console.error(err);
      errorEl.textContent = "一時保存に失敗しました: " + errorMessage(err);
      button.disabled = false;
    }
  });

  document.getElementById("create-poll").addEventListener("click", async (e) => {
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
      await createPoll(question, options);
    } catch (err) {
      console.error(err);
      errorEl.textContent = "作成に失敗しました: " + errorMessage(err);
      button.disabled = false;
    }
  });
}

/**
 * A recovery secret for reclaiming admin access from another browser/
 * device later, revealed on demand from the admin/draft-editor views (see
 * firestore.rules, polls/{pollId}/private/recovery, and
 * functions/index.js's recoverAdmin). Written once, as soon as the poll
 * first exists - whether as a draft or published directly - as a second,
 * separate call after the poll doc exists, since the rules for this doc
 * need to read the poll's own createdBy to confirm it's really the same
 * creator.
 *
 * @param {string} pollId
 */
async function createRecoverySecret(pollId) {
  await setDoc(doc(db, "polls", pollId, "private", "recovery"), { secret: crypto.randomUUID() });
}

/**
 * @param {string} question
 * @param {OptionInput[]} optionInputs
 */
async function saveDraft(question, optionInputs) {
  const options = buildPollOptions(optionInputs);

  const pollRef = await addDoc(collection(db, "polls"), {
    question,
    options,
    optionIds: options.map((o) => o.id),
    isActive: false,
    isDraft: true,
    createdAt: serverTimestamp(),
    createdBy: state.uid,
  });

  await createRecoverySecret(pollRef.id);

  navigate(`/poll/${pollRef.id}/admin`);
}

/**
 * @param {string} question
 * @param {OptionInput[]} optionInputs
 */
async function createPoll(question, optionInputs) {
  const options = buildPollOptions(optionInputs);

  const pollRef = await addDoc(collection(db, "polls"), {
    question,
    options,
    optionIds: options.map((o) => o.id),
    isActive: true,
    isDraft: false,
    createdAt: serverTimestamp(),
    createdBy: state.uid,
  });

  await createRecoverySecret(pollRef.id);

  navigate(`/poll/${pollRef.id}/admin`);
}
