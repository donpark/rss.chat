// rsschat-do.js — Durable Object class + full HTTP routing + WebSocket + Alarms
// This is the brain of the Workers deployment. One DO instance per rss.chat server.

import { buildConfig } from './config.js';
import { D1DataAccess } from './d1-data-access.js';
import * as transform from './transform.js';
import { createOrchestrator } from './orchestrator.js';
import { sendConfirmationEmail } from './email.js';
import { uploadToR2, serveFromR2 } from './r2-media.js';

export class RssChatDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sockets = [];
        this.config = buildConfig(env);
        this.dataAccess = new D1DataAccess(env.DB, this.config, transform);
        this.orchestrator = createOrchestrator(this.config, this.dataAccess, transform);

        // Wire write-side effects — these fire from d1-data-access.js
        const self = this;
        this.dataAccess.onWrite = function (event, payload) {
            if (event === "itemChanged") {
                self.broadcast(payload.verb, { item: payload.item });
            } else if (event === "userAdded") {
                self.orchestrator.updateSubscriptionList();
            }
        };

        // Auth tokens cleanup alarm — fires every 15 minutes
        this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);
    }

    async alarm() {
        // Purge expired auth tokens
        await this.env.DB.prepare(
            "DELETE FROM auth_tokens WHERE whenCreated < datetime('now', '-15 minutes')"
        ).run();
        // Re-schedule
        this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);
    }

    // ---- HTTP entry point ----

    async fetch(request) {
        const url = new URL(request.url);
        const upgrade = request.headers.get("Upgrade");

        if (upgrade === "websocket") {
            return this.handleWebSocketUpgrade(request);
        }

        try {
            return await this.routeRequest(request, url);
        } catch (err) {
            return this.returnError(err);
        }
    }

    // ---- WebSocket ----

    handleWebSocketUpgrade(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.sockets.push(server);
        server.accept();

        server.addEventListener("message", async (event) => {
            try {
                const msg = JSON.parse(event.data);
                // Magic link auth over WebSocket: { verb: "auth", email, code }
                if (msg.verb === "auth") {
                    const user = await this.dataAccess.getUserByEmail(msg.email);
                    if (user && user.emailSecret === msg.code) {
                        server.send(JSON.stringify({ verb: "authenticated", screenname: user.screenname }));
                    } else {
                        server.send(JSON.stringify({ verb: "authFailed" }));
                    }
                }
            } catch (e) {
                // ignore malformed messages
            }
        });

        server.addEventListener("close", () => {
            const ix = this.sockets.indexOf(server);
            if (ix >= 0) this.sockets.splice(ix, 1);
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    broadcast(verb, payload) {
        const msg = JSON.stringify({ verb, ...payload });
        for (const ws of this.sockets) {
            try { ws.send(msg); } catch (e) { /* socket dead, cleaned up on close */ }
        }
    }

    // ---- HTTP Routing ----

    async routeRequest(request, url) {
        const lowerpath = url.pathname.toLowerCase();
        const params = Object.fromEntries(url.searchParams);
        const method = request.method.toUpperCase();

        switch (lowerpath) {
            // ---- Read endpoints ----
            case "/feed":
                return this.handleFeed(params);

            case "/getuserdata":
                return this.handleGetUserData(params);

            case "/getsubscriptionlist":
                return this.returnText(await this.orchestrator.getSubscriptionList());

            case "/getrecentitems":
                return this.handleGetRecentItems(params);

            case "/getitembyguid":
                return this.handleGetItemByGuid(params);

            case "/checkwhitelist":
                return this.handleCheckWhitelist(params);

            case "/isuserindatabase":
                return this.handleIsUserInDatabase(params);

            case "/isemailindatabase":
                return this.handleIsEmailInDatabase(params);

            case "/getlikerslist":
                return this.returnData(await this.dataAccess.getLikersList(params.id));

            case "/getrecentuseritems":
                return this.handleGetRecentUserItems(params);

            case "/getitemandreplies":
                return this.returnData(
                    await this.dataAccess.getItemAndReplies(params.screenname, params.idparent)
                );

            case "/getmostactivetoday":
                return this.returnData(await this.dataAccess.getMostActiveToday());

            case "/getiteminfo":
                return this.handleGetItemInfo(params);

            case "/robots.txt":
                if (this.config.robotsText.length > 0) {
                    return this.returnText(this.config.robotsText);
                }
                return this.returnText("");

            // ---- Write endpoints ----
            case "/newpost":
                return this.handleNewPost(params, request);

            case "/updatepost":
                return this.handleUpdatePost(params, request);

            case "/deletepost":
                return this.handleDeletePost(params);

            case "/saveprefs":
                return this.handleSavePrefs(params, request);

            case "/togglelike":
                return this.handleToggleLike(params);

            case "/uploadmedia":
                return this.handleUploadMedia(params, request);

            // ---- Auth endpoints ----
            case "/sendconfirmingemail":
                return this.handleSendConfirmingEmail(params);

            case "/createnewuser":
                return this.handleCreateNewUser(params);

            case "/confirm":
                return this.handleConfirm(params);

            // ---- Admin endpoints ----
            case "/admin/import":
                return this.handleAdminImport(request);

            case "/admin/block":
                return this.handleAdminBlock(params);

            case "/admin/unblock":
                return this.handleAdminUnblock(params);

            case "/admin/whitelist":
                return this.handleAdminWhitelist(params);

            case "/admin/unwhitelist":
                return this.handleAdminUnwhitelist(params);

            // ---- Misc ----
            case "/favicon.ico":
                return this.returnRedirect(this.config.urlFavicon);

            case "/":
                return this.returnProxy(this.config.urlServerHomePageSource);

            // ---- Default: serve media or files ----
            default:
                return this.handleDefault(lowerpath);
        }
    }

    // ---- Read endpoint handlers ----

    async handleFeed(params) {
        const { text, format } = await this.orchestrator.getUserFeed(params.screenname, params.format);
        if (format === "xml") {
            return new Response(text, { headers: { "content-type": "text/xml" } });
        }
        return new Response(text, { headers: { "content-type": "application/json" } });
    }

    async handleGetUserData(params) {
        return this.returnData(await this.orchestrator.getUserData(params.screenname));
    }

    async handleGetRecentItems(params) {
        const ct = params.ct !== undefined ? Number(params.ct) : this.config.maxRecentItems;
        return this.returnData(await this.dataAccess.getRecentItems(params.screenname, ct));
    }

    async handleGetItemByGuid(params) {
        return this.returnData(await this.dataAccess.getItemByGuid(params.screenname, params.guid));
    }

    async handleCheckWhitelist(params) {
        return this.returnData(await this.dataAccess.checkWhitelist(params.emailaddress));
    }

    async handleIsUserInDatabase(params) {
        const user = await this.dataAccess.getUser(params.screenname);
        return this.returnData({ flInDatabase: user !== undefined });
    }

    async handleIsEmailInDatabase(params) {
        const user = await this.dataAccess.getUserByEmail(params.email);
        return this.returnData({ flInDatabase: user !== undefined });
    }

    async handleGetRecentUserItems(params) {
        const feedUrl = transform.getFeedUrl(this.config, params.name);
        return this.returnData(
            await this.dataAccess.getRecentUserItems(params.screenname, feedUrl, this.config.maxRecentItems)
        );
    }

    async handleGetItemInfo(params) {
        return this.returnData(
            await this.orchestrator.getItemInfo(params.screenname, params.guid, params.id, params.format)
        );
    }

    // ---- Write endpoint handlers ----

    async handleNewPost(params, request) {
        const body = await request.text();
        const itemRec = await this.orchestrator.newPost(params.emailaddress, params.emailcode, body);
        return this.returnData(itemRec);
    }

    async handleUpdatePost(params, request) {
        const body = await request.text();
        const itemRec = await this.orchestrator.updatePost(params.emailaddress, params.emailcode, body);
        return this.returnData(itemRec);
    }

    async handleDeletePost(params) {
        const itemRec = await this.orchestrator.deletePost(params.emailaddress, params.emailcode, params.id);
        return this.returnData(itemRec);
    }

    async handleSavePrefs(params, request) {
        const body = await request.text();
        await this.orchestrator.savePrefs(params.emailaddress, params.emailcode, body);
        return this.returnData({});
    }

    async handleToggleLike(params) {
        const item = await this.orchestrator.toggleLikeEndpoint(params.emailaddress, params.emailcode, params.id);
        return this.returnData(item);
    }

    async handleUploadMedia(params, request) {
        const base64text = await request.text();
        // Write to R2 first, then register in D1
        const { r2Key, size } = await uploadToR2(this.env, base64text);
        const mediaRec = {
            screenname: "", // filled in below after user validation
            type: params.type,
            r2Key,
            size
        };

        // Validate user
        if (await this.dataAccess.isEmailBlocked(params.emailaddress)) {
            // Cleanup orphaned blob
            await this.env.MEDIA_BUCKET.delete(r2Key);
            throw { message: "Can't upload the media item because the user is not authorized." };
        }
        const userRec = await this.dataAccess.getUserByEmail(params.emailaddress);
        if (!userRec || userRec.emailSecret !== params.emailcode) {
            await this.env.MEDIA_BUCKET.delete(r2Key);
            throw { message: "Can't upload the media item because the authorization code is not correct." };
        }
        if ((base64text === undefined) || (base64text.length === 0)) {
            await this.env.MEDIA_BUCKET.delete(r2Key);
            throw { message: "Can't upload the media item because no data arrived." };
        }

        mediaRec.screenname = userRec.screenname;
        const saved = await this.dataAccess.addMedia(mediaRec);
        return this.returnData({
            url: this.config.urlServerForClient + "media/" + saved.id,
            id: saved.id,
            type: saved.type,
            size: saved.size
        });
    }

    // ---- Auth endpoint handlers ----

    async handleSendConfirmingEmail(params) {
        if (await this.dataAccess.isEmailBlocked(params.email)) {
            throw { message: "Can't send the confirming email because the user is not authorized." };
        }
        const userRec = await this.dataAccess.getUserByEmail(params.email);
        if (!userRec) {
            throw { message: "Can't send the confirming email because there is no user with that email." };
        }

        const magicToken = crypto.randomUUID();
        await this.env.DB.prepare(
            "insert into auth_tokens (token, email, screenname, operation, urlredirect) values (?, ?, ?, ?, ?)"
        ).bind(magicToken, params.email, userRec.screenname, "confirm", params.urlredirect).run();

        const confirmUrl = this.config.urlServerForEmail + "confirm?token=" + magicToken;
        const providers = { sendgridKey: this.env.SENDGRID_KEY, resendKey: this.env.RESEND_KEY, sendEmailBinding: this.env.EMAIL };
        await sendConfirmationEmail(this.config, providers, params.email, confirmUrl);
        return this.returnData({});
    }

    async handleCreateNewUser(params) {
        const screenname = params.name; // client sends "name", not "screenname"
        if (await this.dataAccess.isEmailBlocked(params.email)) {
            throw { message: "Can't create the user because the user is not authorized." };
        }

        // Check screenname availability
        const existingUser = await this.dataAccess.getUser(screenname);
        if (existingUser) {
            throw { message: "Can't create the user because there is already a user with that name." };
        }

        // Check email availability
        const existingEmail = await this.dataAccess.getUserByEmail(params.email);
        if (existingEmail) {
            throw { message: "Can't create the user because that email address is already in use." };
        }

        // Pre-confirm user creation (matching original behavior)
        const emailSecret = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
        await this.dataAccess.addUser({
            screenname,
            emailAddress: params.email,
            emailSecret
        });

        // Generate magic token for confirmation
        const magicToken = crypto.randomUUID();
        await this.env.DB.prepare(
            "insert into auth_tokens (token, email, screenname, operation, urlredirect) values (?, ?, ?, ?, ?)"
        ).bind(magicToken, params.email, screenname, "signup", params.urlredirect).run();

        const confirmUrl = this.config.urlServerForEmail + "confirm?token=" + magicToken;
        const providers = { sendgridKey: this.env.SENDGRID_KEY, resendKey: this.env.RESEND_KEY, sendEmailBinding: this.env.EMAIL };
        await sendConfirmationEmail(this.config, providers, params.email, confirmUrl);
        return this.returnData({});
    }

    async handleConfirm(params) {
        const row = await this.env.DB.prepare(
            "select * from auth_tokens where token = ? and whenCreated > datetime('now', '-15 minutes')"
        ).bind(params.token).first();

        if (!row) {
            const url = (params.urlredirect || "/") + "?error=invalid_token";
            return this.returnRedirect(url);
        }

        // Get the user's persistent emailSecret
        const userRec = await this.dataAccess.getUser(row.screenname);
        if (!userRec) {
            const url = row.urlredirect + "?error=user_not_found";
            return this.returnRedirect(url);
        }

        // Delete the one-time token
        await this.env.DB.prepare("delete from auth_tokens where token = ?").bind(params.token).run();

        // Redirect with credentials
        const redirectUrl = row.urlredirect +
            "?emailconfirmed=true" +
            "&email=" + encodeURIComponent(row.email) +
            "&code=" + encodeURIComponent(userRec.emailSecret) +
            "&screenname=" + encodeURIComponent(row.screenname);
        return this.returnRedirect(redirectUrl);
    }

    // ---- Admin endpoint handlers ----

    async handleAdminImport(request) {
        const jstruct = await request.json();
        // Import all data into D1
        await this.dataAccess.importAll(jstruct);

        // For media items, upload base64-decoded bytes to R2
        if (jstruct.media) {
            for (const media of jstruct.media) {
                if (media.mediabytes) {
                    const bytes = typeof media.mediabytes === "string"
                        ? Buffer.from(media.mediabytes, "base64")
                        : media.mediabytes;
                    await this.env.MEDIA_BUCKET.put(media.r2Key || `media/${media.id}`, bytes);
                }
            }
        }
        return this.returnData({ success: true });
    }

    async handleAdminBlock(params) {
        await this.env.DB.prepare(
            "insert or ignore into blocked_emails (email) values (?)"
        ).bind(params.email).run();
        return this.returnData({ blocked: params.email });
    }

    async handleAdminUnblock(params) {
        await this.env.DB.prepare(
            "delete from blocked_emails where email = ?"
        ).bind(params.email).run();
        return this.returnData({ unblocked: params.email });
    }

    async handleAdminWhitelist(params) {
        await this.env.DB.prepare(
            "insert or ignore into whitelist_emails (email) values (?)"
        ).bind(params.email).run();
        return this.returnData({ whitelisted: params.email });
    }

    async handleAdminUnwhitelist(params) {
        await this.env.DB.prepare(
            "delete from whitelist_emails where email = ?"
        ).bind(params.email).run();
        return this.returnData({ unwhitelisted: params.email });
    }

    // ---- Default route: media or files ----

    async handleDefault(lowerpath) {
        // Media: /media/N
        if (lowerpath.startsWith("/media/")) {
            const mediaId = lowerpath.split("/").pop();
            const mediaRec = await this.dataAccess.getMedia(mediaId);
            const object = await serveFromR2(this.env, mediaRec.r2Key);
            return new Response(object.body, {
                headers: { "content-type": mediaRec.type }
            });
        }

        // Files: /users/* and /data/*
        if (lowerpath.startsWith("/users/") || lowerpath.startsWith("/data/")) {
            try {
                const fileRec = await this.dataAccess.readFile(lowerpath);
                return new Response(fileRec.filecontents, {
                    headers: { "content-type": fileRec.type }
                });
            } catch (err) {
                return new Response(err.message, { status: err.code || 404 });
            }
        }

        return new Response("Not found", { status: 404 });
    }

    // ---- Response helpers ----

    returnData(jstruct) {
        if (jstruct === undefined) jstruct = {};
        return new Response(JSON.stringify(jstruct, null, 2), {
            headers: { "content-type": "application/json" }
        });
    }

    returnText(text) {
        return new Response(text, {
            headers: { "content-type": "text/plain" }
        });
    }

    returnError(err) {
        const status = err.code || 503;
        return new Response(err.message, {
            status,
            headers: { "content-type": "text/plain" }
        });
    }

    returnRedirect(url, code = 302) {
        return new Response(code + " REDIRECT", {
            status: code,
            headers: { "Location": url }
        });
    }

    async returnProxy(url) {
        const response = await fetch(url);
        if (!response.ok) return response;
        let html = await response.text();
        html = html
            .replace(/\[%productNameForDisplay%\]/g, this.config.productNameForDisplay)
            .replace(/\[%productName%\]/g, this.config.productName)
            .replace(/\[%urlServerForClient%\]/g, this.config.urlServerForClient)
            .replace(/\[%myDomain%\]/g, this.config.myDomain)
            .replace(/\[%feedUrlEveryone%\]/g, this.config.rssFeedUrl + this.config.rssFilename);
        return new Response(html, {
            headers: { "content-type": "text/html" }
        });
    }
}
