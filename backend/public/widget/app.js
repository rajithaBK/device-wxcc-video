// WxCC "video-in-queue" widget entry (browser-native).
//
// Flow when a video task is routed to the agent desktop:
//   1) The task carries the customer's meeting SIP (from workItemData); the
//      wrapper forwards it here. POST the agent's WxCC access token + the
//      meeting SIP to our backend (/api/session), which verifies the agent and
//      resolves the exact standard Webex meeting.
//   2) This page joins the SAME meeting using the agent's own Webex identity.
//      The privileged Service App token stays on the backend.
//
// No secrets live here. `Webex` and `axios` are provided as globals by the
// CDN <script> tags in index.html (webex UMD + axios).

const BACKEND_URL = `${window.location.origin}/api/session`;
const END_TASK_URL = `${window.location.origin}/api/end-task`;

const urlParams = new URLSearchParams(window.location.search);
// The wrapper (video-cc-widget.js) injects the agent token as ?access_token=...
const agentToken = urlParams.get("access_token");
// For the video-in-queue flow, the wrapper also forwards the customer's meeting
// (from the WxCC task's workItemData) as ?meeting_sip=... so the agent joins
// that SAME meeting instead of creating a new one.
const taskMeetingSip = urlParams.get("meeting_sip");
// The wrapper forwards the WxCC task id so we can end the TASK (via the backend,
// using the agent token) when the MEETING ends — keeping the two in sync. It
// may arrive via the URL (if known at render) or later via postMessage.
let taskId = urlParams.get("task_id");

const loadingContainer = document.getElementById("loading-container");

function setStatus(msg) {
  if (loadingContainer) loadingContainer.innerHTML = `<span>${msg}</span>`;
}
// Pull a human-readable reason out of whatever the SDK / axios throws so the
// UI shows the real cause instead of a generic message.
function errorDetail(err) {
  if (!err) return "";
  const parts = [];
  if (err.response && err.response.data) {
    const d = err.response.data;
    parts.push(d.error || d.detail || d.message || JSON.stringify(d));
  }
  if (err.body) {
    parts.push(typeof err.body === "string" ? err.body : JSON.stringify(err.body));
  }
  if (err.message) parts.push(err.message);
  if (!parts.length && typeof err === "string") parts.push(err);
  if (!parts.length) {
    try {
      parts.push(JSON.stringify(err));
    } catch (_) {
      parts.push(String(err));
    }
  }
  return parts.filter(Boolean).join(" — ");
}

function fail(msg, err) {
  const detail = errorDetail(err);
  const full = detail ? `${msg} (${detail})` : msg;
  if (err) console.error(msg, err);
  else console.error(msg);
  setStatus(full);
}

let webex;
let currentMeeting = null;

// --- TASK <-> MEETING sync -----------------------------------------------
// The wrapper (video-cc-widget.js) runs in the Desktop context (where the WxCC
// TASK lives); this page runs in the cross-origin iframe (where the MEETING
// lives).
//   • Agent ends the TASK  -> wrapper posts "wxcc:end-meeting" -> we end meeting
//   • Meeting ends here     -> we end the TASK via the backend /api/end-task
//     (authorized with the agent's own token, which owns the task).
window.addEventListener("message", function (e) {
  var d = e && e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "wxcc:set-task-id") {
    if (d.taskId && !taskId) {
      taskId = d.taskId;
      console.log("received task_id from wrapper");
    }
    return;
  }
  if (d.type !== "wxcc:end-meeting") return;
  console.log("wrapper asked to end meeting (task ended)");
  try {
    if (currentMeeting) leaveAgentMeeting(currentMeeting);
    else cleanupAndRedirect();
  } catch (err) {}
});
// Ask the wrapper for the task id in case it wasn't ready at iframe render time.
try {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "wxcc:widget-ready" }, "*");
  }
} catch (e) {}

