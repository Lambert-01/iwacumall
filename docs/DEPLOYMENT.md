# IwacuMall deployment guide

This guide prepares a deployment. It does not create a domain, Atlas account, SMTP account or production secrets. Confirm who owns each external service before configuring it.

## 1. Production prerequisites

- Node.js `>=22.13.0` and npm.
- A domain the store controls, DNS access and a valid HTTPS certificate.
- MongoDB Atlas cluster, database user with least privilege, and a narrow Atlas network access list for the application host.
- SMTP account and a verified sender domain/address. Configure SPF/DKIM and DMARC with the email provider’s instructions.
- Actual payment account names/numbers and approved payment instructions.
- Confirmed catalogue, delivery zones/rates, tax treatment, customer-support details and owner-approved policy text.
- A private secret manager or protected service environment for `.env` values.

## 2. Configure and install

```bash
cp .env.example .env
# Edit .env in a protected editor. Never commit or share it.
npm ci
```

Set these values before production startup:

- `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=4000`.
- `MONGODB_URI` from Atlas and `MONGODB_DB_NAME`. URL-encode special characters in credentials.
- Unique `COOKIE_SECRET` with at least 32 random characters. It encrypts admin TOTP secrets and one-time account email links while queued; back it up securely, drain or expire queued account emails, and plan MFA re-enrollment before rotating it.
- A real `ADMIN_EMAIL`, unique `ADMIN_PASSWORD` of at least 14 characters, and `ADMIN_NAME`.
- `APP_BASE_URL=https://<the-real-domain>`.
- Real `STORE_ADDRESS`, `STORE_PHONE`, and `STORE_EMAIL` or leave the optional email blank.
- `EMAIL_VERIFICATION_REQUIRED=true`, plus real `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`.
- Set `TRUST_PROXY_HOPS` to the number of trusted reverse proxies. Keep `CORS_ORIGINS` empty when browser and API share the same origin.

The app intentionally refuses production startup when required secrets, email, store contact or HTTPS URL still look like placeholders. On first startup it provisions the admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Sign in and enroll an authenticator before other admin features are available.

Start the API:

```bash
npm start
curl -fsS http://127.0.0.1:4000/api/health
```

Complete **Admin → Store settings** and add at least one manual invoice payment method. Set the customer return window to the period in the owner-approved return policy; `0` disables return requests. The window is snapshotted at checkout and begins when staff mark the paid order delivered. Checkout remains unavailable until a payment method, non-negative delivery fee and invoice deadline have been saved. Confirm a test order end to end before opening the site to customers.

Customers can request a return for a paid, delivered order during its saved return period. Staff review the request, then record which items arrived and which passed inspection for restocking. Receipt and stock changes are transactional and duplicate receipt is rejected. The return workflow does not send money. Admin refund actions record a refund that staff have already sent through the configured payment provider; keep its provider reference and record it separately from a return.

Invoice and order-status emails are written to the MongoDB outbox inside the order transaction and sent by the API process's background worker. The worker retries temporary SMTP failures; monitor the Admin email-delivery view and confirm both customer and store inbox delivery during staging.

Registration verification, verification resend, and password-reset messages also use this worker. Token issuance and outbox insertion commit in one MongoDB transaction. Their one-time tokens are encrypted in the outbox, removed after successful delivery or expiry, and excluded from the Admin email-job response. Password-reset tokens expire after one hour; verification tokens expire after 24 hours. Verify both links in staging using the real HTTPS domain and SMTP provider.

## 3. Optional legacy SQLite migration

Only migrate when legacy SQLite records need to be preserved. Stop the old app and create/verify a backup first. The default migration command is a read-only dry-run:

```bash
npm run migrate
```

Review counts and status mapping. The importer maps `CANCELLED` and `CANCELED` orders to fulfillment `CANCELLED` and payment `VOID`. It imports current SQLite product stock unchanged and does not restore stock for cancelled orders, so confirm the old database already applied any cancellation stock returns. For remote databases the write pass requires an explicit `--force`:

```bash
npm run migrate:write -- --force
```

Verify collection counts and representative orders in Atlas before switching traffic. Keep the original database backup according to the owner’s retention plan. Do not run the write command against production until the target cluster and backup have been independently verified.

## 4. Reverse proxy and domain

Create DNS records at the provider for the chosen domain and point them to the host. Issue TLS before customer traffic. Replace `YOUR_DOMAIN` in this example with the verified domain:

