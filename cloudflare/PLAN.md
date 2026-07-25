# Plan: Cloudflare Workers + Durable Objects Support

## Goal

Add a parallel deployment path where each rss.chat instance runs as a Cloudflare Workers script with a Durable Object for real-time coordination (HTTP routing, WebSocket broadcast) and D1 (Cloudflare's managed SQLite) for all persistent storage. Media files live in R2 (Cloudflare's object storage). The `cloudflare/` project is self-contained — it mirrors the API contract and copies the relevant logic from `server/code/rssnetwork.js` (which is generated from an OPML outline and must not be modified). Existing npm packages (`daverss`, `daveutils`, `opml`, `turndown`, `autolinker`, `sanitize-html`) are reused as dependencies.

## Architecture

```
Browser / Feed Reader
        │
        ▼
  Cloudflare Workers (global network)
        │  fetch event → route to DO
        │  WebSocket upgrade → route to DO
        ▼
  Durable Object (one per rss.chat instance)
        │  Real-time: HTTP routing, WebSocket broadcast
        │  Calls D1 for all persistent data
        │  Calls R2 for media upload/serve
        ├── orchestrator.js   (newPost, updatePost, feed building, etc.)
        ├── transform.js      (convertItem, buildFeedItems, sanitize, etc.)
        ├── d1-data-access.js (D1 SQL adapter)
        ├── r2-media.js       (R2 media upload/serve helpers)
        └── config.js         (env vars → config object)
        
  D1 (managed SQLite)
        ├── users, items, likes, files, media_meta tables
        ├── Same schema as original rssnetwork.js
        └── Transactions wrap multi-statement writes
        
  R2 (object storage)
        └── All media blobs (regardless of size)
```

**Key property:** The DO holds ALL state for one instance. A single DO per rss.chat deployment. Multiple instances (e.g. `myserver.chat` and `yourserver.chat`) each get their own DO, with their own data.

## File Layout

```
cloudflare/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.js            # Worker entry point (fetch → DO)
│   ├── rsschat-do.js       # Durable Object class + fetch router
│   ├── orchestrator.js     # Business logic copied from rssnetwork.js
│   ├── transform.js        # Pure transformations copied from rssnetwork.js
├── schema.sql              # D1 table definitions (from initNewDatabase)
│   ├── d1-data-access.js   # DataAccess implementation against D1 (SQL)
│   ├── config.js           # Environment-based config
│   ├── email.js            # Email sending (SendGrid / SES via fetch)
│   ├── r2-media.js         # R2 media upload/serve helpers
│   └── import.js           # Node export JSON → D1 bulk import
```

## What gets reused vs. what gets replaced

### Reused (npm packages, work in Workers)

| Package | Used for |
|---|---|
| `daverss` | `rss.buildRssFeed()`, `rss.buildJsonFeed()`, `rss.cloudPing()` |
| `daveutils` | `utils.stringLower()`, `utils.getRandomPassword()`, `utils.mergeOptions()`, `utils.stringNthField()`, etc. |
| `opml` | `opml.stringify()`, OPML parsing |
| `turndown` | `getMarkdownFromHtml` |
| `autolinker` | `linkifyUrls` |
| `sanitize-html` | `sanitizeHtmltext` |

### Replaced (Node-only, not available in Workers)

| Package | Workers replacement |
|---|---|
| `davesql` | D1 via `d1-data-access.js` (nearly identical SQL, D1 is SQLite) |
| `daveappserver` | Workers `fetch` handler + DO WebSocket + DO routing |
| `daves3` | D1 `files` table (same SQL schema as `flFeedsInDatabase` path) |
| `fs` | Config from env vars; files from D1 `files` table |
| `request` | `fetch()` (built into Workers) |

### Copied from `server/code/rssnetwork.js` (adapted, not extracted)

Two new source files carry the logic copied from `rssnetwork.js`:

**`transform.js`** — pure transformation functions (~250 lines). These close over `config` (or accept it as parameter where needed). Functions:

- `convertString`, `convertNumber`, `convertDate`, `convertJson`
- `convertUser`, `convertItem` (including inner `getAuthor`)
- `getPermalinkUrl`, `getInReplyToPermalink`, `getCommentsFeedUrl`, `getFeedUrl`
- `getDefaultHeadElements`
- `getMarkdownFromHtml`, `linkifyUrls`, `sanitizeHtmltext`, `trimTrailingBlankLines`
- `buildFeedItems`
- `initDatabaseUrls`

**`orchestrator.js`** — business logic (~600 lines). These call `dataAccess.*` methods (instead of the original Category C functions) and `transform.*` functions. Exports a factory taking `(config, dataAccess, transform)`. Functions:

- `newPost`, `updatePost`, `deletePost`
- `validateUser`, `userOwnsItem`
- `uploadMedia`
- `savePrefs`
- `toggleLikeEndpoint`, `toggleLike`
- `buildFeedForUser`, `buildCommentsFeed`, `buildFeedForEveryone`
- `updateFeeds`, `updateReplyFeeds`
- `publishFeedFile` (writes to D1 `files` table)
- `getUserData`, `getUserFeed`, `getItemInfo`
- `getSubscriptionList`
- `pingCloud`
- `bumpUserHits`

**Stays in platform-specific code (not shared):** `isEmailBlocked`, `userIsBlocked`, `checkWhitelist` — reimplemented in the DO class, querying D1 `blocked_emails` and `whitelist_emails` tables. `backfillFeeds`, `backfillCommentsFeeds` — Node-only startup tasks, not needed in the DO. `getExtrasList` — only used by daveappserver page table, not needed.

## D1 Database Schema

D1 is Cloudflare's managed SQLite. The schema is nearly identical to the original `initNewDatabase()` in `rssnetwork.js` (lines 250-279). One new table (`auth_tokens`) replaces the transient DO keys from the earlier design.

