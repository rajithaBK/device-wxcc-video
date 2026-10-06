# JDS / Customer Journey widget on the Agent Desktop

Add Cisco's **Customer Journey Widget** (CJDS / Journey Data Service, "JDS") to
the WxCC Agent Desktop so it **pops up in the interaction panel the moment a task
is accepted** — the same way it appears for a voice call. It shows the customer's
timeline of past events (calls, chats, emails, custom events) plus a profile
summary.

This is a native Cisco web component (`customer-journey-widget`). You don't host
anything — you just add a block to your **Desktop Layout JSON** in Control Hub.

---

## Prerequisites

1. **CJDS must be provisioned for your org.** It is part of the Flex 3 Standard
   Agent license.
   - Org created **before ~Mar 2025**: CJDS is auto-linked to your WxCC Org ID —
     no action needed.
   - Org created **after ~Mar 2025**: request provisioning (Cisco form); a
     journey tenant is created within ~72h.
2. In **Control Hub → Contact Center**, make sure the **Webex Contact Center
   connector** is toggled on for the journey project (so WxCC events flow in).
3. You need an admin who can edit **Contact Center → Desktop Layouts**.

> The widget looks the customer up by **identity** (email / phone) taken from the
> interaction. For our **video** task, make sure the task carries a usable
> customer identity (e.g. the customer's email in `workItemData.email`, or an
> ANI). If the journey shows "no events", it means CJDS has no events published
> for that identity yet — the widget itself is working.

---

## The block to paste

In **Control Hub → Contact Center → Desktop Layouts**, open (or download) the
layout assigned to your agent team. In the **`panel`** area you'll find an
`md-tabs` component whose children are `md-tab` / `md-tab-panel` pairs (this is
the interaction/aux pane — the same pane your `video-cc-widget` shows in). Add
this pair as a **sibling tab** there. Do this in each persona section your team
uses (`agent`, and `supervisorAgent` if applicable).

```json
{
  "comp": "md-tab",
  "attributes": { "slot": "tab", "class": "widget-pane-tab" },
  "children": [
    { "comp": "span", "textContent": "Customer Journey" }
  ]
},
{
  "comp": "md-tab-panel",
  "attributes": { "slot": "panel", "class": "widget-pane" },
  "children": [
    {
      "comp": "customer-journey-widget",
      "attributes": {
        "show-alias-icon": "true",
        "condensed-view": "true",
        "use-new-momentum-icons": "true",
        "is-visual-rebrand-enabled": "true",
        "is-momentum-v2-enabled": "true"
      },
      "properties": {
        "interactionData": "$STORE.agentContact.taskSelected",
        "bearerToken": "$STORE.auth.accessToken",
        "organizationId": "$STORE.agent.orgId",
        "dataCenter": "$STORE.app.datacenter"
      },
      "wrapper": {
        "title": "Customer Journey Widget",
        "maximizeAreaName": "app-maximize-area"
      }
    }
  ]
}
```

- `interactionData: $STORE.agentContact.taskSelected` is what makes it
  **auto-populate for the active task and pop up on accept**. It overrides any
  static `customer` attribute.
- `bearerToken`, `organizationId`, `dataCenter` are pulled from the Desktop store
  automatically — leave them as `$STORE.*`. `dataCenter` resolves to your pod
  (this org is **`prodca1`**), so you don't hard-code it.

Save/upload the layout, assign it to the agent team, then refresh Agent Desktop.
The **Customer Journey** tab appears in the interaction pane on the next accepted
task.

---

## If the tab shows but the component doesn't render

For GA orgs the desktop registers `customer-journey-widget` natively, so no
`script` is needed. If your desktop build doesn't, load it explicitly from the
pod CDN by adding a `script` to the component (this org = `prodca1`):

```json
{
  "comp": "customer-journey-widget",
  "script": "https://journey-widget.ciscoccservice.com/journey-widget/prodca1/index.js",
  "attributes": { "...": "same as above" },
  "properties": { "...": "same as above" }
}
```

Other pods (use the one matching your org): `produs1`, `prodeu1`, `prodeu2`,
`prodsg1`, `prodanz1`, `prodjp1`, `prodin1`, `prodca1` (see Cisco's CJDS v10
README for the full CDN list).

---

## Alternative: always-available from the side nav

If you also want the journey reachable from the left side-nav (not only on an
active interaction), add a `nav` + `page` entry with `enable-user-search: true`
so the agent can look up any customer. See the "side nav" snippet in Cisco's
CJDS v10 README (`CiscoDevNet/cjaas-widgets`, `CustomerJourney`).

---

## Useful optional attributes

| Attribute | Purpose |
| --- | --- |
| `time-frame` | Initial range: `"All" \| "24-Hours" \| "7-Days" \| "30-Days"` |
| `limit` | Number of timeline events to show (default 20) |
| `disable-event-stream` | `"true"` to turn off real-time event streaming |
| `enable-user-search` | `"true"` to let the agent search other customers |
| `hide-profile-name` | `"true"` to hide the profile name/alias header |
| `cad-variable-lookup` | Name of a CAD variable to use as the lookup identity |
| `template-id` | Custom profile template id |

Reference: Cisco **Customer Journey Widget Version 10** README
(`CiscoDevNet/cjaas-widgets` → `CustomerJourney`) and the Help Center article
"Customer Journey Widget Version 10 for Webex Contact Center".
