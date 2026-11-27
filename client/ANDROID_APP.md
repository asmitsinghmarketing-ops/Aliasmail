# Nextspace Android app

The Capacitor app uses the production Nextspace service at
`https://mail.nexternconsultancy.com`. Its application ID is
`com.nexternconsultancy.nextspace`.

## Build locations

Large Android tools and caches stay on the D drive:

- Android SDK: `D:\mailer\client\android-tools\Sdk`
- Gradle downloads/cache: `D:\mailer\client\android-tools\Gradle`
- Microsoft OpenJDK 21: `D:\mailer\client\android-tools\Jdk21`

Create `android/local.properties` (it is intentionally ignored by Git):

```properties
sdk.dir=D\:\\mailer\\client\\android-tools\\Sdk
```

Then build a test APK from `client`:

```powershell
npm.cmd run app:apk
```

The resulting debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`.

## Production distribution

A release build must be signed with the organization's Android signing key. Never commit the
keystore, its passwords, `google-services.json`, an APNs key, or Firebase service-account JSON.
Native phone-style ringing additionally requires an FCM project and a native incoming-call service;
the Firebase configuration is deliberately not embedded until those organization-owned credentials
are supplied.

### Background incoming calls

The Android project includes an FCM receiver and a high-priority incoming-call notification with
Accept and Decline actions. To activate it, create a Firebase Android app for
`com.nexternconsultancy.nextspace`, download `google-services.json` into `android/app/`, and set the
matching service-account values on the server:

```env
FIREBASE_PROJECT_ID=your-firebase-project
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@your-firebase-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Neither file belongs in Git. Each user then opens **Settings → Notifications** once and taps
**Turn on notifications**. Calls can subsequently ring through Android while Nextspace is in the
background or its activity has been closed. Android may require the user to allow full-screen call
notifications in system settings; otherwise the same incoming call appears as a heads-up alert.

## Android navigation and system bars

The native Back button first closes the active dialog, meeting panel, message or compose layer. In
a team meeting it then minimizes the call; at the app root it moves Nextspace to the background so
the call is not ended accidentally. The Android activity also applies status-bar, display-cutout and
gesture-navigation insets around the WebView, and resizes it above the keyboard.

## Native Android screen sharing

The meeting Share button uses Android MediaProjection inside the installed app. Android always shows
its own consent picker, foreground notification, and screen-sharing status indicator. The captured
screen is limited to 960 pixels on its longest edge and eight frames per second before it enters the
existing WebRTC/SFU screen channel; this keeps bridge memory and phone heat bounded. Android 14+
allows the user to share either one app or the whole screen. Browser and iOS sessions continue to use
their normal browser capture or screenshot fallback.

## Releasing an update

From `D:\mailer`, run `npm run release:android` (or `npm run release:android -- --version 1.2`). It builds
the APK with the shared debug keystore, refuses to publish one signed with any other key, and replaces
`downloads/nextspace-android.apk`. Commit that file and `android/app/build.gradle`, then push; installed
apps offer the update by themselves. `npm run release:desktop` does the same for the Windows app.

Keep `android/gradle/wrapper/gradle-wrapper.properties` on `gradle-8.14.3-all.zip`: Android Gradle
Plugin 8.x fails on Gradle 9.6 and later.

If publishing fails with `EPERM`, your Windows account can't write to `D:\mailer\downloads`. Grant it
once from a terminal opened with **Run as administrator**:

```powershell
icacls "D:\mailer" /grant "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)M"
```