```sql
-- schema.sql (run via `npx wrangler d1 execute rsschat-db --file schema.sql`)

create table if not exists users (
    screenname text not null collate nocase,
    emailAddress text collate nocase,
    emailSecret text,
    prefs text,
    ctHits integer not null default 0,
    ctHitsToday integer not null default 0,
    whenLastHit text,
    whenCreated text default current_timestamp,
    whenUpdated text default current_timestamp,
    primary key (screenname)
);
create index if not exists emailAddress on users (emailAddress);

create table if not exists items (
    id integer primary key autoincrement,
    feedUrl text,
    author text collate nocase,
    inReplyTo integer,
    title text,
    link text,
    description text,
    pubDate text,
    enclosureUrl text,
    enclosureType text,
    enclosureLength integer,
    whenCreated text default current_timestamp,
    whenUpdated text default current_timestamp,
    markdowntext text,
    outlineJsontext text,
    flDeleted integer not null default 0
);
create index if not exists feedUrl on items (feedUrl);
create index if not exists author on items (author);

create table if not exists likes (
    screenname text collate nocase,
    itemId integer,
    whenCreated text default current_timestamp,
    primary key (screenname, itemId)
);
create index if not exists itemId on likes (itemId);

create table if not exists files (
    path text not null,
    type text,
    filecontents text,
    whenCreated text default current_timestamp,
    whenUpdated text default current_timestamp,
    ctSaves integer not null default 1,
    primary key (path)
);

create table if not exists media (
    id integer primary key autoincrement,
    screenname text collate nocase,
    type text,
    -- No mediabytes column — blobs live in R2
    r2Key text not null,
    size integer,
    whenCreated text default current_timestamp
);

create table if not exists auth_tokens (
    token text primary key,
    email text not null,
    screenname text,
    operation text not null,  -- 'confirm' or 'signup'
    urlredirect text not null,
    whenCreated text default current_timestamp
);
-- Cleanup: tokens older than 15 minutes are invalid
create index if not exists auth_tokens_when on auth_tokens (whenCreated);

-- Triggers (identical to original rssnetwork.js initNewDatabase)
create trigger if not exists usersWhenUpdated after update on users
begin
    update users set whenUpdated = datetime('now') where screenname = new.screenname;
end;
create trigger if not exists itemsWhenUpdated after update on items
begin
    update items set whenUpdated = datetime('now') where id = new.id;
end;

-- Blocked emails and whitelist (replaces config.json file reads)
create table if not exists blocked_emails (
    email text primary key collate nocase,
    whenCreated text default current_timestamp
);
create table if not exists whitelist_emails (
    email text primary key collate nocase,
    whenCreated text default current_timestamp
);
```

### Key differences from the original SQL schema

- **`collate nocase` preserved** — D1 is SQLite, so case-insensitive lookups on `screenname` and `emailAddress` work exactly as they do in Node.
- **`media` table** — `mediabytes` blob column replaced with `r2Key text not null`. Binary data lives in R2; only metadata is in D1.
- **`auth_tokens` table** — new. Replaces the transient DO Storage `auth_token:` keys from the original DO-storage plan. Tokens older than 15 minutes are rejected at read time. Expired rows are purged automatically by the DO's Alarms API (fires every 15 minutes, runs `DELETE FROM auth_tokens WHERE whenCreated < datetime('now', '-15 minutes')`). No separate scheduled Worker needed.
- **`blocked_emails` and `whitelist_emails` tables** — new. Replace the original `fs.readFileSync("config.json")` calls in `isEmailBlocked` and `checkWhitelist`. Stored in D1 so they can be updated via admin API endpoints without a deploy cycle. Empty `whitelist_emails` table = no whitelist = all allowed (fail-open, matching the original).
- **Triggers preserved** — D1 supports `CREATE TRIGGER`. The original `usersWhenUpdated` and `itemsWhenUpdated` triggers from `initNewDatabase` work verbatim.
- **`autoincrement` on `items.id` and `media.id`** — D1 handles this natively. No more sequence-counter keys.

### Query mapping: original SQL → D1

Since D1 is SQLite, the `d1-data-access.js` methods use the same SQL as `rssnetwork.js`, substituting `davesql.encode()` with D1's parameterized queries (`?` placeholders). Example:

```javascript
// Original (rssnetwork.js):
const sqltext = "select * from users where screenname = " + davesql.encode(screenname) + ";";
davesql.runSqltext(sqltext, function (err, result) { ... });

// D1 (d1-data-access.js):
const result = await db.prepare("select * from users where screenname = ?").bind(screenname).all();
```

All the complex JOINs in the original (`getRecentItems`, `getRecentUserItems`, `getItemByGuid`, `getItemAndReplies`, `getMostActiveToday`) transfer directly to D1 — same SQL, same `collate nocase`, same result shapes.

## DO Class Design

```javascript
export class RssChatDO {
    constructor(state, env) {
        this.sockets = [];
        this.db = env.DB;  // D1 binding
        this.r2 = env.MEDIA_BUCKET;  // R2 binding
        this.config = buildConfig(env);
        this.dataAccess = new D1DataAccess(this.db);
        this.transform = require('./transform.js')(this.config);
        this.orchestrator = require('./orchestrator.js')(this.config, this.dataAccess, this.transform);

        // Wire write-side effects
        const self = this;
        this.dataAccess.onWrite = function (event, payload) {
            if (event === "itemChanged") {
                self.broadcast(payload.verb, {item: payload.item});
                }
            else if (event === "userAdded") {
                self.orchestrator.updateSubscriptionList(self.dataAccess, self.transform);
                }
            };
    }

    async fetch(request) {
        // Check for WebSocket upgrade
        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
            }
        // Route HTTP requests (see Routing section below)
        return this.routeRequest(request);
    }

    broadcast(verb, payload) {
        for (const ws of this.sockets) {
            try { ws.send(JSON.stringify({verb, ...payload})); }
            catch (e) { /* socket dead, cleaned up on close */ }
            }
    }

    // ... routeRequest, handleWebSocketUpgrade, etc.
}
```

## Worker Entry Point

```javascript
export default {
    async fetch(request, env, ctx) {
        const doId = env.RSSCHAT_DO.idFromName("default");
        const stub = env.RSSCHAT_DO.get(doId);
        return stub.fetch(request);
    }
}
```

The DO receives `env.DB` (D1) and `env.MEDIA_BUCKET` (R2) through its constructor. All data operations inside the DO use `this.db`; all media operations use `this.r2`.

One DO per Workers deployment. The `idFromName("default")` ensures all requests hit the same DO instance.

### Routing (inside `routeRequest`)

Replicates the `handleHttpRequest` switch statement from rssnetwork.js but with standard `Request`/`Response` objects instead of daveappserver's `theRequest`. URLs are parsed with `new URL(request.url)`.

