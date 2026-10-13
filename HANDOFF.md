# Handoff: continuing on another machine

State as of 2026-10-13: the app is built and verified locally against the live Vodafone API (`npm test` 28/28, `npm run typecheck` clean, `wrangler dev` smoke run of lookup → status → stats → email subscribe/confirm → cron resolve → notification mail). **Nothing is deployed yet.** Architecture and behavior are described in [README.md](README.md).

## 1. Get a working checkout

```sh
git clone git@github.com:boredland/vodafone.git
cd vodafone
mise install            # Node 22, pinned in mise.toml (or any Node ≥ 22)
npm ci
```

The first machine had no global git identity; the repo-local one isn't in the clone. If needed:

```sh
git config user.name "Jonas Strassel"
git config user.email "4662748+boredland@users.noreply.github.com"
```

## 2. Local development

`.dev.vars` is gitignored and was not transferred. Generate fresh local VAPID keys (local subscriptions are throwaway anyway):

```sh
npm run vapid > .dev.vars
npm run db:migrate                      # local D1 in .wrangler/
npx wrangler dev --test-scheduled       # http://localhost:8787
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"   # trigger the monitor once
npm test && npm run typecheck
```

Emails are simulated locally; their content lands in `.wrangler/tmp/email/`.

## 3. First deployment (open)

Prerequisites in the Cloudflare dashboard:

- Workers **Paid** plan (required for Email Service sending).
- `jonas-strassel.de` zone on the account. `wrangler.jsonc` routes the Worker as a custom domain on `vodafone.jonas-strassel.de`.
- Email Service: onboard **`vodafone.jonas-strassel.de`** as a sending domain (DNS records for SPF/DKIM). The sender is `stoerungen@vodafone.jonas-strassel.de`, restricted via `allowed_sender_addresses`.

Then:

```sh
npx wrangler login
npx wrangler d1 create vodafone-stoerungen --binding DB --update-config   # adds database_id to wrangler.jsonc — commit it
npm run vapid                                                             # production keys; store them in a password manager
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npm run deploy                                                            # remote D1 migrations, then wrangler deploy
```

Production VAPID keys must never change after the first push subscription exists; subscriptions are bound to the public key.

If the rate-limit `namespace_id`s `4711`/`4712` collide with other Workers on the account, change them in `wrangler.jsonc` (shared IDs share counters).

## 4. Verify after deploy (not yet done)

- [ ] Open https://vodafone.jonas-strassel.de, look up an address, check status + statistics render.
- [ ] Enable push in a real desktop browser (headless Chromium can't get a push subscription, so this path is untested end-to-end). Trigger a test by inserting a fake fault and letting the cron resolve it, e.g.:
      ```sh
      npx wrangler d1 execute DB --remote --command "INSERT INTO faults (address_id, fault_id, category, service_type, description, raw, first_seen, last_seen, missing_since) VALUES ('<addressId>', 'TEST1', 'cable', 'incident', 'Test', '{}', $(node -p 'Date.now()-3600000'), $(node -p 'Date.now()-1200000'), $(node -p 'Date.now()-1200000'))"
      ```
      Within 5 minutes you should get a "Kabel-Störung behoben" push/email. Delete the row afterwards (`DELETE FROM faults WHERE fault_id = 'TEST1'`). It also affects that address's statistics.
- [ ] Subscribe a real email address; confirm the double-opt-in mail arrives and the link works; check the unsubscribe link and the mail client's one-click unsubscribe.
- [ ] `npx wrangler tail` during a cron run: expect `monitor: checked N addresses, 0 failed`.

## Known risks / things to watch

- **Upstream is undocumented.** `eu3.api.vodafone.com/netassistant/v1` with the key embedded in the vodafone.de Störungsfinder bundle (`/simplicity/net-assistant/js/main.js`, constant `Yg`). If lookups start failing with 4xx, re-extract the key from that bundle and update `VODAFONE_API_KEY` in `wrangler.jsonc`. The request shapes (`suggest` with `searchKey` = `postCodeOrCity` | `streetName` | `streetNr`, `faultinfo` with `postalCode` or `addressId`) came from the lazy chunk `/simplicity/net-assistant/js/22.js`.
- Using Vodafone's internal API may conflict with their terms of use.
- Statistics only cover the period since an address was first looked up; Vodafone exposes only current faults, so there's no backfill.
- Monitor caps at 150 addresses per 5-minute run (`MAX_ADDRESSES_PER_RUN` in `src/monitor.ts`); with more watched addresses, coverage per address degrades gracefully (oldest-checked first).
