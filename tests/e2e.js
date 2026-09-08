// End-to-end smoke test for the voting app, driven with Playwright against
// the Firebase emulators (auth + firestore + hosting).
//
// Run via `npm run test:e2e` — that wraps this script in
// `firebase emulators:exec`, which starts the emulators with a clean
// in-memory Firestore, runs this script, then tears them down.
//
// Requires Chromium to be installed once: `npx playwright install chromium`
// (add `--with-deps` if the OS is missing shared libs it needs, e.g. NSS).

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:5000";
const ARTIFACTS_DIR = path.join(__dirname, ".artifacts");
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function screenshotPath(name) {
  return path.join(ARTIFACTS_DIR, `${name}.png`);
}

async function waitForText(page, text, timeout = 10000) {
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    text,
    { timeout },
  );
}

async function waitForTextGone(page, text, timeout = 10000) {
  await page.waitForFunction(
    (t) => !document.body.innerText.includes(t),
    text,
    { timeout },
  );
}

// A tiny static server for a real, always-loadable test image (the option
// image feature needs a URL that actually resolves - the sandbox this was
// developed in has no outbound internet access, so a public image host
// won't do, and the option-thumb's onerror hides broken images anyway).
function serveFixtures() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(FIXTURES_DIR, path.basename(req.url));
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const fixturesServer = await serveFixtures();
  const fixturesPort = fixturesServer.address().port;
  const mikanImageUrl = `http://127.0.0.1:${fixturesPort}/pixel.png`;

  const browser = await chromium.launch();
  const adminCtx = await browser.newContext();
  const voterCtx = await browser.newContext();
  const bystanderCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const voter = await voterCtx.newPage();
  const bystander = await bystanderCtx.newPage();

  for (const [name, page] of [["admin", admin], ["voter", voter], ["bystander", bystander]]) {
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[${name} console error]`, m.text());
    });
    page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  }

  console.log("== Step 1: admin opens app, sees the (empty) root list, and follows the create link ==");
  await admin.goto(BASE);
  await waitForText(admin, "現在進行中の投票はありません");
  await admin.screenshot({ path: screenshotPath("1-admin-root-empty") });
  await admin.click("text=+ 新しい投票を作成する");
  await admin.waitForSelector("#question"); // unambiguous marker of the create form
  await admin.screenshot({ path: screenshotPath("1b-admin-create-form") });

  console.log("== Step 2: admin fills form (with a description + image URL) and creates a poll ==");
  await admin.fill("#question", "好きな果物は？");
  const optionEditors = admin.locator(".option-editor");
  await optionEditors.nth(0).locator('input[data-field="text"]').fill("りんご");
  await optionEditors.nth(0).locator('input[data-field="description"]').fill("国産の甘い品種");
  await optionEditors.nth(1).locator('input[data-field="text"]').fill("みかん");
  await optionEditors.nth(1).locator('input[data-field="imageUrl"]').fill(mikanImageUrl);
  await admin.click("#add-option");
  await admin.locator(".option-editor").nth(2).locator('input[data-field="text"]').fill("ぶどう");
  await admin.click("#create-poll");
  await waitForText(admin, "投票受付中");
  await admin.screenshot({ path: screenshotPath("2-admin-active-results") });

  console.log("== Step 2b: the URL updated to /poll/{id}/admin ==");
  const adminUrl = new URL(admin.url());
  const adminMatch = adminUrl.pathname.match(/^\/poll\/([^/]+)\/admin$/);
  if (!adminMatch) throw new Error(`expected admin URL to be /poll/{id}/admin, got ${adminUrl.pathname}`);
  const fruitPollId = adminMatch[1];

  console.log("== Step 2c: someone who isn't the creator visiting the admin URL falls back to the voting view ==");
  const strangerCtx = await browser.newContext();
  const stranger = await strangerCtx.newPage();
  await stranger.goto(`${BASE}/poll/${fruitPollId}/admin`);
  await stranger.waitForSelector("#vote-btn");
  const strangerHasCloseBtn = await stranger.locator("#close-poll").count();
  if (strangerHasCloseBtn !== 0) throw new Error("a non-creator should not see admin controls via the admin URL");
  await strangerCtx.close();

  console.log("== Step 2d: the root list shows every currently-active poll, from any creator, live ==");
  const watcherCtx = await browser.newContext();
  const watcher = await watcherCtx.newPage();
  await watcher.goto(BASE);
  await waitForText(watcher, "好きな果物は？");

  const admin2Ctx = await browser.newContext();
  const admin2 = await admin2Ctx.newPage();
  await admin2.goto(`${BASE}/new`); // a second, unrelated creator - fruit poll stays active the whole time
  await admin2.fill("#question", "好きな天気は？");
  const weatherEditors = admin2.locator(".option-editor");
  await weatherEditors.nth(0).locator('input[data-field="text"]').fill("晴れ");
  await weatherEditors.nth(1).locator('input[data-field="text"]').fill("雨");
  await admin2.click("#create-poll");
  await waitForText(admin2, "投票受付中");

  await waitForText(watcher, "好きな天気は？"); // both polls listed at once, no reload
  await waitForText(watcher, "好きな果物は？");
  await watcher.screenshot({ path: screenshotPath("2d-root-multiple-active") });

  await admin2.click("#close-poll");
  await waitForText(admin2, "締め切り済み");
  await waitForTextGone(watcher, "好きな天気は？"); // drops out of the list live once closed
  await admin2Ctx.close();

  console.log("== Step 2e: admin recovery - reclaiming admin access from another browser via the recovery link ==");
  const originalCtx = await browser.newContext();
  const original = await originalCtx.newPage();
  await original.goto(`${BASE}/new`);
  await original.fill("#question", "復旧テスト用の投票");
  const recoveryPollEditors = original.locator(".option-editor");
  await recoveryPollEditors.nth(0).locator('input[data-field="text"]').fill("選択肢A");
  await recoveryPollEditors.nth(1).locator('input[data-field="text"]').fill("選択肢B");
  await original.click("#create-poll");
  await waitForText(original, "投票受付中");
  await waitForText(original, "管理用の復旧リンク");

  const recoveryUrlBefore = new URL(original.url());
  if (recoveryUrlBefore.search !== "") {
    throw new Error(`expected the ?recover= token to be stripped from the URL, got ${recoveryUrlBefore.search}`);
  }
  const recoveryUrl = await original.locator("#recovery-url").inputValue();
  if (!recoveryUrl.includes("?recover=")) {
    throw new Error(`expected the recovery banner to show a link with a recover token, got "${recoveryUrl}"`);
  }
  await original.screenshot({ path: screenshotPath("2e-recovery-link-shown") });

  const recoveredCtx = await browser.newContext();
  const recovered = await recoveredCtx.newPage();
  await recovered.goto(recoveryUrl); // a different browser context = a different anonymous uid, simulating a lost session
  await recovered.waitForSelector("#close-poll"); // now recognized as admin
  const recoveredUrl = new URL(recovered.url());
  if (recoveredUrl.search !== "") {
    throw new Error(`expected the ?recover= token to be stripped after use, got ${recoveredUrl.search}`);
  }
  await recovered.screenshot({ path: screenshotPath("2f-recovered-admin-view") });

  console.log("== Step 2g: the original session, still open, is live-demoted to the voter view ==");
  await original.waitForSelector("#vote-btn");

  await recovered.click("#close-poll");
  await waitForText(recovered, "締め切り済み");
  await recoveredCtx.close();
  await originalCtx.close();

  console.log("== Step 3: voter opens app at \"/\", clicks the fruit poll, sees the voting form ==");
  await voter.goto(BASE);
  await waitForText(voter, "好きな果物は？");
  await voter.click("text=好きな果物は？");
  const voterUrl = new URL(voter.url());
  if (voterUrl.pathname !== `/poll/${fruitPollId}`) {
    throw new Error(`expected voter to land on /poll/${fruitPollId}, got ${voterUrl.pathname}`);
  }
  await waitForText(voter, "国産の甘い品種");
  const mikanThumbSrc = await voter.locator(".option-thumb").getAttribute("src");
  if (mikanThumbSrc !== mikanImageUrl) {
    throw new Error(`expected option image src to round-trip, got ${mikanThumbSrc}`);
  }
  await voter.screenshot({ path: screenshotPath("3-voter-form") });

  console.log("== Step 3a: a made-up poll id shows the not-found page ==");
  const notFoundCtx = await browser.newContext();
  const notFoundPage = await notFoundCtx.newPage();
  await notFoundPage.goto(`${BASE}/poll/does-not-exist`);
  await waitForText(notFoundPage, "見つかりませんでした");
  await notFoundCtx.close();

  console.log("== Step 3b: clicking the option image opens a lightbox, and clicking again closes it ==");
  await voter.click(".option-thumb");
  await voter.waitForSelector(".lightbox-overlay img");
  const lightboxSrc = await voter.locator(".lightbox-overlay img").getAttribute("src");
  if (lightboxSrc !== mikanImageUrl) {
    throw new Error(`expected lightbox image src to match, got ${lightboxSrc}`);
  }
  await voter.screenshot({ path: screenshotPath("3b-voter-lightbox") });
  await voter.click(".lightbox-overlay");
  await voter.waitForSelector(".lightbox-overlay", { state: "detached" });

  console.log("== Step 4: voter votes for みかん ==");
  await voter.click('input[name="option"][value="1"]');
  await voter.click("#vote-btn");
  await waitForText(voter, "投票済み");
  await voter.screenshot({ path: screenshotPath("4-voter-voted") });

  console.log("== Step 5: admin sees the live count update ==");
  await waitForText(admin, "合計 1 票");
  await admin.screenshot({ path: screenshotPath("5-admin-live-count") });

  console.log("== Step 6: voter can no longer vote again ==");
  const voteBtnCount = await voter.locator("#vote-btn").count();
  if (voteBtnCount !== 0) throw new Error(`expected vote button to be gone, found ${voteBtnCount}`);

  console.log("== Step 6b: a bystander opens the app, clicks into the still-open poll, but does not vote ==");
  await bystander.goto(BASE);
  await waitForText(bystander, "好きな果物は？");
  await bystander.click("text=好きな果物は？");
  await waitForText(bystander, "国産の甘い品種");

  console.log("== Step 7: admin closes the poll ==");
  await admin.click("#close-poll");
  await waitForText(admin, "締め切り済み");
  await admin.screenshot({ path: screenshotPath("6-admin-closed") });
  await waitForTextGone(watcher, "好きな果物は？"); // root list drops it live too
  await waitForText(watcher, "現在進行中の投票はありません"); // nothing else active yet

  console.log("== Step 8: voter (already voted) keeps showing their vote live, no reload ==");
  await waitForText(voter, "投票済み");
  await voter.screenshot({ path: screenshotPath("7-voter-still-voted") });

  console.log("== Step 8b: bystander (never voted) sees the poll flip to closed live, no reload ==");
  await waitForText(bystander, "締め切られました");
  await bystander.screenshot({ path: screenshotPath("7b-bystander-closed-live") });

  console.log("== Step 9: admin can start a new poll ==");
  await admin.click("#new-poll");
  await admin.waitForSelector("#question");
  await admin.screenshot({ path: screenshotPath("8-admin-new-poll-form") });

  console.log("== Step 10: admin creates a second poll ==");
  await admin.fill("#question", "好きな飲み物は？");
  const drinkEditors = admin.locator(".option-editor");
  await drinkEditors.nth(0).locator('input[data-field="text"]').fill("コーヒー");
  await drinkEditors.nth(1).locator('input[data-field="text"]').fill("紅茶");
  await admin.click("#create-poll");
  await waitForText(admin, "投票受付中");
  await waitForText(watcher, "好きな飲み物は？"); // back in the root list, live
  await watcherCtx.close();

  console.log("== Step 11: history lists both polls, and the old one's results are still viewable ==");
  await admin.click("#history-link");
  await waitForText(admin, "過去に作成した投票");
  await waitForText(admin, "好きな果物は？");
  await waitForText(admin, "好きな飲み物は？");
  await admin.screenshot({ path: screenshotPath("9-admin-history-list") });

  await admin.locator(".history-item", { hasText: "好きな果物は？" }).click();
  await waitForText(admin, "合計 1 票");
  const historyDetailUrl = new URL(admin.url());
  if (historyDetailUrl.pathname !== `/poll/${fruitPollId}/admin`) {
    throw new Error(`expected history item to link to /poll/${fruitPollId}/admin, got ${historyDetailUrl.pathname}`);
  }
  await admin.screenshot({ path: screenshotPath("10-admin-history-detail") });

  console.log("== Step 13: \"copy and create new\" prefills the form from the old poll ==");
  await admin.click("#history-link");
  await waitForText(admin, "過去に作成した投票");
  await admin
    .locator(".history-row", { hasText: "好きな果物は？" })
    .locator(".copy-btn")
    .click();
  await admin.waitForSelector("#question");
  const copiedQuestion = await admin.locator("#question").inputValue();
  if (copiedQuestion !== "好きな果物は？") {
    throw new Error(`expected copied question to prefill, got "${copiedQuestion}"`);
  }
  const copiedEditors = admin.locator(".option-editor");
  const copiedTexts = await copiedEditors
    .locator('input[data-field="text"]')
    .evaluateAll((els) => els.map((el) => el.value));
  if (JSON.stringify(copiedTexts) !== JSON.stringify(["りんご", "みかん", "ぶどう"])) {
    throw new Error(`expected copied option texts to prefill, got ${JSON.stringify(copiedTexts)}`);
  }
  const copiedDescription = await copiedEditors.nth(0).locator('input[data-field="description"]').inputValue();
  if (copiedDescription !== "国産の甘い品種") {
    throw new Error(`expected copied description to prefill, got "${copiedDescription}"`);
  }
  const copiedImageUrl = await copiedEditors.nth(1).locator('input[data-field="imageUrl"]').inputValue();
  if (copiedImageUrl !== mikanImageUrl) {
    throw new Error(`expected copied image URL to prefill, got "${copiedImageUrl}"`);
  }
  await admin.screenshot({ path: screenshotPath("11-admin-copy-prefilled") });

  console.log("== Step 14: submitting the copy creates a brand-new poll with a fresh vote count ==");
  await admin.click("#create-poll");
  await waitForText(admin, "投票受付中");
  await waitForText(admin, "合計 0 票");
  const copiedPollUrl = new URL(admin.url());
  const copiedMatch = copiedPollUrl.pathname.match(/^\/poll\/([^/]+)\/admin$/);
  if (!copiedMatch || copiedMatch[1] === fruitPollId) {
    throw new Error(`expected the copy to be a new poll id, got ${copiedPollUrl.pathname}`);
  }

  await browser.close();
  fixturesServer.close();
  console.log("ALL STEPS PASSED");
}

main().catch((e) => {
  console.error("E2E TEST FAILED:", e);
  process.exit(1);
});
