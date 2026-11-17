// Cloud Quiz backend (Netlify Function + Firebase Firestore)
// Answers, timer and admin key live in Netlify environment variables, never in the browser.
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();
const scores = db.collection("scores"); // document ID = student name, so Firebase lists it A-Z

const ANSWERS = (process.env.ANSWERS || "").split(",").map((s) => parseInt(s.trim(), 10));
const SECONDS = parseInt(process.env.SECONDS || "15", 10);
const TOTAL = ANSWERS.length;
const NAME_RE = /^[A-ZÑ][A-ZÑ'.\- ]*, [A-ZÑ][A-ZÑ'.\- ]* [A-ZÑ]\.?$/;

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function cleanName(raw) {
  let n = String(raw || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!NAME_RE.test(n)) return null;
  if (!n.endsWith(".")) n += ".";
  return n;
}

// Teacher view: /.netlify/functions/quiz?key=YOUR_ADMIN_KEY  -> table sorted A-Z
async function listScores(event) {
  const key = event.queryStringParameters && event.queryStringParameters.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return { statusCode: 401, body: "Unauthorized" };
  }
  const snap = await scores.get();
  const rows = snap.docs
    .map((d) => d.data())
    .sort((a, b) => a.name.localeCompare(b.name));
  const tr = rows
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td><td>${r.name}</td><td>${r.score} / ${r.total}</td><td>${
          r.status === "done" ? "Finished" : "In progress (q" + (r.index + 1) + ")"
        }</td></tr>`
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cloud Quiz scores</title>
<style>body{font-family:system-ui,sans-serif;padding:20px;color:#24506b}table{border-collapse:collapse;width:100%;max-width:720px}
td,th{border:1px solid #7ec8ec;padding:8px 12px;text-align:left}th{background:#d9f0fb}</style>
<h2>Cloud Quiz scores (A-Z) - ${rows.length} students</h2>
<table><tr><th>#</th><th>Name</th><th>Score</th><th>Status</th></tr>${tr}</table>`;
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") return await listScores(event);
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    if (!TOTAL || ANSWERS.some(Number.isNaN)) return json(500, { error: "Quiz is not set up yet." });

    const b = JSON.parse(event.body || "{}");
    const name = cleanName(b.name);
    if (!name) {
      return json(400, { error: "Please use the format LAST NAME, FIRST NAME MI (example: DELA CRUZ, JUAN P.)" });
    }
    const ref = scores.doc(name);

    // ---------- START ----------
    if (b.action === "start") {
      const sid = crypto.randomBytes(16).toString("hex");
      try {
        await ref.create({
          name, sid, score: 0, total: TOTAL, index: 0,
          status: "in progress", revealed: false, last: null,
          qStart: Date.now(),
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) {
          return json(409, { error: "This name already started or finished the quiz. Please tell your teacher." });
        }
        throw e;
      }
      return json(200, { sid, name, seconds: SECONDS, total: TOTAL });
    }

    // ---------- ANSWER (reveal) ----------
    if (b.action === "answer") {
      const result = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists || snap.data().sid !== b.sid) return { status: 403, body: { error: "Invalid session" } };
        const s = snap.data();
        if (s.revealed && s.last) return { status: 200, body: s.last }; // retry-safe
        if (Date.now() - s.qStart < (SECONDS - 2) * 1000) return { status: 429, body: { error: "Too early" } };

        const correct = ANSWERS[s.index];
        const choice = Number.isInteger(b.choice) ? b.choice : null;
        const ok = choice === correct;
        const score = s.score + (ok ? 1 : 0);
        const done = s.index >= TOTAL - 1;
        const last = { correct, ok, score, done };
        const update = { score, revealed: true, last, status: done ? "done" : "in progress" };
        if (done) update.finishedAt = admin.firestore.FieldValue.serverTimestamp();
        t.update(ref, update);
        return { status: 200, body: last };
      });
      return json(result.status, result.body);
    }

    // ---------- NEXT ----------
    if (b.action === "next") {
      const snap = await ref.get();
      if (!snap.exists || snap.data().sid !== b.sid) return json(403, { error: "Invalid session" });
      const s = snap.data();
      if (s.index === b.index + 1) return json(200, { ok: true }); // already advanced (retry)
      if (s.index !== b.index || !s.revealed || s.status === "done") return json(400, { error: "Not allowed" });
      await ref.update({ index: s.index + 1, revealed: false, last: null, qStart: Date.now() });
      return json(200, { ok: true });
    }

    return json(400, { error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server problem. Please try again." });
  }
};
