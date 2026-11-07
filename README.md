# IwacuMall — E-commerce Website + API + Android Application

An integrated **source-code MVP** for the IwacuMall online store. It includes a responsive shopping website, an HTTP backend with a persistent SQLite database, an administrator dashboard and a Flutter Android shopping app wired to the **same backend**.

> **Status:** The Node.js API has passed automated end-to-end tests; browser assets and routes are present. The Android source has **not** been compiled or tested on a device in this environment (Flutter SDK is unavailable). This is not a deployed, payment-enabled, Play-Store-approved or production-hardened release.

## What is included

| Component | Implemented |
|---|---|
| Website storefront | Responsive landing page, category navigation, search, product cards, shopping cart |
| Customer accounts | Register, login, logout, saved sessions, protected order history |
| Checkout | Cash-on-delivery orders with customer contact/address and server-side stock validation |
| Database | SQLite schema for users, session tokens, categories, products, orders, line items |
| Administration | Product creation, stock changes, hide products, category creation, order statuses, basic metrics |
| Android app source | Flutter shop, search/category filters, product cards, cart, registration/login, checkout, order tracking |
| Branding | Blue/yellow IwacuMall logo integrated into web and mobile |
| Testing | Automated Node API workflow including stock restoration on cancellation |
| Deployment guidance | VPS/Nginx, HTTPS, database persistence, mobile build instructions |

### Deliberately not included / pending client inputs

**Not included yet:** live payment integrations (MTN MoMo, Airtel, cards), actual inventory/photos/prices, real delivery fees or tracking, email/SMS notifications, courier systems, Android APK/AAB build, Play Store publication, iOS app, inventory imports, or operational privacy/terms documents. These require additional client decisions, integration credentials, testing and/or separate scope approval. Seed products and their prices are **demonstrations**, not the client's real catalog.

## Project structure

```text
IwacuMall_FullStack_v1/
├── server/                 Node.js 22+ HTTP JSON API, SQLite schema, auth and orders
│   ├── index.mjs
│   ├── db.mjs
│   └── security.mjs
├── web/                    Fast, responsive HTML/CSS/JS storefront served by Node
│   ├── index.html          Shop
│   ├── app.js              Shop interactions, auth, cart, checkout
│   ├── admin.html          Administration
│   ├── dashboard.js        Admin and order history
│   ├── orders.html         Customer order history
│   ├── styles.css          Responsive blue/gold design system
│   └── assets/             Official selected logo + sample demo product art
├── mobile/                 Flutter source (Android native scaffold generated locally)
│   ├── pubspec.yaml
│   ├── assets/logo.png
│   └── lib/main.dart
├── tests/api.test.mjs      Functional API integration suite
├── docs/                   Architecture, deployment, acceptance checklist
├── package.json            No npm dependencies required to run web/API
└── .env.example
```

## 1. Run the website and API on a Mac, Windows or Linux computer

**Requirements:** Node.js **22.13+**, a terminal, and a modern browser. No npm packages required for the server or website.

```bash
cd IwacuMall_FullStack_v1
cp .env.example .env
```

Open `.env` and set a strong and unique `ADMIN_PASSWORD` (minimum 12 characters); set the real admin email/name. On Windows, copy the file using File Explorer or `copy .env.example .env`.

```bash
npm start
```

Now open:

- Storefront: `http://127.0.0.1:4000/`
- Admin dashboard: `http://127.0.0.1:4000/admin`
- Order history: `http://127.0.0.1:4000/orders`
- API health check: `http://127.0.0.1:4000/api/health`

**Initial admin:** When the server first starts, the email and password in `.env` create the administrator if the account does not already exist. If an admin account exists, restarting does not reset its password. Use that account on the storefront login to access `/admin`.

**Local database:** `./data/iwacumall.sqlite`, created automatically. Backup this database regularly when using real data. To reset demo data locally, stop the server and delete this file **only if you intend to permanently delete the local accounts and orders**.

### Run automated API tests

```bash
npm test
```

The tests use a temporary isolated database and do not modify your real store database.

## 2. Build the Android app (Flutter)

Flutter is not installed in this delivery environment; the Android app is **Flutter source code** and requires the Android project scaffold on the developer machine.

Install [Flutter](https://docs.flutter.dev/get-started/install), Android Studio and Android SDK, then:

```bash
cd mobile
flutter create --platforms=android --org com.iwacumall .
flutter pub get
flutter run --dart-define=IWACUMALL_API_URL=http://10.0.2.2:4000
```

`10.0.2.2` is the Android emulator's alias for the Mac/PC localhost. For a **real Android phone**, start the backend using `HOST=0.0.0.0` on the computer and pass its LAN IP:

```bash
flutter run --dart-define=IWACUMALL_API_URL=http://192.168.1.100:4000
```

Replace that sample IP with the computer's actual LAN address. Ensure both devices use the same private network and firewall rules permit development access. For local HTTP testing, temporarily allow cleartext traffic in your generated Android manifest; **never enable broad cleartext HTTP in the production version**. See `docs/DEPLOYMENT.md`.

For the published app (once HTTPS, Android signing and privacy compliance are ready):

```bash
flutter build appbundle --release --dart-define=IWACUMALL_API_URL=https://YOUR_DOMAIN
```

Google Play publication requires a developer account, signing, screenshots, app content declarations and Google review/possibly testing.

## 3. Production hosting

The website and API are **served from the same Node process** on port 4000, which simplifies routing and security. Use a reverse proxy such as Nginx with TLS. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for a working example and a hardening checklist.

## 4. Architecture and endpoints

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for request flows and the complete endpoint list.

## 5. Before a client handover

See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for a customer-to-admin acceptance checklist and outstanding items. Replace the demonstration catalog and policy text with approved store information before launch.

## Security and privacy

- Passwords use per-user salted **scrypt** hashes; sessions are stored by SHA-256 token hash.
- Login/registration are rate-limited in memory; all database queries use parameters.
- Order pricing and stock come from the server, not browser/mobile values; order inventory updates use SQLite transactions.
- Admin routes require the server-side `ADMIN` role.
- User tokens are currently stored in browser `localStorage` and Flutter `shared_preferences` to keep the starter simple. **Before handling real customer information, replace with a secure, reviewed session storage approach** (for example HttpOnly/SameSite cookies with CSRF protection for web and OS secure storage for mobile).
- The built-in `node:sqlite` API is experimental on the tested Node 22 runtime; review long-term database/platform choice for production scale.
- Require HTTPS, backups, monitoring, anti-abuse controls, secure CORS, privacy notices, and a security review before public launch.

