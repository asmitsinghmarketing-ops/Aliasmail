# AliasMail

A Gmail-style webmail that splits **one** paid mailbox (e.g. a GoDaddy `abc@abc.com`) into
separate inboxes, one per **alias**. Give each person an alias such as `john@abc.com`. They sign in
and see only the mail sent to that alias, and they can send mail as that alias. An admin panel
manages the aliases and every message in the mailbox.

```
GoDaddy mailbox abc@abc.com  ──IMAP──▶  server (sync every 60s)  ──▶  john@abc.com  sees mail to john@
   ▲ aliases: john@, sara@, …   ◀─SMTP── sends "From: john@abc.com"  ──▶  sara@abc.com  sees mail to sara@
                                                                    ──▶  admin        sees & deletes everything
```

## How the filtering works

The server reads the INBOX over IMAP and caches each message's headers in `server/data/db.json`.
A message belongs to an alias when the alias appears in `To`, `Cc`, `Bcc`, `Delivered-To`,
`X-Original-To`, `Envelope-To` or `X-Forwarded-To`. Read and starred state is tracked
**per alias**, so people don't affect each other.

Deleting:
- **Alias user:** if the message reached only their alias, it is moved to the mailbox's Trash.
  If it also reached another alias, it is only hidden for that user.
- **Admin:** moves to Trash, or deletes permanently when "skip Trash" is ticked.

## Setup

1. In GoDaddy (Email & Office dashboard), create the aliases on your mailbox (`john@abc.com` → `abc@abc.com`).
2. Configure the server:
   ```bash
   cd server
   cp .env.example .env     # then fill in MAIL_USER, MAIL_PASSWORD, ADMIN_PASSWORD, JWT_SECRET
   ```
3. Install and run (from `mail/`):
   ```bash
   npm run install:all
   npm run dev              # API on :4000, web app on http://localhost:5173
   ```
4. Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Click **Test connection**, then go to **Aliases → Add alias**,
   set a password, and give that alias and password to the person.

Production: `npm run build && npm start` serves the built app and the API together on `PORT`.

### Mail server settings

| Provider | IMAP | SMTP |
|---|---|---|
| GoDaddy Workspace / Professional Email | `imap.secureserver.net:993` (SSL) | `smtpout.secureserver.net:465` (SSL) |
| Microsoft 365 from GoDaddy | `outlook.office365.com:993` | `smtp.office365.com:587`, `SMTP_SECURE=false` |

Microsoft 365 often has basic (password) auth for IMAP/SMTP turned off. If login fails, enable
"Authenticated SMTP" / IMAP for the mailbox in the admin center, or use GoDaddy Professional Email.

To send *as* an alias, the provider has to accept that alias as the From address. Aliases on the
same mailbox normally work. If sending fails with a "sender not allowed" error, check the alias in GoDaddy.

## Project layout

```
server/  Express 5 API: IMAP sync (imapflow), parsing (mailparser), sending (nodemailer), JWT auth
  src/mailbox.js      IMAP/SMTP: sync, fetch, delete, send
  src/aliases.js      alias model + per-alias filtering
  src/routes/mail.js  alias user API (inbox, starred, sent, compose)
  src/routes/admin.js admin API (aliases, all mail, sync, delete)
client/  React + Vite UI (Gmail-style mailbox + admin console)
```

## Going live on GoDaddy

### Keep the GoDaddy Node app and use PHP for mailbox access

If Node.js Hosting blocks IMAP/SMTP but another GoDaddy hosting account can reach the mailbox,
deploy `php-mail-bridge/index.php` on that account over HTTPS. The browser continues to use the
Node app's existing API; the Node API sends mailbox operations to the PHP bridge over HTTPS. This
moves IMAP/SMTP sockets to PHP while keeping the existing sign-in, aliases, and UI behavior.

1. Confirm PHP has the IMAP extension enabled in cPanel's **Select PHP Version**. Copy
   `settings.example.php` to a private `aliasmail-settings.php` file in your account home directory
   (outside `public_html`) and fill in the mailbox settings and a long random bridge token.
   Alternatively, set `ALIASMAIL_SETTINGS_FILE` to the protected file's full path.
2. Upload the `php-mail-bridge` folder and serve `index.php` only over HTTPS. Keep the private
   settings file outside the web root. Use an unguessable endpoint path and protect it with the
   bearer token. Set `MAIL_BRIDGE_TOKEN` in the Node app to the same random value.
