# Video Support (Android)

A thin native Android app that hosts the device **video support** page
([`customer/index.html`](../customer/index.html)) in a full-screen `WebView`.

The page collects the customer's name and year of birth, then calls the backend.
Meeting audio/video runs on the configured RoomOS device, so the Android
WebView does not request camera or microphone access.

## Configure

Set the hosted page URL in
[`app/src/main/res/values/strings.xml`](app/src/main/res/values/strings.xml)
(`support_page_url`). It must be served over **HTTPS**. Make sure the backend's `ALLOWED_ORIGIN`
includes the page's origin (see [`../backend/.env.example`](../backend/.env.example)).

## Build & run

If the Gradle wrapper scripts are not present, generate them or open the
`android/` folder in Android Studio:

```bash
cd android
gradle wrapper --gradle-version 8.9
./gradlew assembleDebug        # or: ./gradlew installDebug
```

Then launch the app and tap **Get Started**.

## Flow

```
Submit form -> page POSTs /api/request-support
            -> backend creates Webex meeting
            -> backend creates the WxCC video task
            -> backend dials the RoomOS device through Cloud xAPI
            -> routed agent joins the same meeting in Contact Center
```
