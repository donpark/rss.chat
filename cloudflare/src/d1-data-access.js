// d1-data-access.js — DataAccess implementation against Cloudflare D1
// Mirrors the callback-based interface of rssnetwork.js's Category C functions,
// but uses async/await (promises) since D1 is promise-based.
//
// The onWrite hook fires side effects that would normally call upward into
// platform code (notifySocketSubscribers, updateSubscriptionList).

import { convertUser, convertItem, convertString, convertNumber, convertDate } from './transform.js';
import utils from "daveutils";

export class D1DataAccess {
    constructor(db, config, transform) {
        this.db = db;
        this.config = config;
        this.transform = transform;
        this.onWrite = function () {}; // wired by rsschat-do.js
    }

    // ---- Users ----

    async getUser(screenname) {
        const result = await this.db.prepare(
            "select * from users where screenname = ?"
        ).bind(screenname).first();
        return result ? convertUser(result) : undefined;
    }

    async getUserByEmail(email) {
        const result = await this.db.prepare(
            "select * from users where emailAddress = ?"
        ).bind(email).first();
        return result ? convertUser(result) : undefined;
    }

    async addUser(userRec) {
        await this.db.prepare(
            "insert into users (screenname, emailAddress, emailSecret) values (?, ?, ?)"
        ).bind(userRec.screenname, userRec.emailAddress, userRec.emailSecret).run();
        this.onWrite("userAdded", { screenname: userRec.screenname });
        return userRec;
    }

    async updateUser(userRec) {
        const result = await this.db.prepare(
            "update users set emailAddress = ?, emailSecret = ? where screenname = ?"
        ).bind(userRec.emailAddress, userRec.emailSecret, userRec.screenname).run();
        if (result.changes === 0) {
            throw { message: "Can't update the user because there is no user with screenname \"" + userRec.screenname + "\"." };
        }
        return userRec;
    }

    async updateUserPrefs(screenname, jsontext) {
        await this.db.prepare(
            "update users set prefs = ? where screenname = ?"
        ).bind(jsontext, screenname).run();
    }

    async getAllScreennames() {
        const result = await this.db.prepare(
            "select screenname from users"
        ).all();
        return result.results.map(r => r.screenname);
    }

    // ---- Items ----

