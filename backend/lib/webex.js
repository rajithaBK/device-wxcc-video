// Webex helpers for the WxCC video backend.
//
// One Service App performs meeting scheduling, WxCC task creation, and RoomOS
// device control. Its credentials come ONLY from environment variables.

import { getAccessToken } from "./tokens.js";

const API = "https://webexapis.com/v1";

/** Shared Service App token used by every privileged backend operation. */
export async function getServiceToken() {
  return getAccessToken("WEBEX");
}

function getHostEmail() {
  const hostEmail = (process.env.WEBEX_HOST_EMAIL || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(hostEmail)) {
    throw new Error("Missing or invalid required env var: WEBEX_HOST_EMAIL");
  }
  return hostEmail;
}

async function webexFetch(path, { method = "GET", token, body } = {}) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
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
      `Webex ${method} ${path} failed (${resp.status}): ${text}`
    );
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Verifies a caller-supplied token belongs to a real Webex user (authz). */
export async function verifyPerson(agentToken) {
  return webexFetch("/people/me", { token: agentToken });
}

/**
 * Creates a short standard meeting on behalf of a licensed Webex host.
 * Returns the full meeting object incl. { id, sipAddress, meetingNumber, webLink, password }.
 *
 * The routed agent authenticates with their own Webex identity. Eligible users
 * with host privileges on the host's meeting site become cohosts.
 */
export async function createMeeting(token, { title = "WxCC Video Support" } = {}) {
  const start = new Date(Date.now() + 60 * 1000);
  const end = new Date(Date.now() + 60 * 60 * 1000);
  return webexFetch("/meetings", {
    method: "POST",
    token,
    body: {
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      hostEmail: getHostEmail(),
      allowAnyUserToBeCoHost: true,
      enabledJoinBeforeHost: true,
      joinBeforeHostMinutes: 15,
      enableConnectAudioBeforeHost: true,
      unlockedMeetingJoinSecurity: "allowJoin",
    },
  });
}

/**
 * Resolves one exact meeting owned by the Service App from its SIP address.
 * Exact matching is required: selecting the "latest" meeting can connect an
 * agent to the wrong customer when requests overlap.
 */
export async function getMeetingBySip(token, meetingSip, { windowMinutes = 120 } = {}) {
  if (
    typeof meetingSip !== "string" ||
    !/^[^@\s]+@[^@\s]*webex\.com$/i.test(meetingSip)
  ) {
    throw new Error("Invalid Webex meeting SIP address");
  }

  const now = Date.now();
  const from = new Date(now - windowMinutes * 60 * 1000).toISOString();
  const to = new Date(now + windowMinutes * 60 * 1000).toISOString();
  const q =
    `/meetings?meetingType=scheduledMeeting` +
    `&hostEmail=${encodeURIComponent(getHostEmail())}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`;
  const data = await webexFetch(q, { token });
  const items = (data && data.items) || [];
  const match = items.find(
    (item) =>
      item &&
      typeof item.sipAddress === "string" &&
      item.sipAddress.toLowerCase() === meetingSip.toLowerCase()
  );
  if (!match) return null;

  // A list response may omit sensitive meeting fields such as the password.
  // Fetch the exact meeting so the agent SDK can complete password verification.
  return webexFetch(
    `/meetings/${encodeURIComponent(match.id)}?hostEmail=${encodeURIComponent(
      getHostEmail()
    )}`,
    { token }
  );
}

/**
 * Stores the WxCC task id in meeting metadata so the agent session can resolve
 * the exact meeting even when Work Item metadata is not exposed in Desktop CAD.
 */
export async function tagMeetingWithTaskId(token, meeting, taskId) {
  if (!meeting || !meeting.id || !taskId) {
    throw new Error("Meeting and taskId are required for correlation");
  }
  return webexFetch(`/meetings/${encodeURIComponent(meeting.id)}`, {
    method: "PUT",
    token,
    body: {
      title: meeting.title,
      agenda: `wxcc-task-id:${taskId}`,
      password: meeting.password,
      start: meeting.start,
      end: meeting.end,
      hostEmail: getHostEmail(),
      allowAnyUserToBeCoHost: true,
      enabledJoinBeforeHost: true,
      joinBeforeHostMinutes: 15,
      enableConnectAudioBeforeHost: true,
      unlockedMeetingJoinSecurity: "allowJoin",
    },
  });
}

/**
 * Resolves the meeting correlated to one exact WxCC task id.
 */
export async function getMeetingByTaskId(
  token,
  taskId,
  { windowMinutes = 120 } = {}
) {
  if (
    typeof taskId !== "string" ||
    !/^[0-9a-fA-F-]{16,64}$/.test(taskId)
  ) {
    throw new Error("Invalid WxCC task id");
  }
  const now = Date.now();
  const from = new Date(now - windowMinutes * 60 * 1000).toISOString();
  const to = new Date(now + windowMinutes * 60 * 1000).toISOString();
  const q =
    `/meetings?meetingType=scheduledMeeting` +
    `&hostEmail=${encodeURIComponent(getHostEmail())}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`;
  const data = await webexFetch(q, { token });
  const marker = `wxcc-task-id:${taskId}`;
  const match = ((data && data.items) || []).find(
    (item) => item && item.agenda === marker
  );
  if (!match) return null;
  return webexFetch(
    `/meetings/${encodeURIComponent(match.id)}?hostEmail=${encodeURIComponent(
      getHostEmail()
    )}`,
    { token }
  );
}

/**
 * Auto-dials a RoomOS device (Cloud xAPI) so it joins the meeting's SIP address.
 * request-support.js uses this after task creation so the physical endpoint
 * joins the meeting without a browser Webex SDK client.
 *
 * @param {string} token       Shared Service App access token.
 * @param {string} deviceId    The RoomOS device id to dial.
 * @param {string} sipAddress  The meeting SIP address to dial into.
 */
export async function dialDevice(token, deviceId, sipAddress) {
  return webexFetch("/xapi/command/dial", {
    method: "POST",
    token,
    // The native Webex join path fails on this device for canadacollab-sbx
    // meetings (startOutgoingForWebexMeeting RequestFailed); SIP joins cleanly.
    body: { deviceId, arguments: { Number: sipAddress, Protocol: "Sip" } },
  });
}