3. In the Node app's environment, set `MAIL_USER`, `MAIL_BRIDGE_URL` (the HTTPS URL to `index.php`),
   and `MAIL_BRIDGE_TOKEN`. Leave `MAIL_PASSWORD` unset on the Node host. Rebuild/redeploy, then
   sign in and use **Overview → Test connection** before inviting users.
4. Set `MAIL_INBOX_FOLDER`, `MAIL_SENT_FOLDER`, `MAIL_SPAM_FOLDER`, and `MAIL_TRASH_FOLDER` on PHP
   if the provider uses folder names other than `INBOX`, `Sent`, `Junk`, and `Trash`.

For large attachments, raise PHP's `post_max_size` and `memory_limit` if your hosting plan permits
it (the bridge receives base64 encoded message data). The bridge needs PHP's IMAP extension and
OpenSSL enabled.

The PHP host must keep `index.php` reachable to the Node app over HTTPS and must allow PHP IMAP
and SMTP connections. This bridge currently keeps the app's existing API and security behavior in
Node; it moves the mailbox transport that the Node host denied.

For local development, `server/.env` supplies the mailbox credentials and the ignored
`php-mail-bridge/settings.local.php` supplies the matching bridge token. Run the bridge with
`php -S 127.0.0.1:8787 -t php-mail-bridge`, then start the app with `npm run dev`. Local PHP needs
the IMAP and OpenSSL extensions enabled.

### GoDaddy Node.js Hosting (recommended for Economy)

GoDaddy's Node.js Hosting accepts a project ZIP or GitHub repository and runs this app from the
root `package.json`. It is distinct from the older cPanel **Setup Node.js App** feature. The current
Node.js Hosting service runs Node.js 22 and needs a free published-app slot on your Web Hosting
plan; Economy includes one slot.

1. Create a private GitHub repository or make a ZIP of this project. Exclude `node_modules`,
   `client/dist`, `.git`, and `server/.env`. Keep `package-lock.json` files in the upload.
2. In GoDaddy Node.js Hosting, create an app from the repository or ZIP and check its private
   preview. GoDaddy runs the root `npm run build` and `npm start`; the root package scripts are
   already set up for this.
3. Add the variables from `server/.env.example` in the app's environment settings. Set
   `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, a strong unique
   `ADMIN_PASSWORD`, and a long random `JWT_SECRET`. Do not upload `.env`.
4. Add a MySQL or PostgreSQL database and set `DATABASE_URL` (and `DATABASE_SSL=true` if required
   by the database provider). GoDaddy rebuilds the app when deploying; database storage keeps
   aliases, messages, sessions, and avatars across redeploys. Use an existing populated database
   URL when moving data from an earlier deployment.
5. Test the preview, attach the app to your Economy plan, and publish. Connect your domain in
   GoDaddy and confirm HTTPS is active.
6. Sign in, set up admin 2-Step Verification, then use **Overview → Test connection** to verify
   IMAP and SMTP. Confirm sign-in activity records your public IP before inviting alias users.

Mail sync and scheduled sends run in the app process. Confirm in GoDaddy's app settings that the
production process remains running for background sync; if the hosting service sleeps or restarts
the process, those tasks pause until it starts again. A database does not solve simultaneous
multiple app processes: this app is designed to have one writer.

If your Economy plan only shows cPanel and does not offer GoDaddy Node.js Hosting, check whether
**Setup Node.js App** is available. Use the cPanel instructions below only for that legacy setup.

### 1. Before uploading
- [ ] `npm run build` (in the project root), so `client/dist` exists. The server serves it.
- [ ] In `server/.env`: `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`.
- [ ] `ADMIN_PASSWORD`: long (12+ characters) and not used anywhere else.
- [ ] Keep the same `JWT_SECRET`. 2-step secrets are encrypted with it.
- [ ] Hosting that deploys from git (GoDaddy Node.js hosting): set `DATABASE_URL` (MySQL or
      PostgreSQL). Without it, users, settings and profile pictures are lost on every redeploy.
- [ ] Never upload `node_modules`. Run `npm install --omit=dev` in `server/` on the host.

### 2a. cPanel shared hosting ("Setup Node.js App")
1. Upload the project **outside `public_html`**, e.g. `/home/<user>/aliasmail`. Anything inside
   `public_html` can be downloaded from the web, including `.env` and `server/data/db.json`.
   The server prints a `[SECURITY]` warning at startup if it finds itself there.
2. cPanel → **Setup Node.js App** → Create:
   - Node.js version **18 or newer**
   - Application mode **Production**
   - Application root `aliasmail` (or `aliasmail/server`; both have a package.json with the
     dependencies, including Express)
   - Application URL your domain or subdomain (e.g. `mail.nexternconsultancy.com`)
   - Application startup file **`server/app.cjs`** (just `app.cjs` if the root is `aliasmail/server`)
3. Click **Run NPM Install**, then **Restart**.
4. cPanel → **SSL/TLS Status**: make sure the domain has a certificate. Then cPanel → **Domains**:
   turn on **Force HTTPS Redirect**. Leave `FORCE_HTTPS=false` in `.env`, so cPanel does the redirect.
5. Lock down the files (cPanel Terminal or File Manager → Permissions):
   `chmod 600 server/.env` and `chmod 700 server/data`.

Things to know on shared hosting:
- **Sending mail:** GoDaddy shared hosting may block outgoing SMTP to `smtpout.secureserver.net`.
  If **Test connection** fails on SMTP, switch to the local relay: `SMTP_HOST=localhost`,
  `SMTP_PORT=25`, `SMTP_SECURE=false`, `SMTP_AUTH=false`.
- **The app sleeps when idle.** Passenger stops it after a period with no visitors. Background sync
  and **scheduled sends** pause until the next visit. If scheduled sends must be on time, use a VPS.
- **Only one copy may run.** The data file must have a single writer. If the logs show
  `Another AliasMail process … is using …`, ask GoDaddy to limit the app to one process, or use a VPS.

### 2b. GoDaddy VPS
Run it with `pm2 start app.cjs --name aliasmail` (one instance, not cluster mode), behind nginx
with a Let's Encrypt certificate:
```nginx
location / {
  proxy_pass http://127.0.0.1:4000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 40m;
}
```
Firewall: open only 80/443 to the internet, not port 4000.

### 3. After it's live: check
- [ ] `http://` opens as `https://` (padlock shown).
- [ ] Sign in as admin → **Mailbox → Settings → Security → Set up Google Authenticator**.
      Save the backup codes somewhere safe (offline).