    async addItem(itemRec) {
        const result = await this.db.prepare(
            `insert into items (feedUrl, title, link, description, inReplyTo, pubDate,
             enclosureUrl, enclosureType, enclosureLength, markdowntext, outlineJsontext, author)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            itemRec.feedUrl, itemRec.title, itemRec.link, itemRec.description,
            itemRec.inReplyTo, itemRec.pubDate, itemRec.enclosureUrl, itemRec.enclosureType,
            itemRec.enclosureLength, itemRec.markdowntext, itemRec.outlineJsontext, itemRec.author
        ).run();
        itemRec.id = result.meta.last_row_id;
        // Fire onWrite after getting the converted item
        const convertedItem = convertItem(this.config, itemRec);
        this.onWrite("itemChanged", { verb: "newItem", item: convertedItem });
        return itemRec;
    }

    async updateItem(itemRec) {
        if (itemRec.id === undefined) {
            throw { message: "Can't update the item because no id was provided." };
        }
        let setClause = "";
        const values = [];
        function add(fieldname, theValue) {
            if (theValue !== undefined) {
                if (setClause.length > 0) setClause += ", ";
                setClause += fieldname + " = ?";
                values.push(theValue);
            }
        }
        add("feedUrl", itemRec.feedUrl);
        add("title", itemRec.title);
        add("link", itemRec.link);
        add("description", itemRec.description);
        add("inReplyTo", itemRec.inReplyTo);
        add("pubDate", itemRec.pubDate);
        add("enclosureUrl", itemRec.enclosureUrl);
        add("enclosureType", itemRec.enclosureType);
        add("enclosureLength", itemRec.enclosureLength);
        add("markdowntext", itemRec.markdowntext);
        add("outlineJsontext", itemRec.outlineJsontext);
        add("author", itemRec.author);
        if (setClause.length === 0) {
            throw { message: "Can't update the item because no fields were provided." };
        }
        values.push(itemRec.id);
        const result = await this.db.prepare(
            `update items set ${setClause} where id = ?`
        ).bind(...values).run();
        if (result.changes === 0) {
            throw { message: "Can't update the item because there is no item with id " + itemRec.id + "." };
        }
        const convertedItem = convertItem(this.config, itemRec);
        this.onWrite("itemChanged", { verb: "updatedItem", item: convertedItem });
        return itemRec;
    }

    async getItemById(screenname, id) {
        const sqltext = `select items.*,
            (select count(*) from likes where likes.itemId = items.id) as ctLikes,
            (select count(*) from likes where likes.itemId = items.id and likes.screenname = ?) as flLiked,
            (select count(*) from items c where c.inReplyTo = items.id and (c.flDeleted is null or c.flDeleted = 0)) as ctReplies,
            (select coalesce (nullif (u2.prefs ->> '$.myFeedTitle', ''), i2.author)
                from items i2 left join users u2 on u2.screenname = i2.author
                where i2.id = items.inReplyTo) as inReplyToAuthor
            from items where id = ?`;
        const result = await this.db.prepare(sqltext).bind(screenname, id).first();
        return result ? convertItem(this.config, result) : undefined;
    }

    async getItemByGuid(screenname, guid) {
        if (guid == undefined) {
            throw { message: "Can't get the item record because the GUID param is undefined." };
        }
        const theId = utils.stringNthField(guid, "=", 2);
        const sqltext = `select items.*,
            users.prefs ->> '$.myAvatarImageUrl' as imageUrl,
            users.prefs ->> '$.myFeedTitle' as feedTitle,
            users.prefs ->> '$.myFeedLink' as feedLink,
            users.prefs ->> '$.myFeedDescription' as feedDescription,
            (select count(*) from likes where likes.itemId = items.id) as ctLikes,
            (select count(*) from likes where likes.itemId = items.id and likes.screenname = ?) as flLiked,
            (select count(*) from items c where c.inReplyTo = items.id and (c.flDeleted is null or c.flDeleted = 0)) as ctReplies,
            (select coalesce (nullif (u2.prefs ->> '$.myFeedTitle', ''), i2.author)
                from items i2 left join users u2 on u2.screenname = i2.author
                where i2.id = items.inReplyTo) as inReplyToAuthor
            from items left join users on users.screenname = items.author
            where items.id = ?`;
        const result = await this.db.prepare(sqltext).bind(screenname, theId).first();
        if (!result) return undefined;
        const itemRec = convertItem(this.config, result);
        if (itemRec.flDeleted) {
            throw { message: "Can't view the post because it has been deleted." };
        }
        return itemRec;
    }

    async getRecentItems(screenname, maxCt) {
        if (maxCt === undefined) maxCt = this.config.maxRecentItems;
        else {
            maxCt = Number(maxCt);
            if (maxCt > this.config.maxRecentItems) maxCt = this.config.maxRecentItems;
        }
        const sqltext = `select items.*,
            users.prefs ->> '$.myAvatarImageUrl' as imageUrl,
            users.prefs ->> '$.myFeedTitle' as feedTitle,
            users.prefs ->> '$.myFeedLink' as feedLink,
            users.prefs ->> '$.myFeedDescription' as feedDescription,
            (select count(*) from likes where likes.itemId = items.id) as ctLikes,
            (select count(*) from likes where likes.itemId = items.id and likes.screenname = ?) as flLiked,
            (select count(*) from items c where c.inReplyTo = items.id and (c.flDeleted is null or c.flDeleted = 0)) as ctReplies,
            (select coalesce (nullif (u2.prefs ->> '$.myFeedTitle', ''), i2.author)
                from items i2 left join users u2 on u2.screenname = i2.author
                where i2.id = items.inReplyTo) as inReplyToAuthor
            from items left join users on users.screenname = items.author
            where (items.flDeleted is null or items.flDeleted = 0)
            order by pubDate desc limit ?`;
        const result = await this.db.prepare(sqltext).bind(screenname, maxCt).all();
        return result.results.map(r => convertItem(this.config, r));
    }

    async getRecentUserItems(screenname, feedUrl, maxCt) {
        const sqltext = `select items.*,
            users.prefs ->> '$.myAvatarImageUrl' as imageUrl,
            users.prefs ->> '$.myFeedTitle' as feedTitle,
            users.prefs ->> '$.myFeedLink' as feedLink,
            users.prefs ->> '$.myFeedDescription' as feedDescription,
            (select count(*) from likes where likes.itemId = items.id) as ctLikes,
            (select count(*) from likes where likes.itemId = items.id and likes.screenname = ?) as flLiked,
            (select count(*) from items c where c.inReplyTo = items.id and (c.flDeleted is null or c.flDeleted = 0)) as ctReplies,
            (select coalesce (nullif (u2.prefs ->> '$.myFeedTitle', ''), i2.author)
                from items i2 left join users u2 on u2.screenname = i2.author
                where i2.id = items.inReplyTo) as inReplyToAuthor
            from items left join users on users.screenname = items.author
            where items.feedUrl = ? and (items.flDeleted is null or items.flDeleted = 0)
            order by pubDate desc limit ?`;
        const result = await this.db.prepare(sqltext).bind(screenname, feedUrl, maxCt).all();
        return result.results.map(r => convertItem(this.config, r));
    }

    async getItemAndReplies(screenname, idParent) {
        const sqltext = `select items.*,
            users.prefs ->> '$.myAvatarImageUrl' as imageUrl,
            users.prefs ->> '$.myFeedTitle' as feedTitle,
            users.prefs ->> '$.myFeedLink' as feedLink,
            users.prefs ->> '$.myFeedDescription' as feedDescription,
            (select count(*) from likes where likes.itemId = items.id) as ctLikes,
            (select count(*) from likes where likes.itemId = items.id and likes.screenname = ?) as flLiked,
            (select count(*) from items c where c.inReplyTo = items.id and (c.flDeleted is null or c.flDeleted = 0)) as ctReplies,
            (select coalesce (nullif (u2.prefs ->> '$.myFeedTitle', ''), i2.author)
                from items i2 left join users u2 on u2.screenname = i2.author
                where i2.id = items.inReplyTo) as inReplyToAuthor
            from items left join users on users.screenname = items.author
            where (items.id = ? or items.inReplyTo = ?) and (items.flDeleted is null or items.flDeleted = 0)
            order by pubDate asc`;
        const result = await this.db.prepare(sqltext).bind(screenname, idParent, idParent).all();
        return result.results.map(r => convertItem(this.config, r));
    }

    async softDeleteItem(id) {
        await this.db.prepare(
            "update items set flDeleted = 1 where id = ?"
        ).bind(id).run();
    }

    // ---- Likes ----

    async addLike(screenname, itemId) {
        const likesRec = { screenname, itemId, whenCreated: new Date() };
        await this.db.prepare(
            "replace into likes (screenname, itemId, whenCreated) values (?, ?, ?)"
        ).bind(screenname, itemId, likesRec.whenCreated.toISOString()).run();
        return likesRec;
    }

    async removeLike(screenname, itemId) {
        await this.db.prepare(
            "delete from likes where screenname = ? and itemId = ?"
        ).bind(screenname, itemId).run();
        return {};
    }

    async isLiked(screenname, itemId) {
        const result = await this.db.prepare(
            "select count(*) as ct from likes where screenname = ? and itemId = ?"
        ).bind(screenname, itemId).first();
        return result.ct > 0;
    }

    async getLikersList(itemId) {
        const result = await this.db.prepare(
            "select screenname from likes where itemId = ? order by whenCreated"
        ).bind(itemId).all();
        return result.results.map(r => r.screenname);
    }

    // ---- Files ----

    async writeFile(path, type, contents) {
        const now = new Date().toISOString();
        // Upsert: insert or update
        await this.db.prepare(
            `insert into files (path, type, filecontents, whenCreated, whenUpdated, ctSaves)
             values (?, ?, ?, ?, ?, 1)
             on conflict (path) do update set
                type = excluded.type,
                filecontents = excluded.filecontents,
                whenUpdated = ?,
                ctSaves = ctSaves + 1`
        ).bind(path.toLowerCase(), type, contents, now, now, now).run();
        return { path: path.toLowerCase(), type, filecontents: contents, whenUpdated: now };
    }

    async readFile(path) {
        const result = await this.db.prepare(
            "select * from files where path = ?"
        ).bind(path).first();
        if (!result) {
            const err = new Error("Can't serve the file " + path + " because there is no file with that path.");
            err.code = 404;
            throw err;
        }
        return result;
    }

    // ---- Media (metadata only — blobs in R2) ----

    async addMedia(mediaRec) {
        const result = await this.db.prepare(
            "insert into media (screenname, type, r2Key, size) values (?, ?, ?, ?)"
        ).bind(mediaRec.screenname, mediaRec.type, mediaRec.r2Key, mediaRec.size).run();
        mediaRec.id = result.meta.last_row_id;
        return mediaRec;
    }

    async getMedia(id) {
        const idMedia = Number(id);
        if (isNaN(idMedia)) {
            const err = new Error("Can't get the media item because the id \"" + id + "\" isn't a number.");
            err.code = 404;
            throw err;
        }
        const result = await this.db.prepare(
            "select * from media where id = ?"
        ).bind(idMedia).first();
        if (!result) {
            const err = new Error("Can't get the media item because there is no item with id \"" + id + "\".");
            err.code = 404;
            throw err;
        }
        return result;
    }

    // ---- Stats ----

    async bumpUserHits(screenname) {
        const now = new Date().toISOString();
        await this.db.prepare(
            `update users set
                ctHits = ctHits + 1,
                ctHitsToday = case when date(whenLastHit) = date(?) then ctHitsToday + 1 else 1 end,
                whenLastHit = ?
             where screenname = ?`
        ).bind(now, now, screenname).run();
    }

    async getMostActiveToday() {
        const sqltext = `select screenname,
            coalesce (nullif (prefs ->> '$.myFeedTitle', ''), screenname) as name,
            prefs ->> '$.myAvatarImageUrl' as imageUrl,
            ctHits, ctHitsToday, whenLastHit
            from users order by ctHitsToday desc, ctHits desc limit 100`;
        const result = await this.db.prepare(sqltext).all();
        return result.results.map(row => ({
            screenname: convertString(row.screenname),
            name: convertString(row.name),
            imageUrl: convertString(row.imageUrl),
            ctHits: convertNumber(row.ctHits),
            ctHitsToday: convertNumber(row.ctHitsToday),
            whenLastHit: convertDate(row.whenLastHit)
        }));
    }

    // ---- Blocked / Whitelist (D1-backed, no deploy needed) ----

    async isEmailBlocked(email) {
        if (email === undefined) return false;
        const result = await this.db.prepare(
            "select email from blocked_emails where email = ?"
        ).bind(email).first();
        return result !== null;
    }

    async checkWhitelist(email) {
        if (await this.isEmailBlocked(email)) {
            return { flWhitelisted: false };
        }
        const anyWhitelist = await this.db.prepare(
            "select email from whitelist_emails limit 1"
        ).first();
        if (!anyWhitelist) {
            return { flWhitelisted: true }; // no whitelist = all allowed (fail-open)
        }
        const result = await this.db.prepare(
            "select email from whitelist_emails where email = ?"
        ).bind(email).first();
        return { flWhitelisted: result !== null };
    }

    // ---- Admin ----

    async exportAll() {
        const tables = ["users", "items", "likes", "files", "media"];
        const jstruct = {};
        for (const table of tables) {
            const result = await this.db.prepare(`select * from ${table}`).all();
            jstruct[table] = result.results;
        }
        return jstruct;
    }

    async importAll(jstruct) {
        const batch = [];
        for (const user of (jstruct.users || [])) {
            batch.push(this.db.prepare(
                "insert or replace into users (screenname, emailAddress, emailSecret, prefs, ctHits, ctHitsToday, whenLastHit, whenCreated, whenUpdated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(user.screenname, user.emailAddress, user.emailSecret, user.prefs,
                user.ctHits || 0, user.ctHitsToday || 0, user.whenLastHit, user.whenCreated, user.whenUpdated));
        }
        for (const item of (jstruct.items || [])) {
            batch.push(this.db.prepare(
                "insert or replace into items (id, feedUrl, author, inReplyTo, title, link, description, pubDate, enclosureUrl, enclosureType, enclosureLength, markdowntext, outlineJsontext, flDeleted, whenCreated, whenUpdated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(item.id, item.feedUrl, item.author, item.inReplyTo, item.title, item.link,
                item.description, item.pubDate, item.enclosureUrl, item.enclosureType,
                item.enclosureLength, item.markdowntext, item.outlineJsontext,
                item.flDeleted || 0, item.whenCreated, item.whenUpdated));
        }
        for (const like of (jstruct.likes || [])) {
            batch.push(this.db.prepare(
                "insert or replace into likes (screenname, itemId, whenCreated) values (?, ?, ?)"
            ).bind(like.screenname, like.itemId, like.whenCreated));
        }
        for (const file of (jstruct.files || [])) {
            batch.push(this.db.prepare(
                "insert or replace into files (path, type, filecontents, whenCreated, whenUpdated, ctSaves) values (?, ?, ?, ?, ?, ?)"
            ).bind(file.path, file.type, file.filecontents, file.whenCreated, file.whenUpdated, file.ctSaves || 1));
        }
        for (const media of (jstruct.media || [])) {
            batch.push(this.db.prepare(
                "insert or replace into media (id, screenname, type, r2Key, size, whenCreated) values (?, ?, ?, ?, ?, ?)"
            ).bind(media.id, media.screenname, media.type, media.r2Key || `media/${media.id}`, media.size, media.whenCreated));
        }
        if (batch.length > 0) {
            await this.db.batch(batch);
        }
    }
}
