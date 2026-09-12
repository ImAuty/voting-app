const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

const REGION = "asia-northeast1";

// The client's IP behind Cloud Functions' front-end proxy is the first hop
// in X-Forwarded-For, not req.ip (which would be the proxy itself).
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "";
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

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

// Casts a vote on behalf of the caller. This is now the *only* way a
// polls/{pollId}/votes/{uid} doc gets created - firestore.rules denies the
// direct client write outright - because on top of the existing "one vote
// per uid" check, this also has to check the caller's IP address, and
// Firestore security rules have no access to that at all. A fresh anonymous
// uid from a private/incognito window or a different browser still shares
// the same IP as whatever vote was already cast from that network, so this
// catches that even though it's a brand-new, otherwise-legitimate-looking
// uid.
//
// The IP itself is never stored - only a SHA-256 hash of it, under
// polls/{pollId}/ipVotes/{ipHash}, a subcollection with no client-facing
// rule at all (see firestore.rules), so nobody - not even the poll's
// creator - can read it back through the normal app. This is a
// pseudonymization step to avoid keeping plaintext IPs at rest, not a
// defense against someone who already has direct database access; there's
// no per-deploy secret mixed into the hash, so treat it as identifying, not
// anonymous.
exports.castVote = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "サインインが必要です。");
  }

  const { pollId, optionId } = request.data || {};
  if (typeof pollId !== "string" || !pollId || typeof optionId !== "string" || !optionId) {
    throw new HttpsError("invalid-argument", "pollIdとoptionIdが必要です。");
  }

  const pollSnap = await db.doc(`polls/${pollId}`).get();
  if (!pollSnap.exists) {
    throw new HttpsError("not-found", "投票が見つかりません。");
  }
  const poll = pollSnap.data();
  if (poll.isActive !== true || !Array.isArray(poll.optionIds) || !poll.optionIds.includes(optionId)) {
    throw new HttpsError("failed-precondition", "この投票には参加できません。");
  }

  const ipHash = hashIp(clientIp(request.rawRequest));
  const voteRef = db.doc(`polls/${pollId}/votes/${uid}`);
  const ipVoteRef = db.doc(`polls/${pollId}/ipVotes/${ipHash}`);

  try {
    await db.runTransaction(async (tx) => {
      const [voteSnap, ipVoteSnap] = await Promise.all([tx.get(voteRef), tx.get(ipVoteRef)]);
      if (voteSnap.exists) {
        throw new HttpsError("already-exists", "すでに投票済みです。");
      }
      if (ipVoteSnap.exists) {
        throw new HttpsError("already-exists", "同じネットワークから既に投票されています。");
      }
      const votedAt = FieldValue.serverTimestamp();
      tx.set(voteRef, { optionId, votedAt });
      tx.set(ipVoteRef, { voterUid: uid, votedAt });
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("castVote: transaction failed", err);
    throw new HttpsError("internal", "投票に失敗しました。");
  }

  return { ok: true };
});
