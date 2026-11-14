# IwacuMall

IwacuMall is a responsive shopping website and Flutter Android client backed by a Node.js API and MongoDB. Checkout creates a customer invoice with manual payment instructions; the store confirms incoming payments in the admin dashboard.

## Current implementation

- Responsive catalogue, categories, search, cart, customer accounts and order history.
- MongoDB Atlas persistence, password hashing, HttpOnly browser sessions, CSRF protection and secure token storage in the Android app.
- Email verification, password reset, optional administrator authenticator MFA and shared rate limiting across API instances.
- Server-priced checkout, stock reservation, configurable delivery/tax/deadline settings, printable invoices, manual payment confirmation and scheduled expiration with stock restoration for unpaid overdue orders.
- Admin screens for orders, fulfilment, products, categories, store settings and payment methods.
- Draft privacy, sale terms and delivery-policy pages that require owner completion before publication.

The product catalogue still contains demonstration items until the owner replaces them. The owner has deployed the app to an Ubuntu VPS at `https://iwacumall.com`, with the admin at `https://admin.iwacumall.com`. VPS output confirmed the API health endpoint and Atlas connection; public checkout, admin workflows and real email delivery still need owner verification.

## Requirements

- Node.js `>=22.13.0`
- npm
- MongoDB Atlas or a local MongoDB replica set (transactions require a replica set)
- Flutter and Android SDK for Android builds

## Local setup

```bash
nvm install
nvm use
cp .env.example .env
# Edit .env with an available MongoDB URI and local development settings.
npm ci
npm start
```

Open the storefront at `http://127.0.0.1:4000/`. Admin access uses the first administrator configured with `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD`. If that account already exists and needs to be synchronized from `.env`, run `npm run admin:seed`; this resets that account's password, revokes its current sessions, and preserves its MFA setting. Authenticator MFA is optional and can be enabled from **Admin → Store settings**.

Configure a payment method and the delivery fee and payment deadline in **Admin → Store settings**. Checkout stays disabled until a payment method, delivery fee and deadline are available.

Do not commit `.env`. The real `.env` file is not included in source review or setup guidance. Never paste database passwords, SMTP credentials or admin passwords into source files or issues.

## Environment configuration

`MONGODB_URI`, `MONGODB_DB_NAME`, `COOKIE_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `APP_BASE_URL` are required for production. Production also requires HTTPS, a real store address/phone, `EMAIL_VERIFICATION_REQUIRED=true`, and working SMTP settings. Use unique random secrets and URL-encode special characters in Atlas credentials.

Store address, phone, email, flat delivery fee, optional tax rate and payment deadline can be managed in the admin settings page. Payment instructions and account details are stored per payment method. No payment gateway is connected; staff must verify payments manually.

## Development and migration

```bash
npm run dev
npm test
```

The API tests use an isolated in-memory MongoDB when `mongodb-memory-server` can start. Do not point tests at production data. A dry-run SQLite importer is available with `npm run migrate`. Cancelled or canceled legacy orders map to `CANCELLED` / `VOID`; the importer leaves product stock as recorded in SQLite and does not restore inventory a second time. Review the cancelled-order count and confirm the old database already reflects cancellations, then take a verified SQLite backup before any remote write. Remote migration writes require the explicit `--force` flag:

```bash
npm run migrate:write -- --force
```

Run that command only after verifying the target cluster, database name, backup and dry-run report.

## Android client

The source is in `mobile/`. Generate the Android project scaffold once, resolve the Flutter dependencies, and run against the local API:

```bash
cd mobile
flutter pub get
flutter run --dart-define=IWACUMALL_API_URL=http://10.0.2.2:4000
```

The Android platform scaffold is already included. The URL above is for an Android emulator. For a physical phone on the same Wi-Fi, set the development server `HOST=0.0.0.0`, allow it through the computer firewall, and use `http://<computer-LAN-IP>:4000`. Debug builds permit local HTTP; release builds require HTTPS.

The app defaults to `https://iwacumall.com`; use the local API override in the run command above when developing against the emulator. Build the production APK after configuring the Android release signing key:

```bash
flutter build apk --release --target-platform android-arm64
```

The release app requires HTTPS. Google sign-in reads its web client ID from the production `/api/config`; the server must have `GOOGLE_WEB_CLIENT_ID` configured and Google's Android OAuth client must match `com.iwacumall.app` and the signing certificate SHA-1.

## Deployment and review

Use [docs/VPS_UPDATE.md](docs/VPS_UPDATE.md) for routine production updates. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md), and [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for technical context and remaining owner checks.

GitHub Actions runs the isolated API integration suite and JavaScript syntax checks on pushes and pull requests. A separate job analyzes Flutter and builds an unsigned arm64 debug APK, retained as a seven-day workflow artifact. CI uses no production secrets and does not deploy the site or publish the app.

The policy pages are drafts containing owner action notes. They must be completed with the seller’s legal identity, retention periods, delivery zones/times, returns/refunds and complaint rules before they are presented as final policies.
