# IwacuMall — Deployment guide

## 1. Client VPS prerequisites

- Ubuntu server with Node.js 22.13+, Nginx and a domain that the Client controls.
- An operating-system user for the web service; writable `data/` directory, backed up off-server.
- Working DNS records and a TLS certificate (e.g. Let's Encrypt).
- Secure SSH access, firewall rules and a systemd service for uptime.

## 2. Install and configure

```bash
sudo mkdir -p /srv/iwacumall
sudo chown -R YOUR_DEPLOY_USER:YOUR_DEPLOY_USER /srv/iwacumall
# Transfer the source project into /srv/iwacumall, then:
cd /srv/iwacumall
cp .env.example .env
nano .env
npm test
npm start
```

Set `HOST=127.0.0.1`, `PORT=4000`, the correct `DATABASE_PATH`, unique admin email/password, and `SEED_DEMO_CATALOG=false` once you are ready to manage the real catalog. In `.env`, set `ADMIN_PASSWORD` before first boot. Never expose port 4000 publicly when using Nginx; open 80/443 and proxy internally.

## 3. Example systemd unit

`/etc/systemd/system/iwacumall.service`:

```ini
[Unit]
Description=IwacuMall full-stack e-commerce service
After=network.target

[Service]
Type=simple
User=YOUR_DEPLOY_USER
WorkingDirectory=/srv/iwacumall
ExecStart=/usr/bin/node --env-file=.env server/index.mjs
Restart=on-failure
RestartSec=4
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/iwacumall/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Make sure the paths/user are correct, the service can write the database and the Node executable path matches the installed version. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now iwacumall
sudo systemctl status iwacumall
```

## 4. Example Nginx reverse proxy

```nginx
server {
  listen 80;
  server_name iwacumall.com www.iwacumall.com;

  client_max_body_size 1m;
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

After DNS propagation, enable HTTPS (e.g. via Certbot). Use TLS/secure redirects and configure security headers in the reverse proxy as appropriate. **The domain `iwacumall.com` has not been verified as registered or controlled by the Client.** Replace the hostname unless confirmed.

## 5. Real Android phone / emulator testing

The Android client defaults to `http://10.0.2.2:4000` for an Android emulator. During development on a physical phone, pass a LAN IP and start the backend with `HOST=0.0.0.0` **only on a trusted test network**.

New Flutter projects usually define Android internet permission as needed. Check `android/app/src/main/AndroidManifest.xml` for:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Development HTTP may require temporary `android:usesCleartextTraffic="true"` in the `<application>` element, depending on the Android target and device. **Remove that allowance for production.** For release builds use an HTTPS API/domain.

```bash
cd mobile
flutter create --platforms=android --org com.iwacumall .
flutter pub get
flutter run --dart-define=IWACUMALL_API_URL=http://10.0.2.2:4000
flutter build appbundle --release --dart-define=IWACUMALL_API_URL=https://YOUR_HTTPS_DOMAIN
```

The client must provide/own the Play Console developer account and complete required verification, signing, privacy disclosures, app screenshots, review and any required testing. The Play fee is outside the development payment.

## 6. Mandatory pre-launch hardening

1. Replace demo products/prices; confirm logos, product licenses and real inventory.
2. Review Rwanda consumer/data-protection requirements with appropriate advisers; publish truthful terms, returns, privacy policy and store contact details.
3. Configure payment/delivery policy and rates. Only cash on delivery is presently implemented.
4. Improve session storage (secure OS storage on mobile, HttpOnly/SameSite cookies and CSRF controls for web); add account recovery, email verification and account deletion workflows.
5. Add automated database backups, restore rehearsals, monitoring, logs without sensitive data, rate limiting at reverse proxy, and incident response.
6. Review SQLite limitations and upgrade path to managed PostgreSQL if high usage or multiple servers are planned.
7. Establish staging/production separation, run Android device QA, browser accessibility testing and security review.
8. Add an audited payment gateway only after merchant credentials and a separate agreed scope.
