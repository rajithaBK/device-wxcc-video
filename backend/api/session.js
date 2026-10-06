// POST /api/session
//
// Called by the WxCC video widget when a task is routed to the agent. The task
// carries a SIP in channelParams.workItemData.videoMeetingSip, which the widget
// forwards here as { meetingSip }. That value is UNTRUSTED (in the manual-task
// flow it is the kiosk device's personal-room SIP, not a real meeting). This
// endpoint therefore:
//   1) verifies the caller (the agent's Webex token) as authorization,
//   2) reuses the passed SIP only if it resolves to a meeting this Service App
//      owns; otherwise rejects the request (never creates a second meeting),
//   3) returns that exact meeting. The agent joins with their own Webex token
//      and receives cohost privileges when eligible on the host's meeting site.

import {
  getServiceToken,
  verifyPerson,
  getMeetingBySip,
  getMeetingByTaskId,
} from "../lib/webex.js";

function applyCors(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || "";
  const origin = req.headers.origin || "";
  // Only echo the origin back if it is on the allow-list.
  const allowList = allowed.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowList.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const body = await readBody(req);
    const authHeader = req.headers.authorization || "";
    const agentToken =
      (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "") ||
      body.agentToken ||
      "";

    // Authorization: require a Webex identity so meeting details are never
    // returned to anonymous callers.
    if (!agentToken) {
      return res.status(401).json({ error: "missing_agent_token" });
    }
    // Verify the caller's identity. A WxCC agent token may not carry the
    // people_read scope, so treat a scope/permission failure (403) as
    // "authenticated but limited" and continue. Only a genuinely
    // invalid/expired token (401) is rejected.
    let agentPerson = null;
    try {
      agentPerson = await verifyPerson(agentToken);
    } catch (e) {
      if (e.status === 401) {
        return res.status(401).json({ error: "invalid_agent_token" });
      }
      console.warn(
        `verifyPerson non-fatal (${e.status || "?"}); continuing`
      );
    }

    const svc = await getServiceToken();

    // The task's workItemData.videoMeetingSip is required. Never fall back to a
    // new or "latest" meeting: doing so puts the agent and RoomOS device into
    // different calls when task properties arrive asynchronously.
    const incomingSip =
      typeof body.meetingSip === "string" ? body.meetingSip.trim() : "";
    const looksLikeSip =
      incomingSip.indexOf("$STORE") === -1 &&
      /^[^@\s]+@[^@\s]*webex\.com$/i.test(incomingSip);
    const taskId =
      typeof body.taskId === "string" ? body.taskId.trim() : "";
    const looksLikeTaskId = /^[0-9a-fA-F-]{16,64}$/.test(taskId);
    if (!looksLikeSip && !looksLikeTaskId) {
      return res
        .status(400)
        .json({ error: "meeting_sip_or_task_id_required" });
    }

    let meeting = null;
    // The Meetings list can be briefly eventually consistent immediately after
    // creation. Retry the exact lookup, but never substitute another meeting.
    for (let attempt = 0; attempt < 4 && !meeting; attempt += 1) {
      try {
        if (looksLikeSip) {
          meeting = await getMeetingBySip(svc, incomingSip);
        }
        if (!meeting && looksLikeTaskId) {
          meeting = await getMeetingByTaskId(svc, taskId);
        }
      } catch (e) {
        if (attempt === 3) throw e;
      }
      if (!meeting && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    if (!meeting) {
      return res.status(404).json({ error: "task_meeting_not_found" });
    }

    return res.status(200).json({
      meetingSip: meeting.sipAddress,
      meetingNumber: meeting.meetingNumber,
      meetingPassword: meeting.password || "",
      agentDisplayName:
        (agentPerson && (agentPerson.displayName || agentPerson.nickName)) ||
        "Support Specialist",
      meetingCreated: false,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "session_failed", detail: String(e.message || e) });
  }
}
