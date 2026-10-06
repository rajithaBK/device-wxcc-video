// POST /api/end-task
//
// Ends a WxCC task from the video widget so the TASK and the video MEETING stay
// in sync. When the meeting ends (customer or agent hangs up), the widget calls
// this endpoint to end the agent's task too.
//
// Authorization uses the AGENT's own Webex CC token (scope cjp:user), which is
// the only identity allowed to end that agent's task. We proxy the call so the
// browser doesn't hit the WxCC API cross-origin (no CORS on that host) and so
// no privileged server secret is ever needed here.
//
//   POST {ROUTING_API}/v1/tasks/{taskId}/end   (Bearer = agent token, no body)
//   -> 202 Accepted

const ROUTING_API =
  process.env.WXCC_ROUTING_API ||
  "https://routing-api.prodca1.ciscoccservice.com";

function applyCors(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || "";
  const origin = req.headers.origin || "";
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

// Accept a UUID-shaped task id only (defensive: this value is proxied into a URL).
function isTaskId(v) {
  return typeof v === "string" && /^[0-9a-fA-F-]{16,64}$/.test(v);
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
    const taskId = body.taskId || body.interactionId || "";

    if (!agentToken) {
      return res.status(401).json({ error: "missing_agent_token" });
    }
    if (!isTaskId(taskId)) {
      return res.status(400).json({ error: "invalid_task_id" });
    }

    const url = `${ROUTING_API}/v1/tasks/${encodeURIComponent(taskId)}/end`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json",
      },
    });
    const text = await upstream.text();

    // 2xx (usually 202 Accepted) means WxCC accepted the end request.
    if (upstream.ok || upstream.status === 202) {
      console.log(`end-task ok (${upstream.status}) task=${taskId}`);
      return res.status(200).json({ status: "ok", upstream: upstream.status });
    }
    console.warn(
      `end-task upstream failed (${upstream.status}) task=${taskId}: ${text.slice(0, 200)}`
    );
    return res.status(502).json({
      error: "end_task_failed",
      upstream: upstream.status,
      detail: text.slice(0, 300),
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "end_task_error", detail: String(e.message || e) });
  }
}
