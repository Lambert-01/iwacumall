# Update the IwacuMall VPS

This guide covers routine releases to the existing IwacuMall server. It is not a first-time server setup guide.

## Live deployment

- VPS: `185.2.101.46`, Ubuntu 24.04
- Repository: `/var/www/iwacumall`, branch `main`
- Service: `iwacumall.service`, runs as `iwacumall`
- Runtime: `/usr/bin/node` 22; production dependencies use `/usr/bin/npm`
- App bind: `127.0.0.1:4000`; Nginx proxies public traffic to it
- Store: `https://iwacumall.com`
- Admin: `https://admin.iwacumall.com` (opens `/admin`)
- Runtime environment: `/var/www/iwacumall/.env` (private; never commit or share)
- Database: MongoDB Atlas; product photos use Cloudinary when configured

The VPS output supplied by the owner confirmed Atlas connectivity, a healthy local API, Nginx proxying, DNS, and HTTPS certificates. Confirm public pages and customer workflows after each release; `/api/health` alone does not test checkout, email delivery, or sign-in.

## 1. Prepare and push a release from your computer

Make and review changes locally. Commit and push them to `main`:

```bash
git status --short --branch
git add path/to/changed-file another/changed-file
git commit -m "Describe the update"
git push origin main
```

Stage only intended source files. Do not commit `.env`, `.env.production`, signing keys, or passwords. Do not use `git add .` without checking `git status` first.

## 2. Pull the release on the VPS

Connect to the server, then check its current branch and save the current commit ID for rollback:

```bash
cd /var/www/iwacumall
sudo -u iwacumall git -C /var/www/iwacumall status --short --branch
sudo -u iwacumall git -C /var/www/iwacumall rev-parse --short HEAD
```

The working tree should be clean and the branch should be `main`. Copy the commit ID somewhere private so you can identify the previous release. Then pull only a fast-forward update:

```bash
sudo -u iwacumall git -C /var/www/iwacumall pull --ff-only origin main
```

If Git reports local changes or a conflict, stop and inspect `git status`. Do not run `git reset --hard`, discard files, or force a pull to make the error disappear.

## 3. Install dependencies when they change

Run this when `package.json` or `package-lock.json` changed. A frontend-only or server-source update with an unchanged lockfile does not require reinstalling packages.

```bash
sudo -u iwacumall env PATH=/usr/bin:/bin /usr/bin/npm --prefix /var/www/iwacumall ci --omit=dev
```

Keep using the system Node 22 installation at `/usr/bin/node`; do not use root's NVM Node 20 for the service.

## 4. Update production environment values only when needed

The VPS environment is separate from your computer's `.env`. Edit the VPS file directly only when a release adds, removes, or changes an environment setting:

```bash
sudo -u iwacumall nano /var/www/iwacumall/.env
sudo chown iwacumall:iwacumall /var/www/iwacumall/.env
sudo chmod 600 /var/www/iwacumall/.env
```

Compare required variable **names** with `.env.example`; do not copy the example file over the production file. Preserve real production credentials and values. Keep `APP_BASE_URL=https://iwacumall.com`, `HOST=127.0.0.1`, and `PORT=4000` unless there is a deliberate infrastructure change. Do not regenerate `COOKIE_SECRET` for a routine release: it encrypts queued authentication email tokens and administrator MFA secrets.

Validate config without displaying secrets:

```bash
cd /var/www/iwacumall
sudo -u iwacumall env PATH=/usr/bin:/bin /usr/bin/node \
  --env-file=/var/www/iwacumall/.env \
  --input-type=module \
  -e 'import("./server/config.mjs").then(({config:c})=>console.log(JSON.stringify({environment:c.nodeEnv,host:c.host,port:c.port,baseUrl:c.appBaseUrl,mongodbConfigured:Boolean(c.mongoUri),smtpConfigured:Boolean(c.smtpHost&&c.smtpUser&&c.smtpPass&&c.smtpFrom)}))).catch(e=>{console.error(e.message);process.exit(1)})'
```

Do not run `npm run admin:seed` for a routine deployment. It can reset the configured admin password and revoke active sessions.

## 5. Restart and verify

Restart only the IwacuMall service after pulling code or editing its environment. The app connects to MongoDB and completes startup work before opening port 4000, so a short fixed sleep can still get `connection refused`. Poll the health endpoint in an `if` condition instead. This also prevents a temporary failed `curl` from closing an interactive SSH shell when `errexit` is enabled.

```bash
sudo systemctl restart iwacumall
ready=0
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/api/health 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" -eq 1 ]; then
  printf '\nLocal API health check passed.\n'
  curl -fsS https://iwacumall.com/api/health
  printf '\n'
  curl -fsSI https://iwacumall.com
  curl -fsSI https://admin.iwacumall.com/admin
else
  printf 'IwacuMall did not open port 4000 within 40 seconds. Recent service logs:\n'
  sudo systemctl status iwacumall --no-pager -l
  sudo journalctl -u iwacumall -n 80 --no-pager -o cat
fi
```

The health response should report `"ok":true` and `"database":"connected"`. The admin page should return HTTP 200. For an interactive SSH session, do not paste `set -e` or `set -eu` before running the update commands: Bash will close that shell after any unexpected failing command. Conditional checks above allow the session to remain open and print useful service logs if startup fails.

To inspect a failed start separately:

```bash
sudo journalctl -u iwacumall -n 80 --no-pager -o cat
```

Do not paste `.env`, database URIs, SMTP passwords, cookies, or access tokens into chat or logs.

## Nginx and HTTPS changes

Normal app releases do not require an Nginx reload or a Certbot command. If you deliberately edit an IwacuMall Nginx file, validate before reloading:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The IwacuMall site files are `/etc/nginx/sites-available/iwacumall` and `/etc/nginx/sites-available/iwacumall-admin`. Do not edit another site's config, restart all services, change the global firewall, or replace certificates for other domains. Certbot is scheduled to renew IwacuMall's certificate automatically.

## Database and email changes

- Ordinary code updates do not require a manual database migration. If a release specifically calls for a migration, follow that release's instructions and confirm an Atlas backup first.
- Keep Atlas backups enabled and periodically verify that a restore can be completed. A healthy API response is not a backup check.
- Changes to email code or SMTP settings require a real email-delivery check. API health does not send a test email.
- Payment methods, delivery fees, invoice deadlines, and other store settings are managed in the admin interface unless a release explicitly says otherwise.

## Roll back a bad release

If the service fails after an update, inspect the logs before making more changes. Use the previous commit ID saved before the pull. If you need to restore it, stop the service, check out that commit, reinstall production dependencies if the lockfile changed, and start the service:

```bash
sudo systemctl stop iwacumall
sudo -u iwacumall git -C /var/www/iwacumall switch --detach PREVIOUS_COMMIT_ID
sudo -u iwacumall env PATH=/usr/bin:/bin /usr/bin/npm --prefix /var/www/iwacumall ci --omit=dev
sudo systemctl start iwacumall
sudo systemctl status iwacumall --no-pager -l
curl -fsS http://127.0.0.1:4000/api/health
```

Replace `PREVIOUS_COMMIT_ID` with the saved commit hash. A detached checkout is for recovery only. Before the next normal pull, return the checkout to `main` after confirming it has no local changes:

```bash
sudo -u iwacumall git -C /var/www/iwacumall switch main
sudo -u iwacumall git -C /var/www/iwacumall pull --ff-only origin main
```

If the update changed `.env`, restore the previous valid environment values separately; Git does not contain the production environment file.
