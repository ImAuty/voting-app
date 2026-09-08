import { db, storage } from "../firebase.js";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { navigate } from "../app.js";
import { state } from "../state.js";
import { appEl, topNavHtml, escapeHtml, isHttpUrl, errorMessage } from "../shared.js";

/** @import { PollOption } from "../shared.js" */

// Must match storage.rules' size limit for option-images/ - checked here
// too so an oversized file is rejected immediately instead of after a
// failed round-trip to Storage.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function renderCreateForm() {
  // Staged by "コピーして新規作成" in the history list - a one-shot prefill,
  // consumed here so a later blank visit to /new doesn't reuse it.
  const prefill = state.copySource;
  state.copySource = null;

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
            <input type="file" accept="image/*" data-upload-index="${i}" style="margin-top:4px" />
            <span class="muted" data-upload-status="${i}"></span>
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
    optionsEl.querySelectorAll("input[data-upload-index]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const i = Number(target.dataset.uploadIndex);
        const file = target.files && target.files[0];
        if (file) uploadOptionImage(i, file);
      });
    });
  }

  /**
   * @param {number} i
   * @param {File} file
   */
  async function uploadOptionImage(i, file) {
    const statusEl = optionsEl.querySelector(`[data-upload-status="${i}"]`);
    if (!file.type.startsWith("image/")) {
      if (statusEl) statusEl.textContent = "画像ファイルを選択してください。";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      if (statusEl) statusEl.textContent = "5MB以下の画像を選択してください。";
      return;
    }

    if (statusEl) statusEl.textContent = "アップロード中…";
    try {
      const imageRef = ref(storage, `option-images/${state.uid}/${crypto.randomUUID()}`);
      await uploadBytes(imageRef, file, { contentType: file.type });
      optionValues[i].imageUrl = await getDownloadURL(imageRef);
      drawOptions();
    } catch (err) {
      console.error(err);
      if (statusEl) statusEl.textContent = "アップロードに失敗しました: " + errorMessage(err);
    }
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
    createdBy: state.uid,
  });

  // A one-time secret for reclaiming admin access from another browser/
  // device later (see firestore.rules, polls/{pollId}/private/recovery, and
  // functions/index.js's recoverAdmin). Written as a second, separate call
  // after the poll doc exists, since the rules for this doc need to read
  // the poll's own createdBy to confirm it's really the same creator.
  const secret = crypto.randomUUID();
  await setDoc(doc(db, "polls", pollRef.id, "private", "recovery"), { secret });

  navigate(`/poll/${pollRef.id}/admin?recover=${secret}`);
}
