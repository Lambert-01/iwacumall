# IwacuMall: complete implementation prompt

You are the senior full stack engineer, Flutter engineer, product designer, and quality reviewer responsible for finishing IwacuMall. Work directly in this existing repository and deliver working implementation, organized screens, and evidence of verification.

Read this entire prompt and inspect the current checkout before editing. Implement the requirements in dependency order. Continue through the phases; a plan alone is not the deliverable. Preserve existing user changes and functional behavior. Make routine reversible engineering decisions yourself and document them. Ask for missing owner information when necessary while continuing independent work.

## 1. Project, business, and required outcome

- Project: IwacuMall.
- Repository: https://github.com/Lambert-01/iwacumall.
- Original local checkout: `/Users/apple/Desktop/IwacuMall`; use your actual current checkout if different.
- Store location supplied by the owner: Downtown Kigali, Rwanda.
- Store contact supplied by the owner: `+250788651421`.
- Primary currency: RWF. Preserve integer accounting for current RWF prices and amounts.
- Existing stack: Node.js HTTP API, official MongoDB driver, MongoDB Atlas, HTML/CSS/JavaScript storefront and web admin, and Flutter mobile source.
- Node requirement in the repository is at least 22.13.0. Select and document a supported compatible runtime consistently across local development, CI, and hosting.
- The customer website must work well on desktop, tablet, and mobile browsers. The native Flutter app must provide a complete Android shopping experience. Prepare iOS support if it is included in the agreed release, and state its build/device verification separately.
- Product data, prices, stock, customer accounts, orders, payment status, and invoices must use the shared backend and durable database.
- Maintain the existing stack unless a change materially improves the implementation. Explain substantial architecture changes and preserve existing URLs/data contracts through a migration or compatibility layer.

The required purchase flow is:

1. Customer browses real products and images, chooses quantities, and adds items to a cart.
2. Customer signs in or registers, verifies email when required, supplies delivery details, and selects a configured manual payment method.
3. The server validates the cart, calculates prices/fees/tax, reserves inventory, and creates one pending-payment order and invoice.
4. The customer sees complete instructions for paying after placing the order.
5. The server generates a real PDF invoice and schedules delivery to both the customer and the configured store email.
6. Customer pays manually using the stated account details and invoice reference.
7. Staff independently verifies received funds and records the payment reference in admin.
8. Staff advances fulfillment through the permitted states; the customer can see updated status and receive appropriate notifications.
9. Unpaid overdue invoices expire and release reserved stock exactly once. Cancellation, returns, and manual refunds follow explicit rules.

Implement this manual invoice payment model. Payment accounts must be confirmed by the owner. The store contact phone is not automatically the merchant payment account. Customers must never be able to mark their own orders paid.

## 2. Design direction and product organization

Use the supplied `website-desktop-preview.png` and `website-mobile-preview.png` as the visual references. Original paths were `/Users/apple/Downloads/website-desktop-preview.png` and `/Users/apple/Downloads/website-mobile-preview.png`. Inspect available copies. If references are unavailable in your environment, request them and continue unrelated implementation using the established visual system.

Preserve and improve the existing IwacuMall branding and logo assets. The visual language is:

- Primary blue: `#1455D9`.
- Deep navy: `#081F62`.
- Accent yellow/gold: `#FFC400`.
- Light canvas: `#F6F8FC`.
- White cards, rounded corners, restrained shadows, readable typography, clear spacing, and strong primary actions.
- Blue hero with prominent heading, yellow emphasis, useful supporting text, and the supplied brand artwork.
- Feature strip, organized category cards, product collection, shopping callout, and dark footer.
- Approximately four product columns on desktop, two on phone layouts, and adaptive intermediate layouts. Match reference proportions while keeping all text and controls usable.

Create a coherent design system shared in appearance across the website, native app, emails, invoice PDF, and admin. Define reusable spacing, colors, typography, borders, button styles, inputs, cards, status badges, and loading/error components.

Use clear shopping language and realistic content. Keep implementation notes and owner setup tasks inside admin or developer documentation. Production customer screens should present completed store information. Missing real information must be identified honestly in the owner setup checklist.

