// GET /api/refresh  (Vercel Cron warm endpoint)
//
// Proactively refreshes the single Service App token used for meetings, WxCC
// tasks, and RoomOS xAPI so it stays warm. Correctness does not depend on this
// endpoint because every request lazily refreshes on use.
//
// Scheduled via backend/vercel.json. Vercel Cron includes the CRON_SECRET (if
// configured) as `Authorization: Bearer <CRON_SECRET>`, which we verify so the
// endpoint can't be triggered anonymously.

import { refreshAll } from "../lib/tokens.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const refreshed = await refreshAll(["WEBEX"]);
  const ok = Object.values(refreshed).every((v) => v === "ok");
  return res.status(ok ? 200 : 500).json({
    refreshed,
    at: new Date().toISOString(),
  });
}
