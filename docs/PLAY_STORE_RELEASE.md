# Android Play Store release

This repository builds the IwacuMall Android app as a signed Android App Bundle (AAB). Google Play prefers AAB uploads and signs the APKs delivered to users through Play App Signing.

## Local signing setup

The current workspace reads the signing properties from `honest-release-signing-files/key.properties` and the keystore from that same ignored folder. The folder and its files are excluded from Git and have owner-only permissions. Keep an encrypted backup of the keystore and its passwords somewhere separate from this computer. Losing an upload key means requesting a reset in Play Console.

The supplied upload certificate fingerprint is:

```text
SHA-1:   3D:7F:02:DC:78:DB:4D:C9:4A:55:3B:19:DC:CE:AD:A4:F1:36:C1:91
SHA-256: 59:F8:70:DB:4A:61:D4:70:79:F3:83:CB:5F:EE:59:83:52:4A:E5:21:3A:9F:B6:AB:C4:BF:16:05:44:05:8F:73
```

The supplied directory is named `honest-release-signing-files`. Confirm this is the intended IwacuMall upload key before the first Play upload. Use a dedicated key if those files belong to another app.

## Build the upload bundle

Use a current stable Flutter SDK, Android SDK platform 36, and JDK 17. The Android build is configured for API 36, which Google Play requires for new Android apps and updates submitted from August 31, 2026.

```bash
cd mobile
flutter --version
flutter pub get
flutter build appbundle --release
```

The output should be:

```text
mobile/build/app/outputs/bundle/release/app-release.aab
```

The current app version is set in `mobile/pubspec.yaml` as `1.0.2+3`. Increase the build number after each upload. Never put passwords or keystore bytes in Gradle files, GitHub, a release attachment, or a public artifact.

The Android minimum SDK is 24 to meet Google Play automatic protection's minimum-version requirement.

## Google sign-in for release builds

The Android package name is `com.iwacumall.app`. In the same Google Cloud project as the existing web OAuth client:

1. Create an Android OAuth client for `com.iwacumall.app` using the upload SHA-1 above.
2. Keep the Web application client ID configured on the server as `GOOGLE_WEB_CLIENT_ID`; the mobile app fetches this public client ID from `/api/config` and sends its ID token to the API.
3. Ensure the server's `GOOGLE_CLIENT_IDS` accepts that Web client ID so the API can verify the ID token audience.
4. After the first AAB is enrolled in Play App Signing, copy the app-signing SHA-1 from Play Console's **App integrity** page and add a second Android OAuth client for the same package and that SHA-1. The upload key and Play app-signing key are different certificates.
5. Test Google sign-in with an app installed from the Play internal/closed testing track. A sideloaded build only checks the upload certificate; a Play-installed build uses Google's app-signing certificate.

Do not put the Google OAuth client secret in the Flutter app. Only the public Web client ID is used by the mobile client.

## Play Console checklist

- Create the app using package ID `com.iwacumall.app`, enable Play App Signing, and upload the signed AAB to **Internal testing** first.
- Add the store listing: app name, short and full descriptions, 512×512 icon, 1024×500 feature graphic, phone screenshots, category, support contact, and countries/regions.
- Complete the App content forms: privacy policy, Data safety, app access instructions, ads declaration, target audience, content rating, and any applicable financial/features declarations.
- Give reviewers a working customer test account and clear instructions. Keep it active and make sure email verification or other sign-in steps do not block review.
- Enter the public privacy policy URL: `https://iwacumall.com/privacy`.
- Enter the external account deletion URL: `https://iwacumall.com/delete-account`. It explains app/website deletion and an email route for people who cannot sign in.
- Check that both pages load over HTTPS in a private browser window before entering them in Play Console. Deploy the current repository changes first; the URLs will not serve the new pages until the VPS is updated.
- Use this source-based Data safety inventory as a draft, then compare it against the final APK/AAB and each provider's current SDK behavior:
  - **Personal info:** name, email address, phone number, physical delivery address, and account/user identifiers.
  - **Authentication info:** account password verifier and sign-in/session credentials; passwords are hashed on the server and native session tokens use Android secure storage.
  - **Financial info and purchase history:** invoice totals, selected payment method, order items/status, and a payment/refund reference recorded by the store. The app does not collect card numbers, bank passwords, or mobile-money PINs.
  - **Other user-provided details:** saved delivery addresses, checkout notes, return reasons, and support messages.
  - **Purposes:** account access/security, checkout, delivery, invoicing, payment confirmation, returns/refunds, and customer support.
- Google Play's “shared” answer has specific exclusions for service providers and some user-initiated transfers. Identify which transfers fall under those definitions rather than automatically marking every processor transfer as sharing. The policy names Google Sign-In and the configured processors.
- The current Android manifest requests internet access only. The app has Google Sign-In but no ad or analytics SDK in its direct Flutter dependencies. Do not declare location, contacts, camera, microphone, or advertising ID collection based on the current app. Re-check transitive SDKs and all server/provider behavior before certifying the form.
- Mark account deletion as available both in-app and on the web. The account and authentication data are deleted immediately; contact details for an active order remain only until transaction and return handling are complete, after which stored direct identifiers are erased. A minimized accounting record is retained for the statutory period where required. The implementation currently uses a calendar fiscal year and purges those records after ten years starting January 1 following the relevant fiscal year; confirm the store's applicable fiscal year and retention obligations before release. Rwanda's published tax-procedures law states this period for applicable books and records ([Rwanda Revenue Authority source](https://www.rra.gov.rw/fileadmin/user_upload/NEW_TAX_PROCEDURES_LAW_2023.pdf)).
- Run the closed test before production. Personal Play Console accounts created after November 13, 2023 need at least 12 testers continuously opted in for 14 days before applying for production access.
- Before each later release, increase the build number and use the same registered upload key (or complete an upload-key reset through Play Console if it is lost).

## Verified local release build

On November 15, 2026, Flutter 3.27.4 and JDK 17 successfully built `mobile/build/app/outputs/bundle/release/app-release.aab` for package `com.iwacumall.app`, version `1.0.2` (version code `3`) and minimum SDK 24. The bundle passed `jarsigner` verification and is signed with the upload certificate fingerprint above. The AAB is a local build artifact under the ignored `mobile/build/` directory; build it again with the commands above when preparing another release.

The build reported that the project selects Android NDK `26.1.10909125` while several plugins request `27.0.12077973`. The build completed successfully. Consider aligning `ndkVersion` with the plugin requirement before the next release build.