| Original endpoint | Workers handler |
|---|---|
| `/getrecentitems?ct=N&screenname=X` | `GET /getrecentitems` params |
| `/newpost?emailaddress=...&emailcode=...` | `POST /newpost` params |
| `/updatepost` | `POST /updatepost` params |
| `/deletepost` | `POST /deletepost` params |
| `/uploadmedia` | `POST /uploadmedia?emailaddress=X&emailcode=Y&type=Z` with base64 body. The original `Buffer.from(base64text, "base64")` works via Workers' Node.js Buffer polyfill — no code change needed. **R2 cleanup:** If R2 write succeeds but D1 metadata insert fails, delete the orphaned blob in the catch block. |
| `/feed?screenname=X&format=json` | `GET /feed` |
| `/getuserdata?screenname=X` | `GET /getuserdata` |
| `/getsubscriptionlist` | `GET /getsubscriptionlist` |
| `/saveprefs` | `POST /saveprefs` |
| `/getitembyguid?guid=X&screenname=Y` | `GET /getitembyguid` |
| `/checkwhitelist?emailaddress=X` | `GET /checkwhitelist` |
| `/isuserindatabase?screenname=X` | `GET /isuserindatabase` |
| `/isemailindatabase?email=X` | `GET /isemailindatabase` |
| `/togglelike` | `POST /togglelike` |
| `/getlikerslist?id=X` | `GET /getlikerslist` |
| `/getrecentuseritems?screenname=X&name=Y` | `GET /getrecentuseritems` |
| `/getitemandreplies?screenname=X&idparent=Y` | `GET /getitemandreplies` |
| `/getmostactivetoday` | `GET /getmostactivetoday` |
| `/robots.txt` | `GET /robots.txt` |
| `/getiteminfo?guid=X&format=Y` | `GET /getiteminfo` |
| `/favicon.ico` | redirect to `config.urlFavicon` |
| `/sendconfirmingemail` | `GET /sendconfirmingemail?email=X&urlredirect=Y` — server-side block check, lookup user, send magic-link email |
| `/createnewuser` | `GET /createnewuser?email=X&name=Y&urlredirect=Z` — block check, screenname/email uniqueness, pre-confirm user creation, send magic-link email. Note: `name` param (client sends `name`, not `screenname`) |
| `/confirm` | `GET /confirm?token={magicToken}` — validate magic token, redirect with `emailconfirmed=true`, `email`, `code`, `screenname` |
| `/media/N` | `GET /media/N` — serve from R2 |
| `/users/*`, `/data/*` | serve from D1 `files` table |
| `/admin/import` | `POST /admin/import` — bulk import from Node export JSON |
| `/admin/block` | `POST /admin/block?email=X` — INSERT into `blocked_emails`. Instant effect, no deploy. |
| `/admin/unblock` | `POST /admin/unblock?email=X` — DELETE from `blocked_emails`. |
| `/admin/whitelist` | `POST /admin/whitelist?email=X` — INSERT into `whitelist_emails`. |
| `/admin/unwhitelist` | `POST /admin/unwhitelist?email=X` — DELETE from `whitelist_emails`. |
| `/` | serve client HTML (proxy to `urlServerHomePageSource` or serve from KV/R2) |

### Response format

- Success: `new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })`
- Error (original style): `new Response("Can't ... because ...", { status: 503 })`
- Feed XML: `new Response(xmltext, { headers: { "content-type": "text/xml" } })`
- Feed JSON: `new Response(jsontext, { headers: { "content-type": "application/json" } })`
- Media: `new Response(bytes, { headers: { "content-type": mediaRec.type } })`
- Redirect: `new Response(null, { status: 302, headers: { "Location": url } })`

## Feed Publishing After Writes

Every write triggers feed regeneration, matching rssnetwork.js behavior. Feeds are written to the D1 `files` table — exactly like the original `flFeedsInDatabase` path. D1's `db.batch()` bundles multiple statements into a single HTTP round-trip, reducing write latency:

```javascript
// newPost: 2 round-trips instead of 5
const user = await db.prepare("SELECT * FROM users WHERE emailAddress = ?").bind(email).first();  // trip 1
// ... validate user ...
await db.batch([                                                                                      // trip 2
    db.prepare("INSERT INTO items (...) VALUES (...)").bind(...),
    db.prepare("INSERT OR REPLACE INTO files (...) VALUES (...)").bind(...),  // user feed
    db.prepare("INSERT OR REPLACE INTO files (...) VALUES (...)").bind(...),  // everyone feed
    db.prepare("INSERT OR REPLACE INTO files (...) VALUES (...)").bind(...),  // subscription list
]);
```

The cascade:

```
newPost → orchestrator.updateFeeds → buildFeedForUser → writeDatabaseFile → files table
                                   → buildFeedForEveryone → writeDatabaseFile → files table
        → orchestrator.updateReplyFeeds → buildCommentsFeed → writeDatabaseFile → files table

updatePost, deletePost, toggleLike → same cascade
```

`writeDatabaseFile(path, type, contents)` uses the same upsert SQL as the original `rssnetwork.js` (lines 1787-1817), adapted for D1 parameterized queries. The subscription list (`/data/subs.opml`) also lives in the `files` table.

## WebSocket Support

DOs in Workers support WebSocket upgrades natively:

```javascript
handleWebSocketUpgrade(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.sockets.push(server);
    server.accept();

    server.addEventListener("message", (event) => {
        // Handle magic link auth: "user {email} {code}"
        // Validate against user record, associate socket with screenname
        });

    server.addEventListener("close", () => {
        const ix = this.sockets.indexOf(server);
        if (ix >= 0) this.sockets.splice(ix, 1);
        });

    return new Response(null, { status: 101, webSocket: client });
}
```

The DO broadcasts `newItem` and `updatedItem` messages to all connected sockets on every write — triggered by `dataAccess.onWrite("itemChanged", ...)` → `this.broadcast(verb, payload)`.

**WebSocket hibernation:** For low-traffic instances, DOs support the WebSocket Hibernation API. Instead of keeping sockets in `this.sockets = []` (which consumes resources 24/7), accept the WebSocket via `state.acceptWebSocket(ws)` and the DO will serialize socket state to disk between messages, waking only when data arrives. Reduces costs for instances with sporadic activity. Not required for v1 but worth adding if idle costs matter.

## Email and Auth (Magic Link Sign-in)

### Two-Track Auth State

In the current Node.js server, `daveappserver` owns the confirmation flow. `rssnetwork.js` only provides 5 callbacks (`findUserWithScreenname`, `findUserWithEmail`, `getScreenNameFromEmail`, `addEmailToUserInDatabase`, `isUserAdmin`). The DO must replicate all of daveappserver's auth behavior.

There are **two separate pieces of state** that the plan originally conflated:

1. **Persistent `emailSecret`** — stored in the `users` table (DO: `usr:{screenname}`). Returned to the client as the ongoing credential (`emailcode` parameter on write endpoints). **Does NOT change on subsequent sign-ins** for existing users. This is intentional: idempotent re-confirmation survives Gmail/link-scanner double-hits (see `server/code/worknotes.md:260`).

