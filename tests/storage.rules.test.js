// Focused Cloud Storage Security Rules tests, run directly against the
// Storage emulator (no browser, no client app code).
//
// Run via `npm run test:storage` - wraps this in `firebase emulators:exec`
// for a clean bucket per run.

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
require("firebase/compat/app");
require("firebase/compat/storage");
const fs = require("fs");
const path = require("path");

const CREATOR_UID = "creator-uid";
const OTHER_UID = "other-uid";

async function run() {
  const testEnv = await initializeTestEnvironment({
    projectId: "rules-test-imauty-voting",
    storage: {
      rules: fs.readFileSync(path.join(__dirname, "..", "storage.rules"), "utf8"),
      host: "127.0.0.1",
      port: 9199,
    },
  });

  let passed = 0;
  async function check(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAILED - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  const image = fs.readFileSync(path.join(__dirname, "fixtures", "pixel.png"));

  const creatorStorage = testEnv.authenticatedContext(CREATOR_UID).storage();
  const otherStorage = testEnv.authenticatedContext(OTHER_UID).storage();
  const unauthStorage = testEnv.unauthenticatedContext().storage();

  await check("a signed-in user can upload a small image under their own uid prefix", async () => {
    await assertSucceeds(
      creatorStorage.ref(`option-images/${CREATOR_UID}/test.png`).put(image, { contentType: "image/png" }),
    );
  });

  await check("anyone signed in can read an uploaded image", async () => {
    await assertSucceeds(otherStorage.ref(`option-images/${CREATOR_UID}/test.png`).getDownloadURL());
  });

  await check("a signed-out visitor can neither read nor write", async () => {
    await assertFails(unauthStorage.ref(`option-images/${CREATOR_UID}/test.png`).getDownloadURL());
    await assertFails(
      unauthStorage.ref(`option-images/${CREATOR_UID}/anon.png`).put(image, { contentType: "image/png" }),
    );
  });

  await check("a user cannot upload under someone else's uid prefix", async () => {
    await assertFails(
      otherStorage.ref(`option-images/${CREATOR_UID}/test2.png`).put(image, { contentType: "image/png" }),
    );
  });

  await check("a non-image content type is rejected", async () => {
    await assertFails(
      creatorStorage
        .ref(`option-images/${CREATOR_UID}/test.txt`)
        .put(Buffer.from("hello"), { contentType: "text/plain" }),
    );
  });

  await check("an oversized file is rejected", async () => {
    const tooBig = Buffer.alloc(6 * 1024 * 1024); // over the 5MB limit in storage.rules
    await assertFails(
      creatorStorage.ref(`option-images/${CREATOR_UID}/big.png`).put(tooBig, { contentType: "image/png" }),
    );
  });

  await check("the uploader can delete their own image", async () => {
    await assertSucceeds(creatorStorage.ref(`option-images/${CREATOR_UID}/test.png`).delete());
  });

  await check("a different user cannot delete someone else's image", async () => {
    await assertSucceeds(
      creatorStorage.ref(`option-images/${CREATOR_UID}/test3.png`).put(image, { contentType: "image/png" }),
    );
    await assertFails(otherStorage.ref(`option-images/${CREATOR_UID}/test3.png`).delete());
  });

  await testEnv.cleanup();

  console.log(`\n${passed} checks passed`);
  if (process.exitCode) {
    console.error("SOME STORAGE RULES CHECKS FAILED");
    process.exit(1);
  }
  console.log("ALL STORAGE RULES CHECKS PASSED");
}

run().catch((e) => {
  console.error("STORAGE RULES TEST SCRIPT ERROR:", e);
  process.exit(1);
});