Verify layouts at representative widths including 360, 390, 768, 1024, and 1440 pixels. Avoid horizontal overflow, clipped prices, overlapping controls, obstructed dialogs, keyboard-covered fields, and tiny touch targets. Support keyboard navigation, visible focus, useful image descriptions, sufficient contrast, reduced motion, and screen-reader labels.

### Customer website

Organize navigation and pages for Home, Shop, Categories, Product details, Cart, Checkout, Account, Orders, Invoice, Support/contact, Privacy, Terms, and Delivery/returns information. Product/category/filter URLs must be shareable and browser navigation must behave predictably.

Product details should show usable photographs, name, category, description, price, stock/availability, quantity controls, and an obvious add-to-cart action. Show appropriate related items when available. Use a gallery when multiple product images are supported.

### Web administration

Use a consistent desktop sidebar and a practical mobile navigation pattern. Organize sections for Overview, Orders, Products, Categories, Inventory, Payments/invoices, Returns/refunds, Customers, Email delivery, Store settings, and Security/audit. Consolidate related sections where that makes the application clearer.

Provide useful filters, pagination, clear empty states, loading indicators, field validation, success/error feedback, and confirmation for consequential changes. Explain dashboard metric definitions and derive metrics from actual stored data. Distinguish gross sales, paid/delivered revenue, and refunds where applicable.

### Native Flutter app

Use native, polished screens with bottom navigation for Home, Cart, Orders, and Account. Provide product details, search/category filtering, complete checkout, invoice details/PDF actions, and customer support/policy access. Preserve the visual identity without forcing desktop layouts into the app. Handle safe areas, keyboard insets, long content, accessibility text scaling, and loading/offline/error states.

## 3. Reproduce and fix known review findings first

These findings came from the local review on 13 November 2026. Re-check the current files because line numbers and implementation may change.

1. **Account deletion through token expiry:** `server/db/mongo.mjs` creates TTL indexes on `users.emailToken.expiresAt` and `users.resetToken.expiresAt`. Two disposable user records were deleted completely when those tokens expired. Replace this design and remove dangerous indexes already installed in an existing database. Preserve user accounts when tokens expire. Separate token collections with TTL or explicit token cleanup are acceptable designs. Provide an idempotent migration and regression tests.
2. **Empty-database startup failure:** removing legacy user indexes before the collection exists raises MongoDB error 26, `NamespaceNotFound`. Make fresh initialization and repeated initialization safe without manual database preparation.
3. **Broken test foundation:** the API suite stops at that startup error and currently starts standalone in-memory MongoDB, while the application uses transactions. Use an isolated MongoDB replica-set fixture and reliable cleanup. Do not require access to production Atlas for tests.
4. **Duplicate orders:** identical checkout requests, even with the same `Idempotency-Key`, created distinct orders. Implement durable checkout idempotency and frontend submission protection.
5. **PDF missing:** `web/invoice.js` currently uses `window.print()`. Build actual PDF generation, authorized download, and email attachments.
6. **Store email missing:** checkout currently emails the customer only. Include the configured store recipient and complete payment-account details in both copies.
7. **Vulnerable email dependency:** the installed Nodemailer version at review was 6.10.1; a production dependency audit flagged it high severity. Check current advisories, choose a maintained patched compatible version, update the lockfile, and verify the mail flows. Do not blindly force dependency upgrades.
8. **Catalogue truncation:** both shopping clients load the default 80-product response and filter it locally. In a fixture containing 98 active products, 18 products were absent from that response. Implement pagination and search/filtering across the complete catalogue.
9. **Missing category display name:** product responses include `categorySlug` but not the `category` label read by the UIs. Fix the shared contract and both clients.
10. **Incomplete mobile packaging:** `mobile/` contains Dart source but no Android/iOS platform scaffold. Static analysis on a temporary copy found no errors and one minor lint; no device or release build was verified.
11. **Missing search-discovery routes:** `/sitemap.xml`, `/robots.txt`, and `/products/wireless-headphones` returned 404. Build sitemap/robots and real public product/category pages.
12. **Session/cart reliability:** browser user restoration depends on sessionStorage, stale products can remain in submitted carts after disappearing from the displayed cart, and mobile initialization can sign out users after temporary network errors.