2. **Transient magic token** — one-time use. Generated when `/sendconfirmingemail` or `/createnewuser` is called. Stored as a row in the D1 `auth_tokens` table with a 15-minute effective TTL. Emailed to the user. Validated once when the user clicks the link, then deleted. Resolves to the user's persistent `emailSecret` for the redirect.

### Auth Tokens (D1 table)

| Key | Value | TTL | Notes |
|---|---|---|---|
| `auth_tokens` row | `{ token, email, screenname, operation, urlredirect, whenCreated }` | 15 minutes | Transient confirmation state. Deleted after successful validation. Tokens older than 15 minutes are rejected and eventually purged by a scheduled Worker cron. |

### Endpoints

#### `GET /sendconfirmingemail?email=X&urlredirect=Y`

1. Server-side block check: `isEmailBlocked(email)` — if blocked, return error `{message: "Can't send the confirming email because the user is not authorized."}`
2. Look up user by email (case-insensitive) via `usr_email:{lowercasedEmail}` → screenname
3. If user **not found**: return error (use `/createnewuser` for new users)
4. If user **found**: get their stored `emailSecret` from `usr:{screenname}`, generate a one-time magic token via `utils.getRandomPassword(20)`, store `{magicToken, email, screenname, operation: "confirm", urlredirect}` in `auth_token:{magicToken}`
5. Send email with confirmation URL: `{config.urlServerForEmail}/confirm?token={magicToken}`
6. Email template (from `server/code/emailtemplate.html`) uses `[%title%]`, `[%operationToConfirm%]`, `[%confirmationUrl%]` placeholders. Render by string substitution in `email.js`.

#### `GET /createnewuser?email=X&name=Y&urlredirect=Z`

(`name` is the desired screenname — the client sends `name`, not `screenname`. Both endpoints are GETs with query params, matching the original client.)

1. Server-side block check: `isEmailBlocked(email)`
2. Check screenname availability: look up `usr:{lowercasedName}` — if exists, return error
3. Check email already in use: look up `usr_email:{lowercasedEmail}` — if exists, return error (email uniqueness not enforced by the original schema but assumed by auth; duplicate emails in imported data should be detected and resolved at import time)
4. **Pre-confirm user creation** (matching current behavior — users are created before email confirmation): call `addUser({screenname: name, emailAddress: email, emailSecret: utils.getRandomPassword(20)})`, which triggers `onWrite("userAdded", ...)` → `updateSubscriptionList`
5. Generate one-time magic token, store `{magicToken, email, screenname: name, operation: "signup", urlredirect}` in `auth_token:{magicToken}`
6. Send email with confirmation URL

#### `GET /confirm?token={magicToken}`

1. Look up `auth_token:{magicToken}` → if not found (expired or invalid), redirect to `urlredirect` with `error=invalid_token`
2. Fetch the user record: `usr:{screenname}` or `usr_email:{email}`
3. Delete the token row from the `auth_tokens` D1 table
4. Redirect browser (302) to `{urlredirect}?emailconfirmed=true&email={email}&code={emailSecret}&screenname={screenname}`
5. The client stores `email` + `code` as persistent credentials for all write endpoints

**Idempotency guarantee:** Subsequent calls to `/sendconfirmingemail` for an existing user return the SAME `emailSecret` — they never rotate it. Only `/createnewuser` mints a new secret (for a new user).

### Credentials/Env

- `wrangler.toml` secrets: `SENDGRID_API_KEY` or `RESEND_API_KEY`
- Config fields: `mailSender`, `confirmEmailSubject`, `operationToConfirm`, `urlServerForEmail` (can be the same as `urlServerForClient` but configurable separately — supported in original via `config.json`)

### Email Template

The `emailtemplate.html` from `server/code/` is a simple HTML file with three placeholders:

```html
<html><head><title>[%title%]</title>...</head>
<body><div class="divPageBody">
<p>Click the link below to [%operationToConfirm%].</p>
<p><a href="[%confirmationUrl%]">[%confirmationUrl%]</a></p>
</div></body></html>
```

Inline it as a template string in `email.js`. Substitute `[%title%]`, `[%operationToConfirm%]`, `[%confirmationUrl%]` at send time.

### Email Function (`email.js`)

```javascript
export async function sendConfirmationEmail(config, to, confirmUrl) {
    const htmlBody = config.emailTemplate
        .replace("[%title%]", config.confirmEmailSubject)
        .replace("[%operationToConfirm%]", config.operationToConfirm)
        .replace("[%confirmationUrl%]", confirmUrl);
    await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.sendgridKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: config.mailSender },
            subject: config.confirmEmailSubject,
            content: [{ type: "text/html", value: htmlBody }]
            })
        });
}
```

Alternatively, use Cloudflare's `send-email` binding if the domain is on Cloudflare — no third-party API needed.

## Config

Runtime config comes from `wrangler.toml` environment variables, secrets, and bindings. `config.js` builds the full config object that matches the shape `rssnetwork.js` expects.