let __taskEndRequested = false;
function endWxccTask() {
  if (__taskEndRequested) return;
  __taskEndRequested = true;
  if (!taskId || !agentToken) {
    console.log("no taskId/token — skipping task end", { hasTask: !!taskId });
    return;
  }
  try {
    // keepalive lets the request complete even though cleanupAndRedirect is
    // about to navigate this iframe to hangup.html.
    fetch(END_TASK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + agentToken,
      },
      body: JSON.stringify({ taskId: taskId }),
      keepalive: true,
    })
      .then(function (r) {
        console.log("end-task ->", r.status);
      })
      .catch(function (err) {
        console.warn("end-task failed:", err && err.message);
      });
  } catch (e) {}
}

async function start() {
  if (!agentToken || String(agentToken).indexOf("$STORE") !== -1) {
    fail("Access token is missing.");
    return;
  }

  setStatus("Connecting…");

  // Resolve this exact meeting. Never fall back to the "latest" meeting:
  // overlapping requests could connect the wrong customer.
  let session;
  try {
    const payload = { taskId };
    if (taskMeetingSip && String(taskMeetingSip).indexOf("$STORE") === -1) {
      payload.meetingSip = taskMeetingSip;
    }
    const resp = await axios.post(BACKEND_URL, payload, {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    session = resp.data;
  } catch (e) {
    fail("Failed to start the video session.", e);
    return;
  }

  const { meetingSip, meetingPassword } = session || {};
  console.log("session:", { meetingSip });
  if (!meetingSip) {
    fail("Invalid session response from backend.");
    return;
  }

  // Join as the authenticated WxCC/Webex agent. The standard meeting allows
  // eligible users with host privileges on the Reception Host's site to become
  // cohosts.
  //
  //   a) WAIT for the SDK `ready` event before calling meetings.register().
  //      Calling register() early is what caused the old
  //      "Cannot read properties of undefined (reading 'internal')" crash.
  //   b) Verify the meeting password when the SDK requires it.
  let meeting;
  try {
    webex = window.Webex.init({ credentials: { access_token: agentToken } });
    if (webex.config && webex.config.logger) webex.config.logger.level = "debug";

    await waitForReady(webex);
  } catch (err) {
    fail("Could not initialize the video client.", err);
    return;
  }

  try {
    await webex.meetings.register();
    console.log("Webex meetings registered");
    // Reliable teardown: when the meeting ends for all, the SDK REMOVES the
    // meeting object (reason MEETING_INACTIVE_TERMINATING). Redirect the agent
    // in that case even if the per-meeting meeting:ended event doesn't fire.
    webex.meetings.on("meeting:removed", (payload) => {
      console.log(
        "meeting removed — redirecting agent side",
        (payload && payload.reason) || ""
      );
      cleanupAndRedirect();
    });
  } catch (err) {
    // Most likely cause: the join token lacks the meetings scopes.
    fail("Could not register the video client.", err);
    return;
  }

  try {
    meeting = await webex.meetings.create(meetingSip);
    currentMeeting = meeting;
    console.log("Meeting created for", meetingSip);
  } catch (err) {
    fail("Could not look up the meeting.", err);
    return;
  }

  // Verify the meeting password when required by the site policy.
  if (meetingPassword) {
    try {
      const vp = await meeting.verifyPassword(meetingPassword);
      console.log("verifyPassword:", vp);
    } catch (e) {
      // Some SDK versions throw when verification is not required. The join
      // call below remains the source of truth.
      console.warn("verifyPassword not required or failed:", e);
    }
  }

  try {
    await bindMeetingEvents(meeting);
    bindButtonEvents(meeting);
    bindLobbyEvents(meeting);
    await joinMeeting(meeting);
  } catch (err) {
    fail("Could not join the meeting.", err);
  }
}

// If the SDK ever reports the self participant is waiting in the lobby (e.g. if
// the join identity is changed back to a non-host guest), show a clear status
// instead of leaving the generic "Connecting…" or a misleading error.
function bindLobbyEvents(meeting) {
  try {
    meeting.on("meeting:self:lobbyWaiting", () => {
      console.log("self is waiting in the lobby");
      setStatus("Waiting to be admitted…");
    });
    meeting.on("meeting:self:guestAdmitted", () => {
      console.log("self was admitted from the lobby");
      setStatus("Admitted — connecting media…");
    });
  } catch (e) {
    console.warn("could not bind lobby events", e);
  }
}

// Resolves once the Webex SDK has finished initializing. Registering meetings
// before this fires throws deep inside the SDK ("reading 'internal'").
function waitForReady(webexInstance) {
  return new Promise((resolve, reject) => {
    if (webexInstance.ready) return resolve();
    const timeout = setTimeout(
      () => reject(new Error("Webex SDK ready timeout")),
      20000
    );
    webexInstance.once("ready", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function bindButtonEvents(meeting) {
  const videoMuteOff = document.getElementById("video-mute-off");
  const videoMuteOn = document.getElementById("video-mute-on");
  const audioMuteOff = document.getElementById("audio-mute-off");
  const audioMuteOn = document.getElementById("audio-mute-on");
  const dropdownButton = document.getElementById("dropdown-button");
  const hideSelfView = document.getElementById("hide-self-view");
  const showSelfView = document.getElementById("show-self-view");
  const self = document.getElementById("self");
  const remoteView = document.getElementById("remote-view");
  const dropdown = document.getElementsByClassName("dropdown");

  document.getElementById("hangup").addEventListener("click", async () => {
    console.log("hangup clicked");
    try {
      await meeting.leave();
    } catch (e) {
      console.error("leave error", e);
    } finally {
      // Guarantee the agent sees the "Call ended" page even if meeting events
      // are slow to fire.
      cleanupAndRedirect();
    }
  });

  // --- RECORDING (host-only cloud recording) ------------------------------
  // The authenticated agent can use host-only actions when Webex grants cohost
  // privileges and the site/account has recording enabled. Webex JS SDK v3
  // exposes async meeting.startRecording() /
  // meeting.stopRecording() (verified against developer.webex.com "Advanced
  // Meeting Controls" + @webex/plugin-meetings). Real state is reflected via
  // the meeting:recording:started/stopped events; clicks are optimistic with
  // rollback, and a "not permitted / not enabled" failure soft-disables the
  // control instead of crashing the widget.
  const recordStart = document.getElementById("record-start");
  const recordStop = document.getElementById("record-stop");

  function setRecordingUI(isRecording) {
    if (recordStart) recordStart.style.display = isRecording ? "none" : "";
    if (recordStop) recordStop.style.display = isRecording ? "" : "none";
  }
  function disableRecording(reason) {
    [recordStart, recordStop].forEach((b) => {
      if (!b) return;
      b.classList.add("is-disabled");
      b.setAttribute("disabled", "disabled");
      if (reason) b.title = reason;
    });
    console.warn("recording disabled:", reason || "");
  }
  setRecordingUI(false);

  if (recordStart) {
    recordStart.addEventListener("click", async () => {
      if (recordStart.hasAttribute("disabled")) return;
      setRecordingUI(true); // optimistic
      try {
        await meeting.startRecording();
        console.log("recording started");
      } catch (e) {
        console.error("startRecording failed", e);
        setRecordingUI(false); // rollback
        const msg = String((e && (e.message || e.error)) || "");
        if (/permission|not allowed|moderator|enabled|forbidden|403/i.test(msg)) {
          disableRecording("Recording not permitted / not enabled for this account");
        }
      }
    });
  }
  if (recordStop) {
    recordStop.addEventListener("click", async () => {
      if (recordStop.hasAttribute("disabled")) return;
      setRecordingUI(false); // optimistic
      try {
        await meeting.stopRecording();
        console.log("recording stopped");
      } catch (e) {
        console.error("stopRecording failed", e);
        setRecordingUI(true); // rollback
      }
    });
  }

  // Authoritative recording state from SDK events (covers recording started by
  // another host, or state changes we didn't initiate).
  try {
    meeting.on("meeting:recording:started", () => {
      console.log("event: recording started");
      setRecordingUI(true);
    });
    meeting.on("meeting:recording:stopped", () => {
      console.log("event: recording stopped");
      setRecordingUI(false);
    });
  } catch (e) {
    console.warn("could not bind recording events", e);
  }

  // --- SCREEN SHARE -------------------------------------------------------
  // Webex JS SDK v3: create a display stream via
  // webex.meetings.mediaHelpers.createDisplayStream() (video-only; screen-share
  // AUDIO is multistream-only and we join single-stream), publish it with
  // meeting.publishStreams({ screenShare: { video } }) and remove it with
  // meeting.unpublishStreams([stream]) (verified against the 2->3 migration
  // guide + plugin-meetings source). We store the stream on
  // meeting.__localStreams.screenShare to match the mic/camera convention.
  const shareStart = document.getElementById("share-start");
  const shareStop = document.getElementById("share-stop");

  function setShareUI(isSharing) {
    if (shareStart) shareStart.style.display = isSharing ? "none" : "";
    if (shareStop) shareStop.style.display = isSharing ? "" : "none";
    if (shareStop) shareStop.classList.toggle("is-live", !!isSharing);
  }
  const getShare = () =>
    meeting.__localStreams && meeting.__localStreams.screenShare;
  setShareUI(false);

  async function stopScreenShare() {
    const shareVideo = getShare();
    setShareUI(false); // optimistic
    if (!shareVideo) return;
    try {
      await meeting.unpublishStreams([shareVideo]);
    } catch (e) {
      console.error("unpublish screen share failed", e);
    }
    try {
      if (typeof shareVideo.stop === "function") await shareVideo.stop();
    } catch (_) {}
    if (meeting.__localStreams) meeting.__localStreams.screenShare = null;
    console.log("screen share stopped");
  }

  async function startScreenShare() {
    if (!shareStart || shareStart.hasAttribute("disabled")) return;
    const mediaHelpers = webex.meetings.mediaHelpers;
    let shareVideo = null;
    try {
      if (mediaHelpers && typeof mediaHelpers.createDisplayStream === "function") {
        shareVideo = await mediaHelpers.createDisplayStream();
      } else if (
        mediaHelpers &&
        typeof mediaHelpers.createDisplayStreamWithAudio === "function"
      ) {
        const streams = await mediaHelpers.createDisplayStreamWithAudio();
        shareVideo = Array.isArray(streams) ? streams[0] : streams;
      } else {
        console.warn("screen share not supported by this SDK build");
        return;
      }
    } catch (e) {
      // User cancelled the browser screen-picker (NotAllowedError/AbortError)
      // or permission was denied — leave the UI in the "Share Screen" state.
      console.warn(
        "screen share picker cancelled/denied:",
        (e && e.name) || "",
        (e && e.message) || ""
      );
      return;
    }
    if (!shareVideo) return;

    // If the agent clicks the browser's native "Stop sharing", the underlying
    // track ends — reflect that by unpublishing and resetting the UI.
    try {
      if (typeof shareVideo.on === "function") {
        shareVideo.on("stream-ended", () => {
          console.log("share stream ended (browser stop)");
          stopScreenShare();
        });
      }
      const track =
        shareVideo.outputStream &&
        shareVideo.outputStream.getVideoTracks &&
        shareVideo.outputStream.getVideoTracks()[0];
      if (track) {
        track.addEventListener("ended", () => {
          console.log("share track ended (browser stop)");
          stopScreenShare();
        });
      }
    } catch (_) {}

    setShareUI(true); // optimistic
    try {
      await meeting.publishStreams({ screenShare: { video: shareVideo } });
      meeting.__localStreams = meeting.__localStreams || {};
      meeting.__localStreams.screenShare = shareVideo;
      console.log("screen share published");
    } catch (e) {
      console.error("publish screen share failed", e);
      setShareUI(false); // rollback
      try {
        if (typeof shareVideo.stop === "function") await shareVideo.stop();
      } catch (_) {}
    }
  }

  if (shareStart) shareStart.addEventListener("click", startScreenShare);
  if (shareStop) shareStop.addEventListener("click", stopScreenShare);

  // Authoritative local-share state from SDK events.
  try {
    meeting.on("meeting:startedSharingLocal", () => {
      console.log("event: startedSharingLocal");
      setShareUI(true);
    });
    meeting.on("meeting:stoppedSharingLocal", () => {
      console.log("event: stoppedSharingLocal");
      setShareUI(false);
    });
  } catch (e) {
    console.warn("could not bind share events", e);
  }

  // Webex JS SDK v3 mutes the LOCAL STREAM, not the meeting. The old
  // meeting.muteVideo()/muteAudio()/unmute* calls are v2-only and don't exist
  // in 3.x, so every click threw "is not a function" and did nothing — which
  // is why only Hangup worked. We mute the microphone/camera streams instead.
  //
  // The streams are created in joinMeeting() (which runs AFTER this binds), so
  // we resolve them lazily at click time from meeting.__localStreams.
  const getMic = () => meeting.__localStreams && meeting.__localStreams.microphone;
  const getCam = () => meeting.__localStreams && meeting.__localStreams.camera;

  function setStreamMuted(stream, muted, label) {
    if (!stream) {
      console.warn(`${label}: no local ${label.includes("audio") ? "microphone" : "camera"} stream available`);
      return false;
    }
    try {
      if (typeof stream.setUserMuted === "function") {
        stream.setUserMuted(muted); // v3 API
      } else if (typeof stream.setMuted === "function") {
        stream.setMuted(muted); // defensive fallback
      } else {
        console.warn(`${label}: stream exposes no mute method`);
        return false;
      }
      return true;
    } catch (e) {
      console.error(`${label} failed`, e);
      return false;
    }
  }

  videoMuteOff.addEventListener("click", () => {
    if (!setStreamMuted(getCam(), true, "muteVideo")) return;
    videoMuteOff.style.display = "none";
    videoMuteOn.style.display = "";
  });
  videoMuteOn.addEventListener("click", () => {
    if (!setStreamMuted(getCam(), false, "unmuteVideo")) return;
    videoMuteOff.style.display = "";
    videoMuteOn.style.display = "none";
  });
  audioMuteOff.addEventListener("click", () => {
    if (!setStreamMuted(getMic(), true, "muteAudio")) return;
    audioMuteOff.style.display = "none";
    audioMuteOn.style.display = "";
  });
  audioMuteOn.addEventListener("click", () => {
    if (!setStreamMuted(getMic(), false, "unmuteAudio")) return;
    audioMuteOff.style.display = "";
    audioMuteOn.style.display = "none";
  });

  hideSelfView.addEventListener("click", () => {
    self.style.display = "none";
    hideSelfView.style.display = "none";
    showSelfView.style.display = "";
  });
  showSelfView.addEventListener("click", () => {
    self.style.display = "";
    hideSelfView.style.display = "";
    showSelfView.style.display = "none";
  });

  dropdownButton.addEventListener("click", () => {
    Array.from(dropdown).forEach((drop) => drop.classList.toggle("is-active"));
  });

  if (self) enableDrag(self, remoteView);

  window.addEventListener("resize", handleOrientationChange);
  if (screen.orientation) {
    screen.orientation.addEventListener("change", handleOrientationChange);
  }
  handleOrientationChange();
}

async function bindMeetingEvents(meeting) {
  const selfView = document.getElementById("self-view");
  const remoteViewVideo = document.getElementById("remote-view-video");
  const remoteViewAudio = document.getElementById("remote-view-audio");
  const buttonsContainer = document.getElementById("buttons-container");

  meeting.on("error", (error) => console.log(error, "Meeting Error"));

  // In webex 3.x, 'media:ready' delivers the REMOTE streams (remoteVideo /
  // remoteAudio / remoteShare). The LOCAL self-view is attached separately in
  // joinMeeting() from the created camera stream's `.outputStream`.
  meeting.on("media:ready", (media) => {
    if (!media || !media.stream) return;
    const element =
      media.type === "remoteVideo"
        ? remoteViewVideo
        : media.type === "remoteAudio"
        ? remoteViewAudio
        : media.type === "local"
        ? selfView
        : null;
    if (element) {
      element.srcObject = media.stream;
      if (buttonsContainer) buttonsContainer.style.display = "flex";
      if (loadingContainer) loadingContainer.style.display = "none";
      // A remote track means the customer is really connected. Record it so the
      // auto-end poll only ends AFTER a party has actually been present.
      if (media.type === "remoteVideo" || media.type === "remoteAudio") {
        meeting.__hadRemote = true;
      }
    }
  });

  meeting.on("media:stopped", (media) => {
    if (!media) return;
    const element =
      media.type === "remoteVideo"
        ? remoteViewVideo
        : media.type === "remoteAudio"
        ? remoteViewAudio
        : media.type === "local"
        ? selfView
        : null;
    if (element) element.srcObject = null;
  });

  // Full teardown when the local user leaves / the meeting ends.
  meeting.on("meeting:self:left", cleanupAndRedirect);
  meeting.on("meeting:ended", cleanupAndRedirect);

  // Do not infer hangup from transient membership snapshots. RoomOS devices can
  // briefly move through lobby/waiting states and disappear from the SDK member
  // collection even though the call is healthy. Explicit meeting events and
  // the agent Hangup control are the authoritative teardown signals.
}

// --- Auto-end when the customer leaves ------------------------------------
function getMembersMap(meeting) {
  try {
    const mc = meeting.members && meeting.members.membersCollection;
    return (
      (mc && mc.members) || (meeting.members && meeting.members.members) || {}
    );
  } catch (e) {
    return {};
  }
}

// Count remote participants actively IN the meeting (not self, not in lobby).
function remoteInMeetingCount(meeting) {
  const map = getMembersMap(meeting);
  let n = 0;
  Object.keys(map).forEach((k) => {
    const m = map[k];
    if (m && !m.isSelf && m.isInMeeting === true && !m.isInLobby) n++;
  });
  return n;
}

// Definitive "the meeting is over" signal, independent of the (unreliable)
// members:update / meeting:ended EVENTS: the meeting object's STATE flips to
// INACTIVE / LEFT (locusInfo.fullState.active === false) when the meeting ends.
function meetingIsOver(meeting) {
  try {
    if (!meeting) return false;
    const fs = meeting.locusInfo && meeting.locusInfo.fullState;
    // Do NOT test `fs.active === false` — a participant still WAITING reports
    // active:false with fs.state "INITIALIZING". Only end-specific signals:
    if (fs && fs.endMeetingReason) return true; // e.g. MEETING_ENDED_BY_HOST
    if (fs && fs.state === "INACTIVE") return true; // locus ended (not INITIALIZING)
    if (meeting.meetingState === "INACTIVE") return true;
    if (meeting.state === "LEFT") return true; // we were removed / left
  } catch (e) {}
  return false;
}

function checkAllPartiesGone(meeting) {
  // Meeting ended (by anyone) — tear down this side too.
  if (meetingIsOver(meeting)) {
    if (!meeting.__ending) {
      meeting.__ending = true;
      console.log("meeting ended — redirecting agent side");
      cleanupAndRedirect();
    }
    return;
  }
  const n = remoteInMeetingCount(meeting);
  if (n > 0) {
    meeting.__hadRemote = true;
    if (meeting.__endTimer) {
      clearTimeout(meeting.__endTimer);
      meeting.__endTimer = null;
    }
    return;
  }
  if (!meeting.__hadRemote || meeting.__endTimer || meeting.__ending) return;
  // Remote count dropped to 0 after having been present — confirm after a short
  // delay so a momentary membership blip doesn't end the call prematurely.
  meeting.__endTimer = setTimeout(() => {
    meeting.__endTimer = null;
    if (remoteInMeetingCount(meeting) === 0 && meeting.__hadRemote) {
      console.log("customer left — agent leaving meeting");
      leaveAgentMeeting(meeting);
    }
  }, 1500);
}

function leaveAgentMeeting(meeting) {
  if (meeting.__ending) return;
  meeting.__ending = true;
  const done = () => cleanupAndRedirect();
  try {
    Promise.resolve(meeting.leave ? meeting.leave() : null)
      .catch(() => {})
      .finally(done);
  } catch (e) {
    done();
  }
}

let __tornDown = false;
function cleanupAndRedirect() {
  if (__tornDown) return;
  __tornDown = true;
  console.log("meeting ended — cleaning up");
  // Meeting is over -> end the WxCC task too (meeting -> task sync).
  endWxccTask();
  try {
    if (currentMeeting && currentMeeting.__endTimer) {
      clearTimeout(currentMeeting.__endTimer);
      currentMeeting.__endTimer = null;
    }
    if (currentMeeting && currentMeeting.__poll) {
      clearInterval(currentMeeting.__poll);
      currentMeeting.__poll = null;
    }
  } catch (e) {}
  try {
    const streams = currentMeeting && currentMeeting.__localStreams;
    if (streams) {
      if (streams.microphone && streams.microphone.stop) streams.microphone.stop();
      if (streams.camera && streams.camera.stop) streams.camera.stop();
      if (streams.screenShare && streams.screenShare.stop) streams.screenShare.stop();
    }
  } catch (e) {}
  try {
    webex.meetings.unregister();
  } catch (e) {}
  window.location.href = "hangup.html";
}

// Webex JS SDK v3 (3.7.0) media flow.
//
// The old v2 API (getSupportedDevices / getMediaStreams /
// addMedia({localStream, localShare})) does NOT exist in 3.x and throws
// "meeting.getSupportedDevices is not a function". In 3.x you:
//   1) create local streams via webex.meetings.mediaHelpers
//      (createMicrophoneStream / createCameraStream),
//   2) meeting.join({ enableMultistream: false })  (single-stream keeps the
//      simple media:ready path for remote audio/video),
//   3) meeting.addMedia({ localStreams: { microphone, camera },
//                         audioEnabled, videoEnabled }).
// Local video is shown from the created camera stream's `.outputStream`
// (a MediaStream); remote media arrives via the 'media:ready' event.
async function joinMeeting(meeting) {
  const mediaHelpers = webex.meetings.mediaHelpers;

  // Create local streams up front, but never hard-fail if a device is missing
  // or permission is denied — audio-only, or even receive-only, should still
  // connect instead of throwing.
  let microphone = null;
  let camera = null;
  try {
    microphone = await mediaHelpers.createMicrophoneStream();
  } catch (e) {
    console.warn("Microphone unavailable (continuing without mic):", e && e.name, e && e.message);
  }
  try {
    camera = await mediaHelpers.createCameraStream();
  } catch (e) {
    console.warn("Camera unavailable (continuing without camera):", e && e.name, e && e.message);
  }

  // Keep references for cleanup on hangup.
  meeting.__localStreams = { microphone, camera };

  // Show the local camera immediately in the self-view.
  if (camera && camera.outputStream) {
    const selfView = document.getElementById("self-view");
    if (selfView) selfView.srcObject = camera.outputStream;
    const buttonsContainer = document.getElementById("buttons-container");
    if (buttonsContainer) buttonsContainer.style.display = "flex";
    if (loadingContainer) loadingContainer.style.display = "none";
  }

  // 1) Join (single-stream so remote media surfaces via media:ready).
  try {
    await meeting.join({ enableMultistream: false });
    console.log("meeting joined");
  } catch (error) {
    fail("Could not join the meeting.", error);
    throw error;
  }

  // 2) Publish local media / negotiate remote media.
  const localStreams = {};
  if (microphone) localStreams.microphone = microphone;
  if (camera) localStreams.camera = camera;
  try {
    await meeting.addMedia({
      localStreams,
      audioEnabled: !!microphone,
      videoEnabled: !!camera,
    });
    console.log("media added");
  } catch (error) {
    // We're in the meeting; only media negotiation failed. Surface the real
    // reason but don't treat it as a failure to join.
    fail("Joined, but could not set up audio/video.", error);
  }
}

function handleOrientationChange() {
  // Self-view sizing/position is handled by style.css now. This is kept so the
  // resize/orientation listeners bound in bindButtonEvents remain valid no-ops.
}

// Minimal draggable self-view (replaces the bundled ./selfview helper).
function enableDrag(el, bounds) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  const onDown = (e) => {
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    startX = p.clientX;
    startY = p.clientY;
    const rect = el.getBoundingClientRect();
    const parent = (bounds || el.parentElement).getBoundingClientRect();
    origLeft = rect.left - parent.left;
    origTop = rect.top - parent.top;
    el.style.position = "absolute";
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    el.style.left = origLeft + (p.clientX - startX) + "px";
    el.style.top = origTop + (p.clientY - startY) + "px";
  };
  const onUp = () => {
    dragging = false;
  };

  el.addEventListener("mousedown", onDown);
  el.addEventListener("touchstart", onDown, { passive: false });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
}

start();
