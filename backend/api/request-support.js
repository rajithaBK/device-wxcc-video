// POST /api/request-support
//
// Called by the device web app after the customer submits their details. It:
//   1) creates a shared Webex meeting (Service App),
//   2) creates a WxCC video workItem task (embedding the meeting SIP so the
//      agent desktop widget can join the SAME meeting),
//   3) dials the RoomOS device into that meeting through Cloud xAPI.
//
// The privileged Service App + WxCC routing credentials live ONLY in env vars
// on the server (never hardcoded, never committed).

import {
  getServiceToken,
  createMeeting,
  dialDevice,
  tagMeetingWithTaskId,
} from "../lib/webex.js";
import { createVideoTask } from "../lib/wxcc.js";

const SPECIALIST_OPTIONS = new Set([
  "Nurse Practitioner",
  "Insurance Specialist",
  "Clinical Pharmacist",
  "Social Worker",
]);

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

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const body = await readBody(req);
    const customerName = (body.customerName || "").toString().trim().slice(0, 128);
    const birthYear = Number(body.birthYear);
    const connectWith = (body.connectWith || "").toString().trim();
    const currentYear = new Date().getUTCFullYear();
    if (!customerName) {
      return res.status(400).json({ error: "customer_name_required" });
    }
    if (
      !Number.isInteger(birthYear) ||
      birthYear < currentYear - 120 ||
      birthYear > currentYear
    ) {
      return res.status(400).json({ error: "invalid_birth_year" });
    }
    if (!SPECIALIST_OPTIONS.has(connectWith)) {
      return res.status(400).json({ error: "invalid_specialist" });
    }

    // 1) Shared Service App token -> create a standard meeting on behalf of
    // the configured licensed host.
    const svc = await getServiceToken();
    const meeting = await createMeeting(svc, {
      title: `${connectWith} - ${customerName}`.slice(0, 128),
    });

    // 2) Route the task immediately. The configured Work Item schema has a
    // fixed set of fields, so the birth year is carried in the task origin name
    // rather than adding an unknown workItemData property. The origin id (the
    // JDS identity) is the configured WXCC_DEFAULT_EMAIL.
    let taskStatus = "ok";
    let taskId = null;
    try {
      const task = await createVideoTask({
        meetingSip: meeting.sipAddress,
        meetingNumber: meeting.meetingNumber,
        customerName: `${customerName} (${birthYear})`,
        requestedSpecialist: connectWith,
      });
      taskId =
        (task && task.data && task.data.id) ||
        (task && (task.id || task.taskId || task.interactionId)) ||
        null;
      if (!taskId) {
        throw new Error("WxCC create task response did not include a task id");
      }
      await tagMeetingWithTaskId(svc, meeting, taskId);
    } catch (e) {
      taskStatus = `failed: ${e.status || ""} ${e.message || ""}`.trim();
      console.warn("task creation/correlation failed:", taskStatus);
    }

    // 3) Dial this RoomOS device into the newly created meeting with Cloud
    // xAPI. A failure is returned as status so the web app can offer a retry.
    let dialStatus = "skipped";
    const kioskDeviceId = process.env.KIOSK_DEVICE_ID;
    if (taskStatus === "ok" && kioskDeviceId && meeting.sipAddress) {
      try {
        const dialResult = await dialDevice(
          svc,
          kioskDeviceId,
          meeting.sipAddress
        );
        const callId =
          dialResult && dialResult.result && dialResult.result.CallId;
        dialStatus = callId != null ? `ok (CallId ${callId})` : "ok";
      } catch (e) {
        dialStatus = `failed: ${e.status || ""} ${e.message || ""}`.trim();
        console.warn("kiosk auto-dial failed:", dialStatus);
      }
    }

    return res.status(200).json({
      meetingSip: meeting.sipAddress,
      meetingId: meeting.id,
      meetingNumber: meeting.meetingNumber,
      taskStatus,
      taskId,
      dialStatus,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "request_support_failed", detail: String(e.message || e) });
  }
}