- [ ] Admin console → Overview → **Test connection** passes for IMAP and SMTP.
- [ ] Admin console → Overview → **Show sign-in activity**: your sign-in shows **your real IP**.
      If every entry shows `127.0.0.1` or `::1`, `TRUST_PROXY` isn't working. Lockouts would then
      hit everyone at once, so fix it before inviting users.
- [ ] Decide whether to turn on **Require 2-Step Verification for everyone**.
- [ ] The server log has no `[SECURITY]` warnings.

### What protects sign-in
- Password, plus a Google Authenticator code on new devices. "Don't ask again" lasts `MFA_TRUST_DAYS` (30).
- Lockouts:
  - 5 wrong passwords per address and IP;
  - 20 per address from anywhere;
  - 30 per IP across all addresses (password spraying);
  - 5 wrong codes per account.
- Codes are single-use. The step between password and code is single-use and expires in 10 minutes.
- The session is an httpOnly, SameSite=Strict cookie, Secure on HTTPS, held server-side:
  - it ends after `SESSION_IDLE_HOURS` (24) without use, or `SESSION_DAYS` (7) in total;
  - it can be signed out remotely;
  - a password or 2-step change signs out other devices.
- Requests that change something need an `X-Requested-With` header, which blocks cross-site
  request forgery.
- Security headers: CSP, no framing, no referrer, HSTS on HTTPS. API responses are never cached.
- Stored secrets: passwords use bcrypt (cost 12), authenticator secrets are AES-256-GCM encrypted,
  and backup codes and device tokens are kept only as hashes.
- Every sign-in, failure, lockout and security change is recorded in the activity log in the
  admin console.

### If the admin loses their phone and backup codes
Stop the app. In `server/data/db.json`, delete the `"mfa"` entry inside `"owner"`. Start the app,
sign in with the password, and set up Google Authenticator again.

## Notes

- Data (aliases, cache, sent log) lives in `server/data/db.json`. Back it up.
- Attachments of mail sent from the app go out normally and a copy is saved in the mailbox's Sent folder,
  but the app's Sent view only keeps their names.
- HTML email is shown in a sandboxed iframe with scripts disabled.
- Put it behind HTTPS (e.g. a reverse proxy) before giving access to other people.
#   A l i a s m a i l  
 