Existing isolated checks passed for basic registration, cookies/CSRF, mobile bearer login, optional admin MFA, server-priced checkout, stock reservation, invoice ownership, manual payment confirmation, fulfillment, cancellation/expiry stock restoration, and concurrent overselling prevention. Preserve and strengthen these behaviors. Those checks do not establish production Atlas connectivity, actual inbox delivery, PDF rendering, browser interaction, or physical-device operation.

## 4. Existing files to inspect, modify, and preserve

Inspect these files and update the ones affected by the requirements. Use their actual current contents rather than assuming the review snapshot is unchanged.

| Area | Existing files |
| --- | --- |
| Runtime and configuration | `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `server/config.mjs` |
| HTTP and authentication | `server/index.mjs`, `server/auth.mjs`, `server/security.mjs`, `server/mfa.mjs` |
| Database and business data | `server/db/mongo.mjs`, `server/db/repository.mjs`, `server/db/seed.mjs` |
| Email | `server/mailer.mjs` |
| Storefront | `web/index.html`, `web/app.js`, `web/styles.css`, `web/overrides.css`, `web/assets/` |
| Administration/orders | `web/admin.html`, `web/dashboard.js`, `web/orders.html` |
| Invoices | `web/invoice.html`, `web/invoice.js` |
| Recovery and policies | `web/reset-password.html`, `web/reset-password.js`, `web/privacy.html`, `web/terms.html`, `web/delivery-policy.html`, `web/policy.js` |
| Flutter | `mobile/lib/main.dart`, `mobile/pubspec.yaml`, `mobile/analysis_options.yaml`, `mobile/assets/logo.png` |
| Tests and migrations | `tests/api.test.mjs`, `scripts/migrate-sqlite-to-mongo.mjs` |
| Handoff documentation | `README.md`, `docs/ARCHITECTURE.md`, `docs/VPS_UPDATE.md`, `docs/ACCEPTANCE.md` |

Inspect references to legacy `server/db.mjs` before changing or removing it. Preserve migration/import behavior and existing data compatibility. Keep demonstration seeding confined to explicitly configured development/test environments.

## 5. New files and sensible module structure

Create real modules where they improve cohesion and testing. The following paths are a proposed organization; equivalent clear organization is acceptable. Every created module must be implemented and integrated. Avoid unused skeletons and unnecessary layers.

Backend additions:

- `server/services/checkout.mjs`: order creation, idempotency, transactional stock reservation, and event/outbox creation.
- `server/services/invoices.mjs`: invoice snapshots, versions, and authorized document retrieval.
- `server/services/inventory.mjs`: stock movements, adjustments, and restocking rules.
- `server/services/refunds.mjs`: manual refund/return records and safe state transitions.
- `server/pdf/invoice.mjs`: real PDF rendering from persisted snapshots.
- `server/email/templates.mjs`: branded HTML and plain-text invoice, receipt, and status templates.
- `server/jobs/email-worker.mjs`: durable job processing, retries, leases, and graceful shutdown.
- `server/storage/index.mjs`, `server/storage/local.mjs`, and a configured production object-storage adapter when needed.
- `server/seo.mjs`: sitemap, robots, canonical/public-page metadata.
- Shared validation/routing/repository modules as the current large files are split by responsibility.
- `scripts/migrate-auth-token-indexes.mjs`: safe inspection/dry-run/apply migration for dangerous existing token indexes.
- Other explicit schema migrations needed for invoice snapshots, upload metadata, idempotency, stock movements, and the outbox.

Website additions:

- `web/product.html`, `web/category.html`, `web/account.html`, `web/404.html`, and support/contact content as needed.
- `web/catalogue.js`, `web/account.js`, and page-specific code where appropriate.
- `web/shared/api.js`, `web/shared/session.js`, `web/shared/cart.js`, and reusable UI helpers to prevent divergent auth/cart behavior across pages.
- Consolidated design tokens and component styling; remove conflicting duplication carefully.
- Generate `/sitemap.xml` and `/robots.txt` from real application configuration; avoid hardcoded invented domains.

Flutter organization:

- `mobile/lib/app.dart` and a minimal bootstrap in `main.dart`.
- `mobile/lib/core/config.dart`, `api_client.dart`, `session_store.dart`, and `app_theme.dart`.
- Typed models for products, categories, orders, invoices, payment methods, and store configuration.
- Feature folders such as `features/auth/`, `catalogue/`, `cart/`, `checkout/`, `orders/`, `invoices/`, and `account/`.
- Shared widgets for product cards, money formatting, status badges, images, loading/error states, and form controls.
- State management appropriate to this application's size, with clear ownership and testable boundaries.
- Generated/configured `mobile/android/` and `mobile/ios/` when included in scope.
- `mobile/test/` and `mobile/integration_test/` for meaningful critical-flow coverage.

Quality and operations additions:

- Focused backend tests for bootstrap/token safety, checkout concurrency/idempotency, auth/MFA, PDF/email, uploads, and SEO.
- Browser tests and responsive reference screenshots for the critical shopping/admin flows.
- `.nvmrc` or equivalent runtime pinning and `.github/workflows/ci.yml`.
- Local replica-set setup and deployment/process configuration appropriate to the selected host. Add a Dockerfile/Compose configuration if used and validate it.
- `docs/SETUP.md`, `docs/OPERATIONS.md`, and `docs/IMPLEMENTATION_STATUS.md`, or equivalent focused updates to the existing documentation.

## 6. Backend, transactions, and security requirements

- Keep the server authoritative for product availability, prices, order totals, delivery eligibility/charges, configured tax, payment status, and invoice state.
- Validate and bound request bodies, strings, arrays, quantities, money amounts, filters, sorting, pagination, and uploaded files.
- Reserve stock and create the order, checkout deduplication record, and required outbox events atomically where appropriate. Handle concurrency and transaction retries correctly.
- Persist idempotency per authenticated customer and key with a unique index and request fingerprint. Replays return the original outcome without another stock deduction or email event. Conflicting payloads with the same key receive a clear conflict response.
- Use deliberate payment/fulfillment/refund state transitions, guarded writes, and audit events. Prevent repeated stock restoration, repeated refunds, and duplicate payment confirmation.
- Preserve HttpOnly browser sessions, appropriate secure cookie settings, CSRF protection for cookie-authenticated mutations, and secure bearer storage for native clients.
- Enforce ownership on every customer order, invoice PDF, account, session, and refund-related endpoint. Enforce admin authorization on privileged operations, and require MFA at login when an administrator has enabled it.
- Tokens must be hashed where appropriate, single use when required, and explicitly checked for expiration. Expiring a token must preserve the user. Revocation/password changes must invalidate the intended sessions.
- Restore browser state from the actual session on initialization. Native network failures must not be treated automatically as an invalid session.
- Configure rate limits and trusted proxy behavior for the actual deployment. Use shared limits when multiple instances need coordinated enforcement.
- Keep secrets, tokens, signed download URLs, passwords, and sensitive personal details out of logs. Use useful request/error correlation and structured operational logs.
- Review dependencies and use official current documentation when updating integrations.

## 7. Products, photos, catalogue, and inventory

- Implement complete product create/read/update/archive/restore, including existing photos, descriptions, categories, pricing, stock, featured status, and availability.
- Support secure image upload with administrator authorization, bounded multipart parsing, file size/dimension limits, actual content validation, generated safe filenames, and appropriate image processing.
- Provide optimized product images/thumbnails, correct content types, useful alt text, and reliable fallbacks consistent with the site's content-security policy.
- Use durable production storage. A development local upload directory must not silently become ephemeral production storage.
- Validate external image URLs if supported and preserve legitimate URL lengths. Avoid unsafe server-side fetching of arbitrary URLs.
- Keep legacy `imageUrl` records compatible when introducing galleries/media metadata.
- Add category display names to shared API models. Support safe category editing/archive/reassignment.
- Implement paginated server-side search/filter/sort across the complete catalogue and correct empty/no-results states on both clients.
- Paginate admin lists and customer history. Product counts, order counts, and filters must refer to the intended complete datasets.
- Reconcile stale carts, price changes, disabled products, and stock changes before checkout, with clear customer feedback.
- Record meaningful inventory adjustments and order-related movements; expose low-stock and movement views to staff.
- Provide a practical catalogue import/setup path without inventing real products, merchant prices, stock, or licensed product photos.

## 8. Invoices, PDFs, manual payment, and refunds

- Generate real PDF bytes on the backend using a suitable maintained library. An authorized endpoint such as `/api/orders/:id/invoice.pdf` must return `application/pdf` with safe filenames and private caching behavior.
- Generate documents from persisted invoice snapshots. Record the seller/customer details, line items, prices, totals, currency, configured tax information, payment-account details, instructions, issue date, deadline, and unique invoice reference needed to reproduce the document later.
- Handle identifier collisions safely and preserve existing invoice references through migrations.
- Use branded, readable layouts with proper text wrapping, fonts, page breaks, multi-page item tables, and totals. Verify actual rendered PDFs.
- Provide web download/print and native authenticated download/share/print. Keep bearer tokens out of URLs.
- Use appropriate paid/void/expired/refund messaging and receipts. Expired or void invoices must not invite payment as if still pending.
- Preserve document history/versioning where status changes require another artifact. The customer and store must receive the same invoice version and attachment content for the same event.
- Implement accessible post-order payment instructions containing merchant account name, number, reference, amount, deadline, and support contact.
- Provide clear staff payment matching, reference/note recording, audit history, and confirmation notifications. Highlight suspicious repeated references for staff review as appropriate.
- Define returns and manual refunds with amounts, reasons, staff actor, external refund reference, status, and optional item return/restock decisions. Prevent over-refunds and duplicate restocking. Record actual externally performed refunds honestly.
- Document allowed transitions and edge cases, including overdue orders, partial refunds if supported, and paid orders that cannot be fulfilled.

## 9. Email delivery to both parties

- Add a dedicated configured store notification recipient, using a documented variable such as `STORE_NOTIFICATION_EMAIL`. Validate it before claiming invoice email readiness.
- Send customer and store messages separately with appropriate content. Attach the same complete PDF invoice to both. Do not expose recipients across unrelated customers.
- Include itemized order/customer details, full payment instructions/account details, totals, invoice reference, deadline, and correct application links.
- Create durable outbox jobs alongside the business event. Checkout should return once its durable work is recorded, without waiting for SMTP to finish.
- Use atomic job claiming/leases, bounded retries with backoff, attempt history, appropriate deduplication keys, and a failed-job state. Handle worker restarts safely. Document the delivery guarantees realistically, including SMTP retry limitations.
- Let admins see pending/sent/failed status and safely resend or retry. Store sensitive payloads with appropriate access and retention.
- Support verification/reset email and useful payment/fulfillment/cancellation/expiry/refund notifications without sending duplicate events on repeated requests.
- Provide plain text plus branded HTML. Escape dynamic content. Keep invoice links usable through a secure sign-in/return flow.
- Add realistic SMTP timeouts and a test transport/local SMTP fixture. Document sender verification and SPF/DKIM/DMARC setup for the chosen provider.
- Real inbox delivery must be verified separately when owner credentials and authorized recipients are available.

## 10. Complete customer accounts and mobile behavior

- Complete registration/login/logout, email verification/resend, successful password reset, password change, session management, profile/address management, and supported account deletion/anonymization.
- Respect retention needs for order records and disclose the implemented account-deletion behavior accurately.
- Make browser account state consistent across pages, new tabs, expiry, and logout.
- Implement explicit native request timeouts, bounded safe retries, useful server-error handling, and a responsive startup/loading screen.
- Keep native session tokens in OS secure storage. Separate offline errors from authentication failures. Handle revoked/expired sessions consistently.
- Refresh account verification and order history after login, app resume, checkout, and relevant emailed-link flows.
- Handle invalid stored state safely and reconcile cart persistence. Support reliable navigation/back behavior and useful pull-to-refresh/retry controls.
- Generate platform scaffolding carefully, preserving existing Dart/assets. Configure Android app identity, permissions, network rules, icons, build requirements, and secure release settings.
- Use the intended HTTPS API in release builds and document emulator/physical-device local-development URLs.
- Validate Android builds and actual app interaction. Set up iOS platform integration if included; report simulator/device/signing availability honestly.
- Document protected signing keys, release commands, app-store assets, privacy/support URLs, and remaining publication inputs.

## 11. Sitemap, SEO, links, and policies

- Implement real product/category pages, useful navigation, back-button behavior, and an appropriate 404 page with HTTP 404 status.
- Generate a valid sitemap containing canonical public URLs for the configured domain, including eligible active products/categories. Support scale/pagination of sitemaps when necessary.
- Serve valid robots configuration and reference the sitemap. Use explicit noindex controls for private/account/admin/invoice pages and documents where appropriate; access control must remain enforced independently.
- Add accurate page titles/descriptions, canonical links, social previews, and appropriate product structured data from actual catalogue values.
- Ensure important public product content is discoverable without relying only on an initially empty client-rendered grid.
- Test internal links, category/filter state, product URLs, email links, redirects, assets, and protected routes.
- Make seller identity, support details, delivery zones/times, returns/refunds, privacy, and terms editable/maintainable. Do not invent legal identity, tax obligations, policy approval, credentials, or a registered domain.
- Put incomplete owner information in an admin readiness checklist and document what must be approved before public release.

## 12. Configuration, deployment, and operational handoff

- Update `.env.example` and configuration validation for the complete application, storage, email/outbox, store notifications, domain, delivery, and optional infrastructure.
- Preserve the real `.env`; do not read, overwrite, print, commit, or reproduce its secrets. Use dedicated safe development/test configuration. If actual credentials are required, name the exact variables the owner must fill and continue the remaining implementation.
- Validate required production values and report setup errors clearly without exposing credentials. Add a safe readiness summary for administrators.
- Use isolated test databases and local/mock email/storage by default. Test tooling must fail safely rather than use production data as a fallback.
- Make schema/index migrations explicit, repeatable, and reviewable with dry-run/reporting. Do not run mutations against a live Atlas database without authorization and a verified backup plan.
- Prepare the chosen hosting/process configuration, environment documentation, health/readiness checks, graceful shutdown, worker lifecycle, and secure production headers.
- Document domain/DNS/TLS, Atlas access/backup, actual email sender verification, durable storage, application URL, and recovery procedures.
- Add operational monitoring for downtime, application errors, database readiness, failed email jobs, overdue processing, and storage issues.
- Include backup/restore and TOTP-key recovery, release/rollback steps, and exact development/staging/release commands.
- Preserve uncommitted work and provide a reviewable diff. Clearly identify newly created files that must be included in the repository-based deployment.
- Do not purchase services/domains, publish releases, alter live infrastructure, or send real emails as part of local implementation without the required authorization. Prepare concrete deployable artifacts/configuration and identify the external owner steps.

## 13. Verification and definition of done

Implement meaningful regression/integration checks rather than copying implementation logic into tests. Use the real routing/business code and an isolated replica set. Run required checks, fix discovered defects, and report exact results. Keep these acceptance cases visible in the implementation status document:

1. Fresh empty-database startup succeeds; restart is safe and preserves existing data.
2. Upgrading a database with the old dangerous token indexes is safe and repeatable. Expired tokens never remove users.
3. Verification, reset, resend, password change, logout, session revocation and account deletion behave correctly, including token expiry/reuse and unauthorized access.
4. Browser cookie/CSRF behavior, native bearer auth, administrator MFA/recovery, and ownership restrictions are tested without relying solely on security-bypassing test mode.
5. Products, category names and photos display on web/native clients; newly uploaded and edited images survive the intended persistence/restart scenario.
6. Search/category filters and pagination expose products beyond the old 80/100-item boundaries and older orders beyond existing history limits.
7. Cart additions, quantity changes, removals, stale/unavailable products, price changes and out-of-stock states work in both clients.
8. Checkout totals come from the server. Client-submitted prices/totals cannot change charges.
9. Concurrent checkout cannot oversell. Replaying the same checkout key returns the same order; conflicting reuse is rejected; a timeout/retry does not duplicate orders, stock deductions, or outbox events.
10. Payment confirmation and fulfillment enforce valid transitions and write the intended audit history.
11. Cancellation and overdue expiry restore inventory once, including concurrent/repeated processing.
12. Refund/return records cannot exceed allowable amounts or duplicate restocking.
13. Invoice PDF endpoints return valid, readable PDF files with correct values, safe authorization, and correct ownership on browser and native clients.
14. PDF layout is inspected for short/long/multi-page invoices and long customer/product/account text.
15. Local SMTP capture proves customer AND store recipients receive complete invoice content and the same expected PDF attachment/version.
16. Worker failure, restart, retries, deduplication, failed-job visibility and administrator resend are tested. Verify the stated delivery guarantees rather than assuming them.
17. Real SMTP inbox delivery is recorded only after an authorized real-provider check.
18. All intended page URLs/links work. Sitemap/robots are valid; public product/category pages, metadata, noindex controls and proper 404 behavior are verified.
19. Desktop and phone-sized browser flows are exercised through product discovery, cart, sign-in, checkout, invoice download, order history and admin operations.
20. Representative responsive screenshots are compared with the supplied visual references. Check focus, keyboard/touch behavior, long content and visual consistency.
21. Flutter analysis and meaningful app tests pass; Android builds are produced with documented build mode/signing status. Physical-device/emulator behavior is recorded explicitly.
22. Mobile startup/offline errors, expired sessions, email-return flows, image failures, checkout retries, order refresh, and PDF actions are verified.
23. Dependency audit results are recorded with fixes or specific unresolved advisories and their assessed relevance.
24. CI exercises the implemented critical checks using safe services/configuration. Tests do not use production credentials.
25. Deployment, backup/restore, domain, storage, email, signing and owner-content prerequisites are documented and tracked separately from implemented code.

Do not label source presence, HTTP 200 alone, mock SMTP acceptance, static analysis, unsigned builds, or screenshots as proof of an entire production workflow. Mark each acceptance item as implemented and verified, implemented but unverified, or blocked by a specific missing external input.

## 14. Execution order and final delivery

Work through these phases in sequence, retaining useful progress between them:

1. Inspect source and existing changes; record the starting state and confirm the reference design.
2. Fix database safety, fresh initialization, test fixtures, and affected dependencies.
3. Complete transactional checkout/idempotency, state transitions, and inventory rules.
4. Implement invoice snapshots/PDF generation, durable email delivery to both recipients, and manual payment/refund operations.
5. Complete catalogue/image management, customer accounts, storefront/public pages and organized admin screens.
6. Complete the organized Flutter application and platform/build configuration.
7. Finish sitemap/SEO, configuration, owner setup, deployment/operations and documentation.
8. Run the meaningful backend, browser, PDF/email, and mobile acceptance checks; fix failures and record remaining external blockers.

Provide working files and clear documentation. Keep status updates concise and tied to completed behavior. If context becomes limited, update `docs/IMPLEMENTATION_STATUS.md` with exact completed work, current files, verification results, next actions, and blockers so implementation can continue without restarting.

Your final handoff must include:

- A plain-language description of delivered customer, admin and mobile workflows.
- Changed/new files grouped by purpose.
- Exact install/start/test/worker/build commands and local routes.
- Actual test/build/PDF/email/browser/device evidence and any failures.
- Required owner inputs: real catalogue/photos/stock, merchant account instructions, store notification email/SMTP, delivery/policy details, domain/hosting/Atlas/storage credentials, and mobile signing/publication details.
- Specific remaining work and an evidence-based progress assessment. Do not claim public-launch readiness until the required operational and real-environment checks are complete.

Begin by inspecting the repository and fixing the database account-expiry and empty-database startup defects. Continue implementing the entire requested scope.
