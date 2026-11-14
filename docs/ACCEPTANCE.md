# IwacuMall — Release acceptance checklist

Use this checklist to review the storefront, admin dashboard, API, and Android client before a public launch.

## Website and API

- [ ] Store name, logo, contact details, and domain are correct.
- [ ] Storefront works on desktop and mobile browsers.
- [ ] Product names, descriptions, prices, images, categories, and stock match the approved catalog.
- [ ] Product quick view shows current details, available stock, quantity totals, add-to-cart, relevant category suggestions, and selectable gallery photos on web and Android.
- [ ] Customers can register, sign in, manage a cart, and place orders.
- [ ] Google sign-in works on the authorized production domain; admin accounts require password sign-in, and enabled MFA is verified at login.
- [ ] Production email verification, password reset and resend-verification flows work with the real sender.
- [ ] Temporarily unavailable SMTP delivery is retried from the outbox, expired account links are not sent, and queued tokens are absent from admin API responses.
- [ ] Browser sessions are HttpOnly, CSRF checks pass, and bearer tokens are not returned to browser JavaScript.
- [ ] Customers can view only their own order history.
- [ ] Administrators enroll MFA and can complete the documented recovery procedure.
- [ ] Administrators can manage products, categories, invoice payment methods, store settings, and fulfilment.
- [ ] Admins can upload up to eight product photos; the first photo appears as the catalog image and every thumbnail switches the quick-view image on web and Android.
- [ ] Replacing a Cloudinary-backed product gallery cleans up removed, unreferenced assets or clearly reports a cleanup failure.
- [ ] Manual payment confirmation and its audit record commit together.
- [ ] Paid orders can request returns after delivery within the return window saved at checkout; staff can approve or reject once, record received quantities, and restock only inspected eligible items once.
- [ ] Return requests, review decisions, receipt and stock changes appear in customer/store email events and the admin audit/inventory history; returned goods do not automatically trigger a cash refund.
- [ ] Order totals are calculated by the server and stock remains valid through order and cancellation flows.
- [ ] An overdue unpaid invoice expires, its reserved stock is restored once, and an audit event is recorded.
- [ ] Customers see the amount due, payment instructions, deadline and invoice after checkout.
- [ ] Delivery and payment wording matches the store's actual policies.
- [ ] Production hosting uses HTTPS, persistent database storage, backups, and monitoring.
- [ ] GitHub Actions CI passes for the release candidate; the Android artifact is an unsigned debug build and is not used as a store release.

## Android application

- [ ] The app launches on representative Android devices without crashes.
- [ ] It shows the same live products and prices as the website.
- [ ] Search, categories, cart, account, checkout, and order history work on mobile.
- [ ] Google sign-in succeeds with the package ID and signing certificate fingerprints configured for the app.
- [ ] Mobile checkout sends a valid payment method, displays the invoice instructions, and securely stores the session.
- [ ] The app uses the production HTTPS API and the intended application identifier.
- [ ] Signing, store listing assets, privacy disclosures, and required declarations are ready before publication.

## Store information required before launch

- [ ] Approved product catalog, prices, categories, photos, and stock levels.
- [ ] Manual payment account details and the staff payment-matching procedure.
- [ ] Delivery areas, charges, timelines, and refund/returns policy.
- [ ] Privacy policy, terms, tax details, seller legal identity and other required business information.
- [ ] Production domain, DNS/TLS, Atlas access/backup, SMTP sender and owner contacts.

## Current project boundary

This repository contains source code for the API, storefront and Flutter Android client. Production deployment, representative-device testing, release builds, real payment account setup, and owner-approved catalogue/policy content still require completion before launch. No payment gateway is included; invoice payments are confirmed by store staff.
