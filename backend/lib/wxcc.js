// Webex Contact Center (WxCC) helpers for the video-in-queue backend.
//
// Creates a video "workItem" task on the WxCC routing API so an agent is
// routed immediately. The meeting SIP is embedded in workItemData so the agent
// desktop widget can join the same meeting as the RoomOS device.
//
// SECURITY: the Tasks API is authorized with the same server-side Service App
// used for meeting scheduling and device control. It requires cjp:task_write
// and cjp:task_read in addition to the Meetings and xAPI scopes.

import { getAccessToken } from "./tokens.js";

const ROUTING_API =
  process.env.WXCC_ROUTING_API ||
  "https://routing-api.prodca1.ciscoccservice.com";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Creates a WxCC video workItem task.
 *
 * @param {object} opts
 * @param {string} [opts.meetingSip]     SIP address of the customer's meeting.
 * @param {string|number} [opts.meetingNumber] Meeting number (for display/join).
 * @param {string} [opts.customerName]   Customer display name (task origin).
 * @param {string} [opts.customerId]     Stable customer id (task origin id).
 * @param {string} [opts.customerEmail]  Customer email (workItemData).
 * @param {string} [opts.requestedSpecialist] Specialist selected by customer.
 * @returns {Promise<object>} the created task response.
 */
export async function createVideoTask({
  meetingSip,
  meetingNumber,
  customerName,
  customerId,
  customerEmail,
  requestedSpecialist,
} = {}) {
  const token = await getAccessToken("WEBEX");
  const orgId = requiredEnv("WXCC_ORG_ID");
  const destinationId =
    process.env.WXCC_DESTINATION_ID || "YOUR_VIDEO_ENTRY_POINT";
  const videoCallDestination =
    process.env.WXCC_VIDEO_CALL_DESTINATION || "video-support@example.com";
  // The Work Item asset schema requires `email` to be present and non-empty
  // (an empty/required value makes WxCC drop the task after a 202). The kiosk
  // app collects no email, so fall back to a configurable default.
  const email =
    (customerEmail && customerEmail.trim()) ||
    (process.env.WXCC_DEFAULT_EMAIL || "").trim() ||
    "customer@example.com";

  const body = {
    orgId,
    origin: {
      // JDS uses origin.id as the customer identity.
      id: customerId || email,
      name: (
        requestedSpecialist
          ? `${customerName || "Video Support Customer"} • ${requestedSpecialist}`
          : customerName || "Video Support Customer"
      ).slice(0, 128),
    },
    destination: {
      id: destinationId,
      type: "businessAddress",
    },
    channelType: "workItem",
    channel: "VideoChannel",
    direction: {
      type: "INBOUND",
    },
    channelParams: {
      type: "work-item-form",
      message: {
        aliasId: "form-001",
        // NOTE: keys here MUST match the Work Item asset's data schema exactly.
        // WxCC drops the task (after a 202) if workItemData contains unknown
        // keys or is missing a required one. Keep this set == the asset schema:
        // videoCallDestination + email (original) + videoMeetingSip (added).
        workItemData: {
          videoCallDestination,
          email,
          // Meeting joined by the RoomOS device through xAPI. The agent widget
          // reads this value and joins the same meeting.
          videoMeetingSip: meetingSip || "",
        },
        timestamp: Math.floor(Date.now() / 1000),
      },
    },
  };

  const resp = await fetch(`${ROUTING_API}/v2/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(
      `WxCC POST /v2/tasks failed (${resp.status}): ${text}`
    );
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}
