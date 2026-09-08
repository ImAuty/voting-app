const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

const REGION = "asia-northeast1";

// Lets someone reclaim admin access to a poll from a browser/device other
// than the one that created it, using the one-time secret shown to the
// creator right after they made the poll (see firestore.rules,
// polls/{pollId}/private/recovery, for why that secret can never be read
// back by a normal client - only this function, via the Admin SDK, can see
// it). On a matching secret, this reassigns the poll's createdBy to
// whichever uid is calling right now.
exports.recoverAdmin = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "サインインが必要です。");
  }

  const { pollId, secret } = request.data || {};
  if (typeof pollId !== "string" || !pollId || typeof secret !== "string" || !secret) {
    throw new HttpsError("invalid-argument", "pollIdとsecretが必要です。");
  }

  let storedSecret;
  try {
    const recoverySnap = await db.doc(`polls/${pollId}/private/recovery`).get();
    if (!recoverySnap.exists) {
      throw new HttpsError("not-found", "無効な復旧リンクです。");
    }
    storedSecret = recoverySnap.data().secret;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("recoverAdmin: failed to read recovery secret", err);
    throw new HttpsError("internal", "復旧に失敗しました。");
  }

  const given = Buffer.from(secret);
  const stored = Buffer.from(String(storedSecret));
  const matches = given.length === stored.length && crypto.timingSafeEqual(given, stored);
  if (!matches) {
    throw new HttpsError("permission-denied", "無効な復旧リンクです。");
  }

  try {
    await db.doc(`polls/${pollId}`).update({ createdBy: uid });
  } catch (err) {
    console.error("recoverAdmin: failed to reassign createdBy", err);
    throw new HttpsError("internal", "復旧に失敗しました。");
  }

  return { ok: true };
});
