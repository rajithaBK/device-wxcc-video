// Thin WxCC wrapper web component.
// WxCC resolves $STORE.* values for web-component *properties* (not for a raw
// iframe src), so we receive the agent access token here and pass it into the
// hosted video page via ?access_token=...
//
// For the "video-in-queue" flow, the customer's meeting was created up front by
// the orchestrator and embedded in the WxCC task's workItemData.videoMeetingSip
// (surfaced as call-associated data). We need that SIP so the agent joins the
// SAME meeting.
//
// ROBUST SIP DISCOVERY:
//   The exact $STORE path for a single CAD value can vary by tenant/version and
//   is timing/cache sensitive. So instead of relying ONLY on a single
//   `meetingSip` binding, we ALSO accept the whole task object via `taskData`
//   ($STORE.agentContact.taskSelected — the same binding the JDS widget uses)
//   and search it for the meeting SIP. Whichever resolves first wins.
//
//   $STORE properties also update in REAL TIME and can arrive in any order
//   (the token usually lands before the task CAD), so we must NOT render the
//   instant we have a token — we wait for a SIP, with a short fallback.
(function () {
  var scriptUrl = document.currentScript && document.currentScript.src;
  var PAGE_URL = scriptUrl
    ? new URL("./index.html?v=11", scriptUrl).href
    : "/widget/index.html?v=11";

  function isResolved(v) {
    return typeof v === "string" && v && v.indexOf("$STORE") === -1;
  }

  // Recursively search an object for a Webex meeting SIP (e.g.
  // 23178073309@site.webex.com). Prefers an explicit videoMeetingSip key, then
  // falls back to any @...webex.com string. Bounded depth to stay safe.
  function findMeetingSip(obj, depth) {
    if (obj == null || depth > 6) return null;
    if (typeof obj === "string") {
      return /@[\w.-]*webex\.com/i.test(obj) ? obj : null;
    }
    if (typeof obj !== "object") return null;
    try {
      var direct = obj.videoMeetingSip;
      if (typeof direct === "string" && /webex\.com/i.test(direct)) return direct;
      if (
        direct &&
        typeof direct === "object" &&
        typeof direct.value === "string" &&
        /webex\.com/i.test(direct.value)
      ) {
        return direct.value;
      }
    } catch (e) {}
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      try {
        var found = findMeetingSip(obj[k], (depth || 0) + 1);
        if (found) return found;
      } catch (e) {}
    }
    return null;
  }

  // Recursively find a WxCC interactionId in the task object (bounded depth).
  function findInteractionId(obj, depth) {
    if (obj == null || depth > 6) return null;
    if (typeof obj !== "object") return null;
    try {
      if (typeof obj.interactionId === "string" && obj.interactionId)
        return obj.interactionId;
      if (
        obj.interaction &&
        typeof obj.interaction.interactionId === "string" &&
        obj.interaction.interactionId
      )
        return obj.interaction.interactionId;
    } catch (e) {}
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      try {
        var found = findInteractionId(obj[k], (depth || 0) + 1);
        if (found) return found;
      } catch (e) {}
    }
    return null;
  }

  class VideoCcWidget extends HTMLElement {
    set accessToken(value) {
      this._accessToken = value;
      this._maybeRender();
    }
    get accessToken() {
      return this._accessToken;
    }

    set meetingSip(value) {
      this._meetingSip = value;
      this._maybeRender();
    }
    get meetingSip() {
      return this._meetingSip;
    }

    // Direct binding to
    // taskSelected.interaction.callAssociatedData. This is the documented
    // Desktop STORE location for CAD variables.
    set cad(value) {
      this._cadData = value;
      this._maybeRender();
    }
    get cad() {
      return this._cadData;
    }

    // Optional direct binding for the task id, e.g.
    // $STORE.agentContact.taskSelected.interactionId. Preferred when available.
    set taskId(value) {
      if (typeof value === "string" && value.indexOf("$STORE") === -1 && value) {
        this._interactionId = value;
        this._maybeRender();
        this._sendTaskId();
      }
    }
    get taskId() {
      return this._interactionId;
    }

    // Whole task object ($STORE.agentContact.taskSelected). Used to discover the
    // meeting SIP if the direct meetingSip binding didn't resolve.
    set taskData(value) {
      this._taskData = value;
      try {
        var id = findInteractionId(value, 0);
        if (id) this._interactionId = id;
      } catch (e) {}
      this._maybeRender();
      this._sendTaskId();
    }
    get taskData() {
      return this._taskData;
    }

    connectedCallback() {
      this._connected = true;
      this.style.display = "block";
      this.style.height = "100%";
      this._maybeRender();
      // The iframe posts "wxcc:widget-ready" once its listener is up; reply with
      // the task id (covers the case where the id arrived after iframe render).
      var self = this;
      window.addEventListener("message", function (e) {
        var d = e && e.data;
        if (!d || d.type !== "wxcc:widget-ready") return;
        if (self._iframe && e.source && e.source !== self._iframe.contentWindow)
          return;
        self._sendTaskId();
      });
    }

    // Push the current task id into the iframe (no-op until both are known).
    _sendTaskId() {
      if (this._interactionId && this._iframe) {
        this._postToIframe({
          type: "wxcc:set-task-id",
          taskId: this._interactionId,
        });
      }
    }

    _resolveSip() {
      if (isResolved(this._meetingSip)) return this._meetingSip;
      if (this._cadData && typeof this._cadData === "object") {
        var fromCad = findMeetingSip(this._cadData, 0);
        if (fromCad) return fromCad;
      }
      if (this._taskData && typeof this._taskData === "object") {
        var s = findMeetingSip(this._taskData, 0);
        if (s) return s;
      }
      return null;
    }

    _maybeRender() {
      if (!this._connected || this._rendered) return;
      if (!isResolved(this._accessToken)) return;
      var sip = this._resolveSip();
      if (sip || this._interactionId) {
        if (this._sipTimer) {
          clearTimeout(this._sipTimer);
          this._sipTimer = null;
        }
        this._render(sip);
        return;
      }
      // WxCC properties arrive asynchronously and the token commonly arrives
      // first. Wait for the exact task SIP; never render an iframe without it.
      if (!this._sipTimer) {
        var self = this;
        this._sipTimer = setTimeout(function () {
          self._sipTimer = null;
          if (!self._rendered && !self._resolveSip() && !self._interactionId)
            self._showMissingSip();
        }, 15000);
      }
    }

    _render(sip) {
      if (this._rendered) return;
      if (!isResolved(this._accessToken)) return;
      sip = sip || this._resolveSip();
      if (!sip && !this._interactionId) return;

      // PAGE_URL already carries ?v=..., so append params with &.
      var src =
        PAGE_URL + "&access_token=" + encodeURIComponent(this._accessToken);
      if (sip) src += "&meeting_sip=" + encodeURIComponent(sip);
      // The iframe uses this + the agent token to end the WxCC task via the
      // backend when the meeting ends (meeting -> task sync).
      if (this._interactionId)
        src += "&task_id=" + encodeURIComponent(this._interactionId);

      // Diagnostic: forward what we actually received for the SIP-bearing
      // properties so the page can show it if the SIP is missing. This reveals
      // whether the layout bindings are delivering values at all.
      try {
        var td = this._taskData;
        var dbg = {
          msProp:
            this._meetingSip === undefined
              ? "undefined"
              : isResolved(this._meetingSip)
              ? "resolved"
              : "unresolved:" + String(this._meetingSip).slice(0, 60),
          tdType: typeof td,
          tdKeys:
            td && typeof td === "object"
              ? Object.keys(td).slice(0, 25).join(",")
              : String(td).slice(0, 80),
          cadKeys:
            td && typeof td === "object" && td.callAssociatedData
              ? Object.keys(td.callAssociatedData).slice(0, 25).join(",")
              : "n/a",
          sip: sip || "none",
        };
        src += "&dbg=" + encodeURIComponent(JSON.stringify(dbg));
      } catch (e) {}

      var iframe = document.createElement("iframe");
      iframe.setAttribute("src", src);
      iframe.setAttribute("style", "width:100%;height:100%;border:none;");
      iframe.setAttribute(
        "allow",
        "camera; microphone; autoplay; display-capture"
      );
      this.appendChild(iframe);
      this._iframe = iframe;
      this._rendered = true;
    }

    _showMissingSip() {
      if (this._rendered) return;
      var message = document.createElement("div");
      message.setAttribute(
        "style",
        "padding:24px;font:14px/1.5 sans-serif;color:#5b1a1a;background:#fff3f2;"
      );
      message.textContent =
        "The task did not provide videoMeetingSip. Check the Desktop Layout CAD binding and Work Item schema.";
      this.appendChild(message);
    }

    // --- TASK -> MEETING sync --------------------------------------------
    // This wrapper runs in the Desktop context, so it can observe the WxCC TASK
    // lifecycle; the iframe (widget/app.js) owns the MEETING. Direction split:
    //   • Agent ends the TASK   -> we detect it here and tell the iframe to end
    //     the meeting (postMessage "wxcc:end-meeting").
    //   • Meeting ends (iframe) -> the iframe ends the TASK itself via the
    //     backend /api/end-task using the agent token + taskId we pass in.
    // The @wxcc-desktop/sdk can't be loaded standalone from a CDN (it needs
    // globals the Desktop host injects), so we rely on Desktop-native signals:
    // the widget being disconnected, and taskData ($STORE) state updates.
    _postToIframe(msg) {
      try {
        if (this._iframe && this._iframe.contentWindow) {
          this._iframe.contentWindow.postMessage(msg, "*");
        }
      } catch (e) {}
    }

    // WxCC Desktop can detach and replace custom elements during normal task
    // rendering. Never interpret DOM removal as an instruction to end a call.
    disconnectedCallback() {
      this._connected = false;
    }
  }

  if (!customElements.get("video-cc-widget")) {
    customElements.define("video-cc-widget", VideoCcWidget);
  }
})();
