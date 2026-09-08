// Focused Firestore Security Rules tests, run directly against the
// Firestore emulator (no browser, no client app code).
//
// Run via `npm run test:rules` - wraps this in `firebase emulators:exec`
// for a clean database per run.
//
// This exists mainly to pin down the fix for a critical bug an audit found:
// votes/{uid} used to be paired with a separately-writable
// results/{optionId}.count counter, incremented by the voter. Nothing in the
// rules actually forced that increment to happen *together with* creating a
// real vote record, so a client could call the increment repeatedly on its
// own and stuff the ballot for any option, using a single anonymous session,
// without ever casting a real vote. The fix removed that counter entirely -
// tallies are now derived by the creator directly from the votes
// subcollection. Test 4 below pins that the old attack path is closed; the
// rest cover the surrounding invariants (double-vote prevention, read
// isolation, immutability) that make deriving counts from votes safe.

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
require("firebase/compat/app");
require("firebase/compat/firestore");
const firebase = require("firebase/compat/app").default;
const fs = require("fs");
const path = require("path");

// context.firestore() returns a compat-style (firebase v8 API) client, so
// timestamps that need to match request.time exactly (per the rules) must
// use the compat FieldValue sentinel, not a plain client Date.
const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();

const CREATOR_UID = "creator-uid";
const VOTER_UID = "voter-uid";
const OTHER_UID = "other-uid";