```toml
# wrangler.toml
name = "rsschat"
main = "src/index.js"

[[d1_databases]]
binding = "DB"
database_name = "rsschat-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "rsschat-media"

[[durable_objects.bindings]]
name = "RSSCHAT_DO"
class_name = "RssChatDO"

[[migrations]]
tag = "v1"
new_classes = ["RssChatDO"]

[vars]
PRODUCT_NAME = "rssChat"
MY_DOMAIN = "myserver.chat"
URL_SERVER_FOR_CLIENT = "https://myserver.chat/"
URL_SERVER_HOME_PAGE_SOURCE = "https://code.scripting.com/rsschat/index.html"
MAX_FEED_ITEMS = "100"
MAX_RECENT_ITEMS = "100"
MAX_MEDIA_UPLOAD_BYTES = "2097152"
RSS_LANGUAGE = "en-us"
RSS_DOCS = "http://cyber.law.harvard.edu/rss/rss.html"
RSS_MAX_FEED_ITEMS = "100"
FL_RSS_CLOUD_ENABLED = "true"
RSS_CLOUD_DOMAIN = "rpc.rsscloud.io"
RSS_CLOUD_PORT = "5337"
RSS_CLOUD_PATH = "/pleaseNotify"
RSS_CLOUD_REGISTER_PROCEDURE = ""
RSS_CLOUD_PROTOCOL = "http-post"
FL_REMOVE_BLANKS_AT_END = "true"
ROBOTS_TEXT = "User-agent: *\nDisallow: /getitembyguid\nDisallow: /getiteminfo\n"
URL_FAVICON = "https://myserver.chat/favicon.ico"
URL_FEEDLAND_SERVER = "https://feedland.social/"
URL_FEEDLAND_REDIRECT = "https://feedland.social/?item="
URL_SERVER_FOR_EMAIL = "https://myserver.chat/"
MAIL_SENDER = "admin@myserver.chat"
CONFIRM_EMAIL_SUBJECT = "myserver.chat confirmation"
OPERATION_TO_CONFIRM = "sign in to myserver.chat"

# Derived internally by initDatabaseUrls equivalent:
# rssFeedUrl = urlServerForClient + "users/"
# opmlListUrl = urlServerForClient + "data/subs.opml"

**Secrets (put via `npx wrangler secret put`):**
- `SENDGRID_KEY` or email provider credentials

Note: `BLOCKED_USERS` and `WHITELIST` are NOT secrets. They're stored in D1 tables (`blocked_emails`, `whitelist_emails`) and managed via admin API endpoints. This avoids the deploy cycle for operational changes.

## Client Serving

The Workers root (`/`) handler proxies the client HTML from the existing URL (daveappserver's `urlServerHomePageSource` behavior): `fetch(config.urlServerHomePageSource)` and return the response. Simplest approach, zero extra infra. The client loads and makes API calls back to the Workers URL.

Alternatively, serve static files from KV or R2 for lower latency.

## Migration / Data Import

Importing an existing SQLite database export (same JSON format as `node rssnetwork.js export backup.json`) into D1:

```javascript
// import.js
export async function importFromNodeExport(db, jstruct) {
    // Wrap everything in a transaction for atomicity
    const batch = [];
    
    for (const user of jstruct.users) {
        batch.push(db.prepare(
            "insert or replace into users (screenname, emailAddress, emailSecret, prefs, ctHits, ctHitsToday, whenLastHit, whenCreated, whenUpdated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(user.screenname, user.emailAddress, user.emailSecret, user.prefs, user.ctHits, user.ctHitsToday, user.whenLastHit, user.whenCreated, user.whenUpdated));
    }
    for (const item of jstruct.items) {
        batch.push(db.prepare(
            "insert or replace into items (id, feedUrl, author, inReplyTo, title, link, description, pubDate, enclosureUrl, enclosureType, enclosureLength, markdowntext, outlineJsontext, flDeleted, whenCreated, whenUpdated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(item.id, item.feedUrl, item.author, item.inReplyTo, item.title, item.link, item.description, item.pubDate, item.enclosureUrl, item.enclosureType, item.enclosureLength, item.markdowntext, item.outlineJsontext, item.flDeleted, item.whenCreated, item.whenUpdated));
    }
    for (const like of jstruct.likes) {
        batch.push(db.prepare(
            "insert or replace into likes (screenname, itemId, whenCreated) values (?, ?, ?)"
        ).bind(like.screenname, like.itemId, like.whenCreated));
    }
    for (const file of jstruct.files) {
        batch.push(db.prepare(
            "insert or replace into files (path, type, filecontents, whenCreated, whenUpdated, ctSaves) values (?, ?, ?, ?, ?, ?)"
        ).bind(file.path, file.type, file.filecontents, file.whenCreated, file.whenUpdated, file.ctSaves));
    }
    for (const media of jstruct.media) {
        // Media bytes go to R2; metadata goes to D1
        // Buffer.from() works in Workers via Node.js polyfill
        if (media.mediabytes) {
            const bytes = (typeof media.mediabytes === 'string')
                ? Buffer.from(media.mediabytes, 'base64')
                : media.mediabytes;
            const r2Key = `media/${media.id}`;
            await env.MEDIA_BUCKET.put(r2Key, bytes);
            batch.push(db.prepare(
                "insert or replace into media (id, screenname, type, r2Key, size, whenCreated) values (?, ?, ?, ?, ?, ?)"
            ).bind(media.id, media.screenname, media.type, r2Key, media.size, media.whenCreated));
        }
    }
    
    // Execute all inserts in one batch
    await db.batch(batch);
}
```

Operators export from an existing Node server (`node rssnetwork.js export backup.json`), then import into a fresh D1 database (`curl -X POST -d @backup.json https://myserver.chat/admin/import`).

## Sorted Query Strategies

D1 is SQLite — all sorted queries use standard `ORDER BY` with the same SQL as the original `rssnetwork.js`. No reverse-timestamp key tricks, no N+1 gets. The DO storage plan's prefix-list strategies are replaced by indexed SQL queries.

| Query | Approach |
|---|---|
| `getRecentItems` | `select ... from items left join users ... where flDeleted = 0 order by pubDate desc limit ?` |
| `getRecentUserItems` | `select ... from items left join users ... where feedUrl = ? and flDeleted = 0 order by pubDate desc limit ?` |
| `getItemAndReplies` | `select ... where (id = ? or inReplyTo = ?) and flDeleted = 0 order by pubDate asc` |
| `getMostActiveToday` | `select ... from users order by ctHitsToday desc, ctHits desc limit 100` |

## Service Limits & Feasibility

| Service | Limit | rss.chat needs | OK? |
|---|---|---|---|
| D1 storage | 2 GB (5 GB paid) | <50 MB for typical instance | ✅ |
| D1 rows per query | 100 (default), 1,000 (paid) | 100 items per feed page | ✅ |
| R2 storage | 10 GB free, $0.015/GB thereafter | <100 MB for typical instance | ✅ |
| R2 Class A ops (write) | 1M free / month | <1K for typical instance | ✅ |
| R2 Class B ops (read) | 10M free / month | <10K for typical instance | ✅ |
| DO CPU per invocation | 30s | <1s per request | ✅ |
| DO wake from cold | ~100ms | Acceptable | ✅ |

**D1 latency:** Each D1 query is a network round-trip from the DO (~5-50ms). A `newPost` call does ~5 sequential D1 queries (getUserByEmail → addItem → writeDatabaseFile × 3 feeds). At 10ms each, that's ~50ms total — acceptable for a write endpoint. Reads (single SELECT) are one round-trip.

## Limitations vs Node.js Server

| Feature | Node.js | Cloudflare DO |
|---|---|---|
| `export` CLI verb | file I/O | D1 `SELECT *` + JSON serialization |
| `import` CLI verb | file I/O | D1 bulk INSERT in a transaction |
| `config.json` hot-reload | reads from disk | env vars, requires deploy |
| `whitelist` / `blockedUsersList` | from config.json, re-read on every request | from D1 `blocked_emails` / `whitelist_emails` tables, updated via admin API (no deploy) |
| `urlExtrasOpml` feed fetch | `opml.readOutline(url)` | same — `fetch(url)` in DO, then parse with `opml` |
| RSS Cloud ping | `rss.cloudPing()` | same — pure JS, works in Workers |
| `daveappserver` page serving | built-in | Workers replaces directly |

Everything in the "Limitations" column is either a one-time config change or handled by a small `fetch()` wrapper. No dealbreakers.

## Implementation Order

1. **Scaffold** — `wrangler.toml`, `package.json`, `src/index.js` skeleton, `src/config.js`
2. **Copy `transform.js`** — pure functions from `rssnetwork.js`, adapted to accept config as parameter
3. **Implement `d1-data-access.js`** — all storage methods as D1 SQL queries
4. **Copy `orchestrator.js`** — business logic from `rssnetwork.js`, adapted to call `dataAccess.*` and `transform.*`
5. **Build DO class** — `rsschat-do.js`: constructor wires everything, `routeRequest()` mirrors `handleHttpRequest` switch, `broadcast()` for WebSocket
6. **Handle read endpoints** — `/getuserdata`, `/getrecentitems`, `/feed`, `/media/N`, `/getiteminfo`, `/getitembyguid`, `/getitemandreplies`, `/getlikerslist`, `/getmostactivetoday`, `/getsubscriptionlist`, `/checkwhitelist`, `/robots.txt`
7. **Handle write endpoints** — `/newpost`, `/updatepost`, `/deletepost`, `/togglelike`, `/saveprefs`, `/uploadmedia` (each triggers feed regeneration)
8. **Auth flow** — email sending (`email.js` via SendGrid/Resend), magic link redirect, `/sendconfirmingemail`, `/createnewuser`
9. **WebSocket** — DO WebSocket upgrade, magic link auth on connect, broadcast on writes
10. **Feeds** — `publishFeedFile` writes to D1 `files` table; feed URLs serve from D1
11. **Media** — R2-backed media storage for uploads > 128 KB
12. **Import tool** — `POST /admin/import` consuming Node export JSON, `import.js` bulk writer
13. **Deploy + verify** — `wrangler dev` local testing, then `wrangler deploy`, DNS

## Verification

- All 20+ API endpoints return identical responses to the Node.js server (compare against `rss.chat` or a local Node instance).
- Feed URLs (`/users/{name}/rss.xml`) serve valid RSS 2.0; `/feed?format=xml` and `/feed?format=json` match.
- WebSocket firehose delivers `newItem` and `updatedItem` messages.
- Magic link sign-in creates users, sets secrets, and redirects correctly.
- Media upload and retrieval works for images under 2 MB.
- Export → import round-trip preserves all data and IDs.
- `wrangler dev` local testing works.
- No regression in the original Node.js server (untouched).

---

## Appendix: Implementation Reference

### Source file

All logic is copied from `server/code/rssnetwork.js` (2268 lines, Node.js, CommonJS). This file is generated from an OPML outline — do not modify it. The file lives at:

```
server/code/rssnetwork.js
```

Existing npm package versions (from `server/code/package.json`):

```json
{
  "dependencies": {
    "turndown": "7.2.2",
    "autolinker": "4.1.5",
    "sanitize-html": "2.17.1",
    "better-sqlite3": "11.10.0",
    "daveappserver": "*",
    "daverss": "*",
    "davesql": "*",
    "opml": "*",
    "daveutils": "*"
  }
}
```

The `cloudflare/package.json` needs only: `daverss`, `daveutils`, `opml`, `turndown`, `autolinker`, `sanitize-html`. Omit `daveappserver`, `davesql`, `better-sqlite3`, `request`, `daves3`, `fs`, `path` (platform-only).

### Error convention

rssnetwork.js uses a consistent error shape throughout:

```javascript
// Error objects passed as first arg to callbacks:
{message: "Can't add the post because there is no user with email \"x@y.com\"."}

// Some carry an HTTP status code:
{message: "Can't serve the file ... because there is no file with that path.", code: 404}

// HTTP responses follow the same pattern:
returnError(err) → theRequest.httpReturn(503, "text/plain", err.message)
httpReturn(err, data) → if err.code, use it as status; otherwise 503
```

The DO must replicate this: errors are `{message: "..."}` objects, responses use status 503 (or `err.code` if present) with `text/plain` body containing `err.message`.

### `onWrite` hook — breaking circular dependencies

In rssnetwork.js, three Category C (database) functions call upward into orchestration or platform code:

| Function | Calls | Why it's a problem |
|---|---|---|
| `addItem` | `notifySocketSubscribers("newItem", ...)` | Platform (WebSocket) |
| `updateItem` | `notifySocketSubscribers("updatedItem", ...)` | Platform (WebSocket) |
| `addUser` | `updateSubscriptionListOnS3()` | Orchestration (rebuilds OPML, writes to S3/DB) |

In the DO, `d1-data-access.js` cannot call back into `rsschat-do.js` or `orchestrator.js` without creating a require cycle. The solution: `D1DataAccess` constructor accepts an `onWrite` callback. Methods fire it instead of calling upward:

```javascript
// In d1-data-access.js constructor:
this.onWrite = function () {}; // no-op default

// In addItem, after successful INSERT:
this.onWrite("itemChanged", {verb: "newItem", item: convertedItem});

// In addUser, after successful INSERT:
this.onWrite("userAdded", {screenname: userRec.screenname});
```

The DO class wires it (see DO Class Design section above). `orchestrator.js` functions never call `notifySocketSubscribers` or `updateSubscriptionListOnS3` directly — they call `dataAccess.addItem(...)` and the hook fires.

### Functions the DO class owns (not in orchestrator.js)

These are reimplemented in `rsschat-do.js` because they are platform-specific:

| Function | Original (rssnetwork.js) | DO implementation |
|---|---|---|
| `isEmailBlocked` | `fs.readFileSync("config.json")` (every request) | Async: `db.prepare("SELECT email FROM blocked_emails WHERE email = ?").bind(email).first()`. **Fail-open**: empty table = nobody blocked. Updated via `/admin/block` and `/admin/unblock` (no deploy). |
| `userIsBlocked` | calls `isEmailBlocked`, returns `true`/`false` | Same logic, calls DO's `isEmailBlocked` (now async) |
| `checkWhitelist` | `fs.readFile("config.json")` (async, every request) | Query `whitelist_emails` table. Empty table → `{flWhitelisted: true}` (all allowed, fail-open). Populated → check membership. Updated via `/admin/whitelist` and `/admin/unwhitelist` (no deploy). |
| `handleHttpRequest` | daveappserver router, 200+ lines | `routeRequest(url, method, params, body)` in DO class |
| `startup` | reads config, inits DB, starts daveappserver | DO constructor (wires modules, config loaded from env) |
| `notifySocketSubscribers` | daveappserver WebSocket broadcast | `this.broadcast(verb, payload)` |
| `publishFeedFile` | S3 or `writeDatabaseFile` | Write to D1 `files` table via `writeDatabaseFile` (same upsert SQL as original `flFeedsInDatabase` path) |

### Porting Gotchas

Things that differ subtly between Node.js and DO and aren't obvious from the code:

1. **`Buffer.from(base64, "base64")`** — Workers now provide a Node.js `Buffer` polyfill. The original `rssnetwork.js` base64 decode works without modification. No `atob()` + `Uint8Array` workaround needed.

5. **`checkWhitelist` and `isEmailBlocked` use D1, not env vars** — Original `isEmailBlocked` calls `fs.readFileSync("config.json")` on every auth check; `checkWhitelist` calls `fs.readFile` (async) on every call. The DO queries D1 `blocked_emails` and `whitelist_emails` tables instead. Changes take effect immediately via `/admin/block`, `/admin/unblock`, `/admin/whitelist`, `/admin/unwhitelist` — no deploy cycle. Do NOT use env vars for this; that would reintroduce deploy friction.

3. **`/isuserindatabase` calls `findUserWithScreenname`, not `getUserInfoByScreenname`** — `findUserWithScreenname` has callback `(flFound, userInfo)`, not `(err, result)`. The DO routing for this endpoint must call `getUserByScreenname` and convert to `{flInDatabase: userRec !== undefined}`.

4. **`updateReplyFeeds` is recursive** — When a comment is posted, `updateReplyFeeds` publishes the parent's comments feed, and if the parent is itself a reply (`parentItem.inReplyToNum !== undefined`), recursively publishes its parent's feed too. The DO orchestrator must preserve this chain.

5. **`notifySocketSubscribers` gated by `flWebsocketEnabled`** — Original only broadcasts if `config.flWebsocketEnabled` is true. DO can always broadcast (WebSocket is standard), but if you add a flag to disable it, gate `this.broadcast()` on that flag.

6. **`publishFeedFile` path mapping** — Original `writeDatabaseFile("/users/" + relpath, ...)`. D1 stores files in the `files` table with the same `path` column as the original SQLite schema. The HTTP `default` case reads from `theRequest.lowerpath` (e.g., `/users/alice/rss.xml`), which maps directly to `SELECT * FROM files WHERE path = ?`.

7. **`toggleLike` → `onWrite` for `addLike`/`removeLike`** — In the original, `toggleLike` calls `notifySocketSubscribers` directly. In the DO, `addLike` and `removeLike` must fire `onWrite("itemChanged", ...)` so the broadcast happens automatically. `toggleLike` in the orchestrator does NOT call broadcast — it just calls `dataAccess.addLike` / `dataAccess.removeLike` and the hook fires.

8. **Import duplicate emails** — `emailAddress` has no UNIQUE constraint in the original schema (`getUserInfoByEmail` returns the first matching row). Imported data can have multiple users with the same email. The DO should detect duplicates at import time and either fail, pick-first, or merge. Auth assumes one email = one screenname.

9. **`getUserData` exposes stale `flWhitelist`** — Original `getUserData` reads `config.whitelist` from startup config (set once), while `checkWhitelist` rereads `config.json` dynamically. In the DO, both query the `whitelist_emails` D1 table, so they're always consistent. `getUserData` returns `flWhitelist: true` when the table is empty (fail-open).

### Complete DataAccess interface

Every method signature matches the callers in `orchestrator.js`. All methods are callback-based: `function(arg, arg, callback)` where `callback(err, result)`.

**Exception:** Several orchestration functions use 3-argument callbacks — the routing layer must unwrap them before passing to `httpReturn(err, data)`: `buildFeedForUser` callback is `(err, xmltext, format)`, `getUserFeed` is `(err, xmltext, format)`, `buildCommentsFeed` is `(err, xmltext, parentItem)`.

**Users:**
- `getUser(screenname, callback)` → returns user record or `undefined`
- `getUserByEmail(email, callback)` → returns user record or `undefined`
- `addUser(userRec, callback)` → returns userRec (fires `onWrite("userAdded", ...)`)
- `updateUser(userRec, callback)` → returns userRec
- `getAllScreennames(callback)` → returns `["name1", "name2", ...]`

**Items:**
- `addItem(itemRec, callback)` → returns itemRec with `.id` set (fires `onWrite("itemChanged", ...)`)
- `updateItem(itemRec, callback)` → returns itemRec (fires `onWrite("itemChanged", ...)`)
- `getItemById(screenname, id, callback)` → returns converted item or `undefined`
- `getItemByGuid(screenname, guid, callback)` → returns converted item or `undefined`; returns error if `flDeleted`
- `getRecentItems(screenname, maxCt, callback)` → returns array of converted items
- `getRecentUserItems(screenname, feedUrl, maxCt, callback)` → returns array of converted items
- `getItemAndReplies(screenname, idParent, callback)` → returns array of converted items (parent + replies)
- `softDeleteItem(id, callback)` → marks `flDeleted = 1`

**Likes:**
- `addLike(screenname, itemId, callback)` → returns likesRec
- `removeLike(screenname, itemId, callback)` → returns `{}`
- `isLiked(screenname, itemId, callback)` → returns `true`/`false`
- `getLikersList(itemId, callback)` → returns `["screenname", ...]`

**Files:**
- `writeFile(path, type, contents, callback)` → returns fileRec (upsert: insert or update)
- `readFile(path, callback)` → returns `{type, filecontents, ...}` or error with `code: 404`

**Media:**
- `addMedia(mediaRec, callback)` → returns mediaRec with `.id` set
- `getMedia(id, callback)` → returns `{screenname, type, mediabytes, size, ...}` or error with `code: 404`

**Stats:**
- `bumpUserHits(screenname, callback)` → increments `ctHits` and `ctHitsToday`
- `getMostActiveToday(callback)` → returns array of `{screenname, name, imageUrl, ctHits, ctHitsToday, whenLastHit}`

**Admin:**
- `exportAll(callback)` → returns full JSON object (same shape as Node export)
- `importAll(jstruct, callback)` → bulk-imports users, items, likes, files, media

**Note:** `softDeleteItem` and `updateUserPrefs` are added because the original rssnetwork.js has inline SQL in `deletePost` and `savePrefs`. The DO data-access layer must provide these so the orchestrator never touches storage directly.

```javascript
// In orchestrator.js — deletePost calls:
dataAccess.softDeleteItem(id, function (err) { ... });

// In orchestrator.js — savePrefs calls:
dataAccess.updateUserPrefs(screenname, jsontext, function (err) { ... });
```

### Config: derived fields

Two config fields are computed at init time by `initDatabaseUrls()` in rssnetwork.js:

```javascript
// When flFeedsInDatabase is true:
config.rssFeedUrl = config.urlServerForClient + "users/";
config.opmlListUrl = config.urlServerForClient + "data/subs.opml";
```

In the DO, `config.js` must set these after reading env vars. Feeds are always served from the D1 `files` table (equivalent to `flFeedsInDatabase: true`), so these are always derived.

### `legalTags` config (security)

Used by `sanitizeHtmltext` to strip dangerous HTML from posts. Default from rssnetwork.js:

```javascript
legalTags: {
    allowedTags: ["p", "br", "a", "b", "i", "strong", "em", "img", "blockquote", "ul", "ol", "li", "h3"],
    allowedAttributes: {
        a: ["href"],
        img: ["src", "alt"]
    }
}
```

This must be present in the DO config. Consider making it a hardcoded default in `config.js` rather than an env var (it's a security boundary, not operator-configurable in practice).

### Source line numbers for functions to copy

Functions in `server/code/rssnetwork.js` with their line numbers:

**Category A — copy to `transform.js`:**

| Function | Lines | Depends on |
|---|---|---|
| `getMarkdownFromHtml` | 111–114 | `turndown` |
| `linkifyUrls` | 125–157 | `autolinker`, `utils.stringLower` |
| `trimTrailingBlankLines` | 206–238 | `config.flRemoveBlanksAtEnd` |
| `sanitizeHtmltext` | 240–247 | `sanitize-html`, `config.legalTags` |
| `convertString` | 386–393 | — |
| `convertNumber` | 395–399 | — |
| `convertDate` | 401–409 | — |
| `convertJson` | 411–416 | — |
| `convertUser` | 418–427 | `convertString`, `convertDate`, `convertJson` |
| `convertItem` | 429–473 | `convertString/Number/Date`, `getPermalinkUrl`, `getInReplyToPermalink`, `utils.getBoolean` |
| `initDatabaseUrls` | 196–204 | `config.*` (mutates config) |
| `getFeedUrl` | 836–839 | `config.rssFeedUrl`, `config.rssFilename` |
| `getCommentsFeedUrl` | 122–124 | `config.rssFeedUrl` |
| `getPermalinkUrl` | 1181–1183 | `config.urlServerForClient` |
| `getInReplyToPermalink` | 1185–1191 | `config.urlServerForClient` |
| `getDefaultHeadElements` | 841–854 | `config.*`, `myVersion`, `myProductName` |
| `buildFeedItems` | 910–948 | `getCommentsFeedUrl` |

**Category B — copy to `orchestrator.js`:**

| Function | Lines | Calls |
|---|---|---|
| `newPost` | 1258–1318 | `isEmailBlocked`, `getUserInfoByEmail`, `sanitizeHtmltext`, `linkifyUrls`, `trimTrailingBlankLines`, `addItem`, `updateFeedsOnS3`, `updateReplyFeedsOnS3` |
| `updatePost` | 1321–1392 | `isEmailBlocked`, `getUserInfoByEmail`, `getItemById`, `sanitizeHtmltext`, `linkifyUrls`, `trimTrailingBlankLines`, `updateItem`, `updateFeedsOnS3`, `updateReplyFeedsOnS3` |
| `deletePost` | 1439–1473 | `validateUser`, `userOwnsItem`, `softDeleteItem`, `updateFeedsOnS3`, `updateReplyFeedsOnS3` |
| `validateUser` | 1395–1415 | `getUserInfoByEmail` |
| `userOwnsItem` | 1417–1437 | `getItemById` |
| `uploadMedia` | 1484–1542 | `isEmailBlocked`, `getUserInfoByEmail`, `addMedia` |
| `savePrefs` | 1561–1589 | `getUserInfoByEmail`, `updateUserPrefs`, `bumpUserHits` |
| `toggleLikeEndpoint` | 1770–1787 | `validateUser`, `toggleLike` |
| `toggleLike` | 1738–1768 | `isLiked`, `addLike`/`removeLike`, `getItemById`, `broadcast` |
| `buildFeedForUser` | 950–1002 | `getDefaultHeadElements`, `getFeedUrl`, `getRecentUserItems`, `buildFeedItems`, `rss.buildRssFeed`/`rss.buildJsonFeed` |
| `buildCommentsFeed` | 1005–1047 | `getItemAndReplies`, `getDefaultHeadElements`, `getCommentsFeedUrl`, `buildFeedItems`, `rss.buildRssFeed` |
| `buildFeedForEveryone` | 1049–1073 | `getDefaultHeadElements`, `getRecentItems`, `buildFeedItems`, `rss.buildRssFeed` |
| `pingCloud` | 1076–1082 | `rss.cloudPing` |
| `updateFeedsOnS3` | 1084–1123 | `buildFeedForUser`, `publishFeedFile`, `buildFeedForEveryone`, `rss.cloudPing` |
| `updateReplyFeedsOnS3` | 882–908 | `publishCommentsFeed`, `getUserInfoByScreenname`, `updateFeedsOnS3` |
| `publishCommentsFeed` | 856–879 | `buildCommentsFeed`, `publishFeedFile` |
| `getSubscriptionList` | 1126–1155 | `getAllScreennames`, `getFeedUrl`, `opml.stringify` |
| `updateSubscriptionListOnS3` | 1157–1178 | `getSubscriptionList`, `writeFile` or `s3.newObject` |
| `getUserData` | 1194–1231 | `getUserInfoByScreenname`, `getFeedUrl`, `utils.mergeOptions` |
| `getUserFeed` | 1234–1255 | `getUserInfoByScreenname`, `buildFeedForUser` |
| `getItemInfo` | 1659–1688 | `getItemByGuid`, `buildFeedItems` |
| `bumpUserHits` | 1545–1558 | D1 SQL (increments counters via UPDATE) |
| `backfillFeeds` | 788–834 | Node-only (not copied) |
| `backfillCommentsFeeds` | 773–786 | Node-only (not copied) |
| `getExtrasList` | 73–91 | Node-only (not copied) |

**Category D — reimplement in `rsschat-do.js`:** `handleHttpRequest` (1982–2167), `startup` (2170–2267), `notifySocketSubscribers` (116–120).
