import { storage } from "../firebase.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { state } from "../state.js";
import { escapeHtml, errorMessage } from "../shared.js";

/** @import { PollOption } from "../shared.js" */

/**
 * @typedef {{ text: string, description: string, imageUrl: string }} OptionInput
 */

// Must match storage.rules' size limit for option-images/ - checked here
// too so an oversized file is rejected immediately instead of after a
// failed round-trip to Storage.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Must match firestore.rules' options.size() cap - checked here too so
// hitting the limit shows a friendly message instead of a failed write.
export const MAX_OPTIONS = 50;

/** @returns {OptionInput} */
export function emptyOptionInput() {
  return { text: "", description: "", imageUrl: "" };
}

/**
 * Turns the raw option inputs from an editor into the shape stored on a
 * poll doc, assigning each a stable sequential id.
 *
 * @param {OptionInput[]} optionInputs
 * @returns {PollOption[]}
 */
export function buildPollOptions(optionInputs) {
  return optionInputs.map((o, i) => {
    /** @type {PollOption} */
    const option = { id: String(i), text: o.text };
    if (o.description) option.description = o.description;
    if (o.imageUrl) option.imageUrl = o.imageUrl;
    return option;
  });
}

/**
 * Mounts the dynamic option-editor rows (text/description/image URL/file
 * upload, per-row remove button) into `container`, backed by `optionValues`
 * (mutated in place as the user types or uploads an image). Shared by the
 * create form and the draft editor, which differ only in what happens to
 * the resulting values afterwards (create-and-publish, save-as-draft, or
 * publish-a-draft).
 *
 * @param {HTMLElement} container
 * @param {OptionInput[]} optionValues
 * @param {{ onChange?: () => void }} [options]
 * @returns {{ redraw: () => void }}
 */
export function mountOptionEditor(container, optionValues, { onChange } = {}) {
  function redraw() {
    container.innerHTML = optionValues
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

    container.querySelectorAll("input[data-field]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const i = Number(target.dataset.index);
        const field = /** @type {"text" | "description" | "imageUrl"} */ (target.dataset.field);
        optionValues[i][field] = target.value;
        if (field === "imageUrl") redraw();
      });
    });
    container.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        optionValues.splice(Number(/** @type {HTMLElement} */ (btn).dataset.remove), 1);
        redraw();
      });
    });
    container.querySelectorAll("input[data-upload-index]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const i = Number(target.dataset.uploadIndex);
        const file = target.files && target.files[0];
        if (file) uploadOptionImage(i, file);
      });
    });

    if (onChange) onChange();
  }

  /**
   * @param {number} i
   * @param {File} file
   */
  async function uploadOptionImage(i, file) {
    const statusEl = container.querySelector(`[data-upload-status="${i}"]`);
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
      redraw();
    } catch (err) {
      console.error(err);
      if (statusEl) statusEl.textContent = "アップロードに失敗しました: " + errorMessage(err);
    }
  }

  redraw();
  return { redraw };
}
