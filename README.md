# Device Video in Webex Contact Center

A customer taps **Get Started** in the device web app and enters their name and
year of birth. The backend creates a Webex meeting, immediately routes a WxCC
video task, and dials the RoomOS device into the meeting through Cloud xAPI.
The agent desktop widget joins that same meeting.

This repository is a reference implementation, not a production-ready Cisco
product. Review the security and tenant-specific authorization requirements
before deploying it.

## Architecture

```
Device web app  --name + birth year-->  customer page (customer/)
        page  --POST /api/request-support-->  backend (Vercel)
                backend: create meeting
                         + POST /v2/tasks (WxCC) with meetingSip in workItemData
                         + Cloud xAPI dial RoomOS device into meeting
        WxCC  --routes task-->  agent desktop widget (widget/)
        widget reads workItemData.videoMeetingSip
        widget --POST /api/session { meetingSip }--> backend
        backend verifies exact meeting
        widget --join as authenticated cohost-->  same Webex meeting
```

## Components

- **`android/`** - optional native Android WebView shell that loads the hosted
  customer page. See [`android/README.md`](android/README.md).
- **`customer/`** - the device form and connection status page. It does not run
  the Webex SDK or capture media. The Vercel deployment serves a copy from
  `backend/public/customer/`.
- **`backend/`** - Vercel serverless orchestrator:
  - `POST /api/request-support` - creates a meeting, creates the WxCC task, and
    dials the configured RoomOS device through Cloud xAPI.
  - `POST /api/session` - verifies the agent request and exact task meeting,
    then returns the meeting details. The agent joins with their own Webex
    identity; the Service App token never leaves the backend.
  - `POST /api/end-task` - proxies the authenticated agent's task-end request.
  - Uses one consolidated Service App (`WEBEX_*`) for meeting scheduling, WxCC
    task creation, and RoomOS xAPI. It is auto-refreshed from environment
    credentials (see [`backend/lib/tokens.js`](backend/lib/tokens.js));
    `GET /api/refresh` is a Vercel Cron warm endpoint.
- **`widget/`** - WxCC agent desktop widget. `video-cc-widget.js` forwards the
  agent token and the task's meeting SIP into the video page.

## Standard Webex meeting requirements

The Service App creates each meeting with `POST /v1/meetings` and
`hostEmail=admin@canadacollab.wbx.ai`. That user must have a Webex Meetings host
license on a site managed by the Service App authorization. Agents must have
host privileges on the same site to become cohosts.

Required Service App permissions include meeting admin scheduling, WxCC task,
and RoomOS xAPI/device scopes. See [`backend/.env.example`](backend/.env.example)
for the exact list.

## Setup

1. **Backend**: deploy `backend/` to Vercel and set the variables documented in
   [`backend/.env.example`](backend/.env.example). Set the single Service App,
   `WEBEX_HOST_EMAIL`, WxCC routing values, and `ALLOWED_ORIGIN`.
2. **Device page**: use the HTTPS page served at
   `https://your-deployment.example.com/customer/index.html`. If hosting
   `customer/` separately, define `window.VIDEO_SUPPORT_API_ORIGIN` before
   loading `app.js` and add that origin to `ALLOWED_ORIGIN`.
3. **Android shell (optional)**: open `android/` in Android Studio, build, and run.
4. **WxCC Desktop Layout**: add the `video-cc-widget` and map its properties to
   the task data, e.g.:

   ```json
   {
     "comp": "video-cc-widget",
     "script": "https://your-deployment.example.com/widget/video-cc-widget.js",
     "properties": {
       "accessToken": "$STORE.agent.accessToken",
       "meetingSip": "$STORE.agentContact.taskSelected.callAssociatedData.videoMeetingSip.value",
       "taskId": "$STORE.agentContact.taskSelected.interactionId",
       "taskData": "$STORE.agentContact.taskSelected"
     }
   }
   ```

   Bind `meetingSip` to whatever task variable surfaces
   `channelParams.workItemData.videoMeetingSip` in your flow. The widget needs
   this exact value to join the customer's meeting. There is intentionally no
   "newest meeting" fallback because it can cross-connect concurrent customers.

   `taskId` and `taskData` keep the **task and the meeting in sync**:
   - When the video **meeting ends** (either side hangs up), the widget ends the
     WxCC **task** via `POST /api/end-task` (authorized with the agent token).
     This needs `taskId` (or `taskData`, from which the id is read).
   - When the agent **ends the task**, the widget detects it (the widget is
     disconnected, or `taskData` reports an ended/wrap-up state) and ends the
     **meeting** so the customer isn't left in a call. This needs `taskData`.

5. **JDS / Customer Journey widget** (optional): pop up the Cisco **Customer
   Journey Widget** (CJDS / Journey Data Service) alongside the video, so the
   agent sees the customer's history the moment the task is accepted — just like
   it appears for a voice call. It's Cisco's native `customer-journey-widget`
   component; you add it to the same Desktop Layout. See
   [`widget/jds-customer-journey.md`](widget/jds-customer-journey.md) for the
   ready-to-paste JSON block and placement.

## Security

- Never commit client secrets, refresh tokens, access tokens, certificates, or
  meeting passwords. Use Vercel environment variables or an external secret
  manager.
- Never send a Service App token to a browser or mobile client.
- Restrict `ALLOWED_ORIGIN` to exact trusted origins.
- Treat meeting links, SIP addresses, and passwords as sensitive session data.
- For production, verify that the authenticated agent is assigned to the WxCC
  task before returning its meeting details.

## Build checks

```bash
cd android
gradle wrapper --gradle-version 8.9
./gradlew assembleDebug
```

The backend uses Node.js 18 or newer and has no runtime package dependencies.