async function run() {
  const testEnv = await initializeTestEnvironment({
    projectId: "rules-test-imauty-voting",
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
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

  // Seed a poll as its creator, bypassing rules (this is just fixture setup,
  // not itself part of what's being tested).
  const pollId = "poll1";
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(`polls/${pollId}`).set({
      question: "test question",
      options: [{ id: "0", text: "A" }, { id: "1", text: "B" }],
      optionIds: ["0", "1"],
      isActive: true,
      createdAt: new Date(),
      createdBy: CREATOR_UID,
    });
  });

  const creatorDb = testEnv.authenticatedContext(CREATOR_UID).firestore();
  const voterDb = testEnv.authenticatedContext(VOTER_UID).firestore();
  const otherDb = testEnv.authenticatedContext(OTHER_UID).firestore();

  await check("a voter can cast one vote for a valid option", async () => {
    await assertSucceeds(
      voterDb.doc(`polls/${pollId}/votes/${VOTER_UID}`).set({
        optionId: "0",
        votedAt: serverTimestamp(),
      }),
    );
  });

  await check("that same voter cannot vote again (update denied)", async () => {
    await assertFails(
      voterDb.doc(`polls/${pollId}/votes/${VOTER_UID}`).set({
        optionId: "1",
        votedAt: serverTimestamp(),
      }),
    );
  });

  await check("that same voter cannot delete their own vote", async () => {
    await assertFails(voterDb.doc(`polls/${pollId}/votes/${VOTER_UID}`).delete());
  });

  await check("a different signed-in user cannot read someone else's vote", async () => {
    await assertFails(otherDb.doc(`polls/${pollId}/votes/${VOTER_UID}`).get());
  });

  await check("the creator can read every vote", async () => {
    await assertSucceeds(creatorDb.collection(`polls/${pollId}/votes`).get());
  });

  await check(
    "REGRESSION: writing a results/{optionId} vote-count doc directly is denied " +
      "(the old, exploitable counter no longer exists in the schema at all)",
    async () => {
      await assertFails(
        otherDb.doc(`polls/${pollId}/results/0`).set({ count: 999 }),
      );
      await assertFails(
        otherDb.doc(`polls/${pollId}/results/0`).update({ count: 999 }),
      );
    },
  );

  await check("a voter cannot vote for a nonexistent option id", async () => {
    await assertFails(
      otherDb.doc(`polls/${pollId}/votes/${OTHER_UID}`).set({
        optionId: "does-not-exist",
        votedAt: serverTimestamp(),
      }),
    );
  });

  await check("nobody but the creator can flip isActive", async () => {
    await assertFails(otherDb.doc(`polls/${pollId}`).update({ isActive: false }));
    await assertSucceeds(creatorDb.doc(`polls/${pollId}`).update({ isActive: false }));
  });

  await check("a vote cannot be cast once the poll is closed", async () => {
    await assertFails(
      otherDb.doc(`polls/${pollId}/votes/${OTHER_UID}`).set({
        optionId: "0",
        votedAt: serverTimestamp(),
      }),
    );
  });

  await check("the creator can write a recovery secret of plausible length", async () => {
    await assertSucceeds(
      creatorDb.doc(`polls/${pollId}/private/recovery`).set({ secret: "a".repeat(32) }),
    );
  });

  await check("nobody, including the creator, can ever read the recovery secret back", async () => {
    await assertFails(creatorDb.doc(`polls/${pollId}/private/recovery`).get());
    await assertFails(otherDb.doc(`polls/${pollId}/private/recovery`).get());
  });

  await check("the recovery secret is immutable once written", async () => {
    await assertFails(
      creatorDb.doc(`polls/${pollId}/private/recovery`).update({ secret: "b".repeat(32) }),
    );
    await assertFails(creatorDb.doc(`polls/${pollId}/private/recovery`).delete());
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc("polls/poll2").set({
      question: "second poll",
      options: [{ id: "0", text: "A" }, { id: "1", text: "B" }],
      optionIds: ["0", "1"],
      isActive: true,
      createdAt: new Date(),
      createdBy: CREATOR_UID,
    });
  });

  await check("only the poll's creator can write its recovery secret", async () => {
    await assertFails(
      otherDb.doc("polls/poll2/private/recovery").set({ secret: "c".repeat(32) }),
    );
  });

  await check("a too-short recovery secret is rejected", async () => {
    await assertFails(
      creatorDb.doc("polls/poll2/private/recovery").set({ secret: "tooshort" }),
    );
  });

  // ---- Drafts (one-time save / re-edit before publishing) ----

  await check("the creator can start a draft with an incomplete shape (no question, no options)", async () => {
    await assertSucceeds(
      creatorDb.doc("polls/draft1").set({
        question: "",
        options: [],
        optionIds: [],
        isActive: false,
        isDraft: true,
        createdAt: serverTimestamp(),
        createdBy: CREATOR_UID,
      }),
    );
  });

  await check("a draft with isDraft/isActive both true is rejected (drafts are never active)", async () => {
    await assertFails(
      creatorDb.doc("polls/bad-draft").set({
        question: "",
        options: [],
        optionIds: [],
        isActive: true,
        isDraft: true,
        createdAt: serverTimestamp(),
        createdBy: CREATOR_UID,
      }),
    );
  });

  await check("a non-draft created with isActive false is rejected (must publish active)", async () => {
    await assertFails(
      creatorDb.doc("polls/bad-publish").set({
        question: "q",
        options: [{ id: "0", text: "A" }, { id: "1", text: "B" }],
        optionIds: ["0", "1"],
        isActive: false,
        isDraft: false,
        createdAt: serverTimestamp(),
        createdBy: CREATOR_UID,
      }),
    );
  });

  await check("a draft is readable only by its own creator", async () => {
    await assertSucceeds(creatorDb.doc("polls/draft1").get());
    await assertFails(otherDb.doc("polls/draft1").get());
  });

  await check("the creator can keep editing a draft's question/options", async () => {
    await assertSucceeds(
      creatorDb.doc("polls/draft1").update({
        question: "draft question",
        options: [{ id: "0", text: "A" }],
        optionIds: ["0"],
      }),
    );
  });

  await check("publishing a draft that's still incomplete (only 1 option) is rejected", async () => {
    await assertFails(creatorDb.doc("polls/draft1").update({ isDraft: false, isActive: true }));
  });

  await check("a non-creator cannot edit or publish someone else's draft", async () => {
    await assertFails(otherDb.doc("polls/draft1").update({ question: "hijacked" }));
    await assertFails(otherDb.doc("polls/draft1").update({ isDraft: false, isActive: true }));
  });

  await check("publishing a now-complete draft succeeds", async () => {
    await creatorDb.doc("polls/draft1").update({
      options: [{ id: "0", text: "A" }, { id: "1", text: "B" }],
      optionIds: ["0", "1"],
    });
    await assertSucceeds(creatorDb.doc("polls/draft1").update({ isDraft: false, isActive: true }));
  });

  await check("once published, a formerly-draft poll is frozen just like any other", async () => {
    await assertFails(creatorDb.doc("polls/draft1").update({ question: "changed after publish" }));
    await assertSucceeds(creatorDb.doc("polls/draft1").update({ isActive: false }));
  });

  await testEnv.cleanup();

  console.log(`\n${passed} checks passed`);
  if (process.exitCode) {
    console.error("SOME RULES CHECKS FAILED");
    process.exit(1);
  }
  console.log("ALL RULES CHECKS PASSED");
}

run().catch((e) => {
  console.error("RULES TEST SCRIPT ERROR:", e);
  process.exit(1);
});
