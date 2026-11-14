# IwacuMall implementation status

Last updated: 14 November 2026. This is a source review, not a production certification. External OAuth/domain/database setup and live end-to-end use have not been verified.

## Implemented in source

The isolated checks listed below cover only the cases named there; they are not end-to-end production verification.

- MongoDB repository and startup/index setup use a replica-set-compatible data layer. Dangerous user token TTL indexes are removed during startup and by `scripts/migrate-auth-token-indexes.mjs`; auth tokens are stored separately.
- Cookie sessions, CSRF checks, native bearer authentication, password hashing, email verification/reset flows, optional admin MFA, and shared MongoDB-backed fixed-window rate limits are present. Rate-limit keys are HMACed and expiry-indexed buckets are cleaned by MongoDB TTL.
- Checkout calculates totals on the server and transactionally reserves stock, writes the order, durable idempotency response, and invoice-email outbox event. Replays return the original order; conflicting reuse is rejected.
- Manual payment methods, invoice deadlines, stock release for expired/cancelled orders, payment confirmation, fulfillment updates, and audit records are implemented. Cancellation and overdue stock release now have isolated regression coverage.
- The server generates authorized PDF invoice bytes. The durable email outbox delivers invoice attachments and queues payment, fulfillment, cancellation, expiry and refund updates for customers and the store. The admin includes delivery status and retry/resend actions.
- Registration verification, verification resend, and password-reset emails use the retrying outbox. Token issuance and queue insertion commit together; link tokens are encrypted with the application secret while queued, redacted from admin responses, and purged after delivery, cancellation, or expiry.
- The storefront has paginated server-side catalogue search/filtering, product detail pages with server-rendered metadata, category URLs, sitemap/robots routes, and a real 404 response.
- Web and Android product cards open responsive quick views with stock-aware quantity selection, live totals, add-to-cart and selectable product-gallery photos. The web refreshes product data and same-category suggestions from the API; Android shows same-category recommendations that open another quick view.
- Google ID-token sign-in is wired for browser and Flutter clients, with server-side token verification, verified-email handling, customer-only account linking, session issuance and optional admin MFA. The web CSP allowlists Google Identity Services resources; OAuth client IDs and authorized origins still need owner configuration.
- Admins can upload up to eight PNG/JPG/WebP product photos to Cloudinary and replace a product gallery from the catalog editor. The API validates each photo and its Cloudinary ID, keeps the first photo as the backward-compatible primary image, rejects duplicate asset assignment, and attempts to clean up removed unreferenced assets. HTTPS image URLs and local catalog assets remain supported. Cloudinary account credentials are server-only.
- Admin product editing now includes category rename/archive, category reassignment, low/out-of-stock filters, reasoned stock adjustments and inventory history.
- Web and Android account settings include profile and saved-address management. Both surfaces expose session revocation, password change/reset and confirmed customer-account deletion with reauthentication; Android uses the default saved delivery address during checkout.
- Admin orders and customer order history support server-side load-more pagination; admin order filters are sent to the server.
- Android customers can fetch their authorized invoice PDF and open it in a PDF viewer or share it through Android's chooser. Web and PDF invoices display recorded refund totals.
- Paid orders support transactionally recorded partial/full manual refunds with a required provider reference, reason, audit entry and net-revenue calculation. This is a refund ledger; it does not send money or change inventory.
- Paid, delivered orders can request returns during the return window snapshotted at checkout. Admins can approve/reject requests, record returned and restockable quantities, and restock inspected items once inside the same transaction as receipt and audit records. Customer/store email events are queued. Cash refunds remain a separate manual process.
- Android platform files, launcher icons, secure token storage, checkout idempotency, API retry handling, and debug/release network policy are included.
- Production configuration rejects required example/placeholder credentials and addresses; Node runtime selection is pinned in `.nvmrc`.
- GitHub Actions CI runs JavaScript syntax checks and the isolated API suite, analyzes Flutter, and builds an unsigned arm64 debug APK artifact on pushes and pull requests. It uses no production secrets and does not deploy.

## Checks recorded from the 13 November snapshot

- `npm test`: **26 passed, 0 failed**, using an isolated in-memory MongoDB replica set. The suite covers checkout idempotency, cancellation/expiry stock restoration, PDF response bytes, email outbox delivery with a mock transport, auth, production placeholder validation, orders, and SEO routes.
- `flutter analyze --no-pub`: **No issues found**.
- `flutter build apk --debug --target-platform android-arm64`: **passed**; output is ignored at `mobile/build/app/outputs/flutter-apk/app-debug.apk`.
- `npm audit --omit=dev`: **0 reported production dependency vulnerabilities** at the time checked.
- `node --check` across server, scripts, tests, and browser JavaScript: passed.
- `git diff --check`: passed.

## Checks for the 14 November changes