```nginx
server {
  listen 80;
  server_name YOUR_DOMAIN www.YOUR_DOMAIN;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name YOUR_DOMAIN www.YOUR_DOMAIN;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Use the certificate paths supplied by your TLS provider, keep port 4000 private, and set `TRUST_PROXY_HOPS=1` only when the app sees exactly one trusted proxy. The repository does not confirm ownership or registration of any domain.

## 5. Service management and data protection

Run the process under a dedicated unprivileged service user and a process supervisor such as systemd. Store `.env` outside version control with restrictive permissions. Enable automatic security updates and monitor `/api/health`, process restarts, database connectivity and email delivery without logging credentials, session tokens or reset links.

Enable Atlas backups and point-in-time recovery appropriate to the business. Document who can restore data, perform a restore rehearsal, and record recovery time/data-loss targets. Include the TOTP encryption key in the protected secrets backup. Limit staff access and rotate credentials when access changes.

## 6. Android build

Generate the Android scaffold once on a Flutter/Android SDK workstation:

```bash
cd mobile
flutter pub get
flutter run --dart-define=IWACUMALL_API_URL=http://10.0.2.2:4000
```

The Android scaffold and launcher icons are already included. The URL shown is for an Android emulator. For a physical device on the same Wi-Fi, bind the development server to `HOST=0.0.0.0`, allow the port through the computer firewall, and replace the URL with `http://<computer-LAN-IP>:4000`. Debug Android resources permit cleartext HTTP for development; the main/release network policy rejects it.

For a debug APK build, use `flutter build apk --debug --target-platform android-arm64`. For release, use the confirmed HTTPS API URL, verify the application ID `com.iwacumall.app` is appropriate, protect the signing key and `mobile/android/key.properties`, and prepare store listing assets and privacy/data-safety disclosures. The app rejects a release build configured with a non-HTTPS API URL. Release signing is not configured in this repository; test signed builds on a physical device before publication.

The repository has not yet been validated on a physical Android device or iOS. Do not use `flutter create` over the existing scaffold; regenerate only if intentionally rebuilding the platform project.

## 7. Owner completion checklist

1. Replace the preview catalogue and verify prices, inventory, images and product rights.
2. Add payment instructions using real merchant-owned account details; verify the process for matching a customer payment to an invoice.
3. Set delivery fee, delivery coverage, expected timing, tax rate only after confirming tax handling, invoice deadline, and the return window that matches the approved return policy.
4. Replace draft policy language with the legal seller identity, return/refund rules, delivery conditions, support process and retention periods. Review it for applicable Rwanda obligations.
5. Verify production email delivery, verification links, password-reset links, order invoices and the domain’s sender records.
6. Review access controls, MFA recovery, backup restoration, monitoring and incident contacts.
7. Run API, browser, accessibility and Android device verification in a staging environment before opening production traffic.
# Google sign-in setup

1. In Google Cloud Console, configure the OAuth consent screen and create a **Web application** OAuth client. Add `https://iwacumall.com` and `https://www.iwacumall.com` as authorized JavaScript origins if both names will serve the site.
2. Set `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_CLIENT_IDS` on the API host to that Web client ID. The ID is public; do not put a Google client secret in the storefront or Flutter app. The API verifies the signed ID token and its audience before creating a session.
3. For Android, create an **Android** OAuth client with package name `com.iwacumall.app` and the SHA-1 certificate fingerprints for debug and release signing. Keep the Web client ID configured as `GOOGLE_WEB_CLIENT_ID`; the Flutter app uses it as the OAuth server client ID when requesting a verifiable ID token.
4. Rebuild the Android app after adding the OAuth client. Test Google sign-in on a physical phone with the final signing certificate and a production HTTPS API URL.

Google sign-in creates customer accounts and links an existing customer account only after its email has already been verified in IwacuMall and Google returns that same verified email. Administrator accounts must continue to use the existing password plus MFA flow.

## Durable product photo uploads

1. Create a Cloudinary account and copy the cloud name, API key, and API secret into the private server environment as `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
2. Product photo uploads are disabled unless all three values are present. The admin accepts up to eight PNG, JPG, and WebP images per product, up to 8 MB each; the server checks each file signature and sends it to Cloudinary. The first photo remains the primary catalog image. The API secret stays server-side. Keep the Cloudinary account under the store owner's control and set billing/storage limits there.
3. New uploads use the `iwacumall/products/` public-ID prefix. Saving a replacement gallery removes prior Cloudinary assets when they have stored IDs and are no longer referenced; failed cleanup is reported in the admin UI. Legacy URL-only assets need manual review in Cloudinary.
4. If no Cloudinary account is configured, admins can continue to use HTTPS image URLs or repository assets. Do not save uploaded images to the app server's local disk for production; that filesystem may be temporary.
