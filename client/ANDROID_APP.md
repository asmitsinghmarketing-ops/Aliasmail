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
