# IwacuMall — Release acceptance checklist

Use this checklist to review the storefront, admin dashboard, API, and Android client before a public launch.

## Website and API

- [ ] Store name, logo, contact details, and domain are correct.
- [ ] Storefront works on desktop and mobile browsers.
- [ ] Product names, descriptions, prices, images, categories, and stock match the approved catalog.
- [ ] Customers can register, sign in, manage a cart, and place orders.
- [ ] Customers can view only their own order history.
- [ ] Administrators can add products, update catalog details and stock, hide products, and manage order status.
- [ ] Order totals are calculated by the server and stock remains valid through order and cancellation flows.
- [ ] Delivery and payment wording matches the store's actual policies.
- [ ] Production hosting uses HTTPS, persistent database storage, backups, and monitoring.

## Android application

- [ ] The app launches on representative Android devices without crashes.
- [ ] It shows the same live products and prices as the website.
- [ ] Search, categories, cart, account, checkout, and order history work on mobile.
- [ ] The app uses the production HTTPS API and the intended application identifier.
- [ ] Signing, store listing assets, privacy disclosures, and required declarations are ready before publication.

## Store information required before launch

- [ ] Approved product catalog, prices, categories, photos, and stock levels.
- [ ] Delivery areas, charges, timelines, and refund/returns policy.
- [ ] Payment gateway credentials if online payments are enabled.
- [ ] Privacy policy, terms, tax details, and other required business information.

## Current project boundary

This repository contains a working API/storefront MVP and Flutter Android source. Production deployment, representative-device testing, release builds, third-party integrations, and final catalog/policy content still require completion before launch.
