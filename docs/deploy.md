# Deploy

The API and the pages run on Render, the data on MongoDB Atlas, and passcode emails go through
Resend's HTTP API ([ADR-0017](decisions/0017-deploy-render-resend-page-csp.md)). [`render.yaml`](../render.yaml)
describes both services. Everything below is done once; after that, every commit to the
Blueprint's branch redeploys.

## Accounts

1. **Atlas:** a free cluster (M0) in the region nearest Render's (Frankfurt: AWS `eu-central-1`),
   a database user with a generated password, and the connection string
   (`mongodb+srv://…`). The database name in the string is the one the app uses.
2. **Resend:** an API key with sending access, and a verified sending domain (a subdomain such as
   `mail.example.com`, so the records never touch the root domain's own mail). Without a verified
   domain Resend delivers only to the account's own address.
3. **Render:** connect the GitHub repository.

## First deploy

1. In Render, **New → Blueprint**, pick the repository and the branch that holds `render.yaml`.
   Render asks for each `sync: false` value:

   | Service | Variable | Value |
   |---------|----------|-------|
   | `parsec-bank-api` | `MONGODB_URI` | the Atlas connection string |
   | `parsec-bank-api` | `RESEND_API_KEY` | the Resend key |
   | `parsec-bank-api` | `MAIL_FROM` | `Parsec Bank <codes@mail.example.com>`, on the verified domain |
   | `parsec-bank-api` | `CORS_ORIGIN` | `https://parsec-bank.onrender.com` (the static site's address) |
   | `parsec-bank` | `VITE_API_URL` | `https://parsec-bank-api.onrender.com` (the web service's address) |

   The two addresses are `https://<service name>.onrender.com` unless the name was taken, in
   which case Render adds a suffix: read the real ones on each service's page, correct the two
   values, and redeploy the static site (its build bakes the API's address in).
2. **Atlas → Network Access:** add the web service's outbound address ranges, from its
   **Connect → Outbound** tab. Render shares these ranges between services in a region and
   announces new ones ahead of time (marked NEW): add those when they appear.
3. The web service's log shows `"msg":"server listening"` with `"nodeEnv":"production"`,
   `"storage":"mongodb"` and `"address":"0.0.0.0"`. A server that starts without
   `NODE_ENV=production` listens on 127.0.0.1 only, so Render finds no port and the deploy fails.

## The proxy count

The rate limits count clients by address, so the server must know how many proxies sit in front
of it (`TRUST_PROXY`). It starts at 0, where every client shares one count. Measure it before
sharing the address:

```sh
curl -s https://parsec-bank-api.onrender.com/api/v1/me -H 'X-Forwarded-For: 198.51.100.9' -o /dev/null
```

The request's log line carries `"clientIp"`. Raise `TRUST_PROXY` in `render.yaml` one step at a
time until `clientIp` is this machine's public address. At the right count it is never
`198.51.100.9`: one too many would let any client pick its own address.

Measured on 2026-11-25 (free web service, Frankfurt): the request arrived from `127.0.0.1` with
`X-Forwarded-For: 198.51.100.9, <client>, <Cloudflare edge>, <Render 10.x proxy>`, so
`TRUST_PROXY` is 3. If Render changes its routing, measure again: a count that is now too high
trusts the forged entry.

## Checks

- `server/postman/live.postman_collection.json` signs in as two accounts made on the live app
  and sends 1 agora each way. Copy `live.postman_environment.example.json` beside it to
  `live.postman_environment.json` (ignored by git: it holds their passwords) and fill it in:

  ```sh
  npx newman@6.2.3 run server/postman/live.postman_collection.json \
    -e server/postman/live.postman_environment.json
  ```

- The pages' content security policy: open the live site with the browser's console showing
  and walk sign-in, the dashboard and a transfer. No "Refused to …" line may appear.
