# rss.chat on Cloudflare

Deploy an [rss.chat](https://github.com/scripting/rss.chat) instance to Cloudflare Workers, backed by D1 (managed SQLite), R2 (object storage), and Durable Objects (real-time WebSocket coordination). Zero always-on servers. Zero database administration.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/)
- A domain on Cloudflare (for DNS and optional Email Routing)
- [Node.js](https://nodejs.org/) and npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`

## Quick Start

```bash
cd cloudflare
npm install

# 0. Create your config from the example
cp wrangler-example.toml wrangler.toml
# Edit wrangler.toml — replace domain, email sender, and other settings (see Configuration below).
# Keep wrangler.toml out of version control — it will contain your database IDs.

# 2. Create the D1 database (creates a real Cloudflare resource)
npx wrangler d1 create rsschat-db
# Copy the database_id from the output into wrangler.toml

# 3. Create the R2 bucket for media uploads (creates a real Cloudflare resource)
npx wrangler r2 bucket create rsschat-media

# 4. Set up the database schema (runs against the Cloudflare D1 database)
npx wrangler d1 execute rsschat-db --file schema.sql

# 5. Configure email (see Email Setup below)

# 6. Update wrangler.toml with your domain and settings (see Configuration)

# 7. Deploy the Worker
npx wrangler deploy
```

After deploying, point your domain's DNS to Cloudflare Workers. The app is live at `https://yourdomain.chat/`.

## Email Setup

rss.chat uses magic-link email sign-in. You need ONE of the following email providers. Cloudflare Email Routing is the default and requires no third-party service.

### Option 1: Cloudflare Email Routing (default, free)

If your domain is on Cloudflare:

1. Enable [Email Routing](https://developers.cloudflare.com/email-routing/) on your domain
2. Add a destination email address and verify it
3. Update `destination_address` in the `[[send_email]]` section of `wrangler.toml`
4. Update `MAIL_SENDER` in `[vars]` to match a sender you've configured

No secrets needed. The binding is already configured in `wrangler.toml`.

### Option 2: SendGrid

```bash
npx wrangler secret put SENDGRID_KEY
# Paste your SendGrid API key (starts with "SG.")
```

Update `MAIL_SENDER` in `wrangler.toml` to your verified SendGrid sender.

### Option 3: Resend

```bash
npx wrangler secret put RESEND_KEY
# Paste your Resend API key (starts with "re_")
```

Update `MAIL_SENDER` in `wrangler.toml` to your verified Resend sender.

### How it works

At runtime, email.js tries providers in this order:
1. Cloudflare Email Routing (if the binding is available)
2. SendGrid (if `SENDGRID_KEY` secret is set)
3. Resend (if `RESEND_KEY` secret is set)

If none work, signup and sign-in return an error. The server starts fine — email is only needed when someone actually signs up or signs in.

## Configuration

Edit `wrangler.toml` to match your deployment. The key settings:

| Variable | Default | Description |
|---|---|---|
| `MY_DOMAIN` | `myserver.chat` | Your domain name |
| `URL_SERVER_FOR_CLIENT` | `https://myserver.chat/` | Public URL of your instance |
| `URL_SERVER_FOR_EMAIL` | `https://myserver.chat/` | URL used in confirmation email links (can differ from client URL) |
| `URL_SERVER_HOME_PAGE_SOURCE` | `https://code.scripting.com/rsschat/index.html` | Client HTML to proxy at `/` |
| `MAIL_SENDER` | `admin@myserver.chat` | From address for confirmation emails |
| `CONFIRM_EMAIL_SUBJECT` | `myserver.chat confirmation` | Subject line for confirmation emails |
| `OPERATION_TO_CONFIRM` | `sign in to myserver.chat` | Text used in email body |
| `MAX_FEED_ITEMS` | `100` | Items per RSS feed |
| `MAX_RECENT_ITEMS` | `100` | Items returned by `/getrecentitems` |
| `MAX_MEDIA_UPLOAD_BYTES` | `2097152` | Max image upload size (2 MB) |
| `FL_RSS_CLOUD_ENABLED` | `true` | Enable RSS Cloud pings |
| `URL_FAVICON` | `https://myserver.chat/favicon.ico` | Favicon URL |

All `.chat` / `.network` references in defaults should be changed to your domain.

## Importing from an Existing Node.js rss.chat

If you have a running Node.js rss.chat instance, export its data first:

```bash
# On the Node server:
node server/code/rssnetwork.js export backup.json
```

Then import into your Cloudflare deployment:

```bash
curl -X POST -d @backup.json https://yourdomain.chat/admin/import
```

This bulk-imports users, items, likes, feed files, and media blobs into D1 and R2.

## Admin Endpoints

These are available at your deployed domain. Protect them with access controls (Cloudflare Access, IP rules, or remove them before deploying to production).

| Endpoint | Description |
|---|---|
| `POST /admin/import` | Bulk import from Node export JSON |
| `POST /admin/block?email=X` | Block an email address |
| `POST /admin/unblock?email=X` | Remove an email from block list |
| `POST /admin/whitelist?email=X` | Add an email to the whitelist |
| `POST /admin/unwhitelist?email=X` | Remove an email from whitelist |

Blocks and whitelist changes take effect immediately — no deploy needed. They are stored in D1 tables (`blocked_emails`, `whitelist_emails`).

## Architecture

See [PLAN.md](./PLAN.md) for a detailed architecture document covering:
- D1 schema design and query mapping
- Durable Object class design  
- Auth flow (two-track magic token + persistent email secret)
- Feed publishing pipeline with `db.batch()` optimization
- WebSocket broadcast and alarms API
- Porting gotchas from the Node.js original

## Local Development

```bash
npx wrangler dev
```

Runs locally with D1, R2, and DO emulated. The confirmation email URL is logged to the console when no email provider is configured, so you can click through the signup flow manually.

## Troubleshooting

**"No email provider available"** — Enable Cloudflare Email Routing on your domain, or set `SENDGRID_KEY` / `RESEND_KEY` secret.

**Signup says email already in use** — The email address is already registered. Use `/sendconfirmingemail` to sign in instead.

**Media uploads fail** — Check that the R2 bucket exists and is bound correctly in `wrangler.toml`. Images over `MAX_MEDIA_UPLOAD_BYTES` are rejected.

**DNS not resolving** — After `wrangler deploy`, add a DNS record in Cloudflare dashboard pointing your domain to the Workers deployment. Use the Workers Routes or Custom Domains section.