- `flutter pub get`: passed with `google_sign_in` 7.1.1, which supports this checkout's Dart 3.6 SDK.
- Current Node server, repository, PDF, browser and script files passed `node --check`; `git diff --check` and Android manifest XML parsing passed after the latest changes.
- `npm test`: **29 passed, 0 failed** against an in-memory MongoDB replica set. Coverage includes gallery limits, Cloudinary ID validation, primary-image compatibility and ordering, return approval/receipt/restock once, checkout-time return-window snapshots, customer return-data sanitization, and the unconfigured Google sign-in gate. The first run found an outdated stock-edit expectation; the test now uses the audited stock-adjustment route.
- The multi-photo gallery, admin upload/edit flow and web quick-view photo selection passed `node --check`; `git diff --check` passed. Android gallery/recommendation source could not be analyzer-checked because the local Dart VM crashes; browser/Android interactions were not exercised.
- A CI workflow was added for fresh GitHub-hosted runners; it has not run because the workflow is not yet pushed to GitHub.
- Quick-view/recommendation, pagination/account, transactional auth-email outbox, Cloudinary cleanup, and Google CSP edits passed `node --check` for the changed server and browser files plus `git diff --check`.
- A fresh `flutter pub get` attempt while evaluating package-based invoice sharing crashed before dependency resolution because the bundled Dart VM hit `cpuinfo_macos.cc:42: unreachable code`. The final native invoice action uses Android's share/open intents and adds no Flutter package dependency.
- After the Android recommendation carousel change, `flutter analyze --no-pub` still could not start analysis: the bundled Dart VM crashed during macOS CPU initialization (`cpuinfo_macos.cc:42: unreachable code`). This is an environment/toolchain failure, not an analyzer diagnostic. An APK build was not completed in this turn; the new Android UI has not been analyzer-checked or device-tested.

The API suite does not exercise rendered web behavior, physical Android behavior, real Google OAuth, Cloudinary calls, SMTP delivery, or all of the recent account, order pagination, authentication-email outbox, refund, shared rate-limit and mobile PDF changes. The 13 November results above are an earlier snapshot.

The PDF test verifies generated bytes and the `%PDF-` signature, not visual layout across long/multipage invoices. Mail tests use a mock transport, not an SMTP server or real inbox. No Cloudinary API call, browser interaction/responsive screenshot, physical-device run, production build/signing, or live Atlas test was performed.

## Still incomplete in code

- Legacy Cloudinary URLs without a stored public ID cannot be cleaned up automatically. Cloudinary image transformations, crop presets and responsive thumbnail delivery are not configured.
- The refund ledger records a refund already issued outside IwacuMall. There is no payment-provider refund API; staff must issue any approved refund through their payment provider and record its reference.
- Real SMTP delivery and retry/recovery have not been exercised against a provider. Auth email tokens use `COOKIE_SECRET` encryption; drain or allow pending authentication-email jobs to expire before rotating that secret.
- Browser/accessibility checks, rendered PDF inspection, and physical-device testing remain. The Flutter source is still concentrated in `mobile/lib/main.dart`.

## Owner and production prerequisites

- Replace demo catalogue content with approved products, prices, stock, licensed photos, and useful descriptions.
- Configure and verify a MongoDB Atlas URI, database/network permissions, backups, and restore procedure.
- Configure a real HTTPS domain, hosting/process supervision, TLS, monitoring, and `APP_BASE_URL`.
- Set real store notification email and SMTP credentials; verify sender/domain DNS and authorized test inbox delivery.
- Add merchant-owned payment account details; confirm delivery fees/coverage, invoice deadline, tax handling, return window and inspection procedure, refunds, seller identity, privacy and terms.
- Create and protect Android release signing material; confirm application ID and store publication details. iOS scaffolding is not included.
- Create Google OAuth Web and Android clients, authorize the real domain, register the app package name and debug/release SHA-1 fingerprints, and place the public Web client ID in the private API environment as `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_CLIENT_IDS`.

## Security follow-up

An actual-looking MongoDB Atlas URI was present in the original `.env.example` and has been replaced with placeholders. If its password was real or that file was ever pushed/shared, rotate the Atlas database user's password and replace the URI in the protected runtime environment. Do not reuse the exposed password.

## Suggested next implementation order

1. Rotate/configure secrets and verify a staging Atlas deployment plus SMTP capture.
2. Configure Google OAuth and Cloudinary; validate sign-in, uploads, live category recommendations and product images on the real domain.
3. Verify SMTP delivery and outbox recovery; define return/approval/restock procedures and any owner-approved payment-provider integration.
4. Run the new CI workflow on GitHub; add browser/accessibility checks and review rendered multipage invoice layouts.
5. Build and exercise the Android app on a physical device; prepare the owner-controlled release signing key.
6. Complete owner-approved policies and business settings, then run the staging launch checklist in `docs/ACCEPTANCE.md`.
