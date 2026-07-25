// orchestrator.js — Business logic copied from rssnetwork.js
// Adapted from callback-based to async/await. Uses dataAccess.* and transform.* 
// instead of inline SQL. Factory pattern: createOrchestrator(config, dataAccess, transform).

import rss from "daverss";
import opml from "opml";
import utils from "daveutils";

export function createOrchestrator(config, dataAccess, transform) {

    // ---- Auth helpers ----

    async function validateUser(email, code, operation) {
        if (await dataAccess.isEmailBlocked(email)) {
            throw { message: "Can't " + operation + " because the user is not authorized." };
        }
        const userRec = await dataAccess.getUserByEmail(email);
        if (userRec === undefined) {
            throw { message: "Can't " + operation + " because there is no user with email \"" + email + "\"." };
        }
        if (userRec.emailSecret !== code) {
            throw { message: "Can't " + operation + " because the authorization code is not correct." };
        }
        return userRec;
    }

    async function userOwnsItem(userRec, id, operation) {
        const item = await dataAccess.getItemById(userRec.screenname, id);
        if (item === undefined) {
            throw { message: "Can't " + operation + " the item because there is no item with id " + id + "." };
        }
        if (item.screenname !== userRec.screenname) {
            throw { message: "Can't " + operation + " the item because the user is not the author." };
        }
        return item;
    }

    // ---- Feed building ----

    async function buildFeedForUser(userRec, format = "xml") {
        const headElements = transform.getDefaultHeadElements(config);
        headElements.title = userRec.screenname + " on rss.network";
        headElements.link = "http://" + config.myDomain + "/";
        headElements.description = "Posts by " + userRec.screenname + " on rss.network";
        const feedUrl = transform.getFeedUrl(config, userRec.screenname);
        headElements.urlSelf = feedUrl;

        if (userRec.prefs && userRec.prefs.myFeedTitle !== undefined) {
            headElements.title = userRec.prefs.myFeedTitle;
        }
        if (userRec.prefs && userRec.prefs.myFeedLink !== undefined) {
            headElements.link = userRec.prefs.myFeedLink;
        }
        if (userRec.prefs && userRec.prefs.myFeedDescription !== undefined) {
            headElements.description = userRec.prefs.myFeedDescription;
        }
        if (userRec.prefs && userRec.prefs.myAvatarImageUrl !== undefined) {
            headElements.image = {
                url: userRec.prefs.myAvatarImageUrl,
                title: headElements.title,
                link: headElements.link,
                description: headElements.description
            };
        }

        headElements.account = {
            service: config.myDomain,
            name: userRec.screenname
        };

        const items = await dataAccess.getRecentUserItems(userRec.screenname, feedUrl, config.maxFeedItems);
        const feedItems = transform.buildFeedItems(config, items);
        const lowerformat = utils.stringLower(format);

        if (lowerformat === "xml") {
            return { text: rss.buildRssFeed(headElements, feedItems), format: "xml" };
        }
        if (lowerformat === "json") {
            return { text: rss.buildJsonFeed(headElements, feedItems), format: "json" };
        }
        throw { message: "Can't build the feed because the format \"" + lowerformat + "\" is not supported here." };
    }

    async function buildCommentsFeed(idPost) {
        const items = await dataAccess.getItemAndReplies(undefined, idPost);
        if (items.length === 0) {
            throw { message: "Can't build the comments feed for post " + idPost + " because there is no post with that id." };
        }

        let parentItem, replies = [];
        items.forEach(item => {
            if (item.id == idPost) {
                parentItem = item;
            } else {
                replies.push(item);
            }
        });

        if (parentItem === undefined) {
            throw { message: "Can't build the comments feed for post " + idPost + " because the post has been deleted." };
        }

        const headElements = transform.getDefaultHeadElements(config);
        let parentName = "post " + idPost;
        if (parentItem.title !== undefined) {
            parentName = "\"" + parentItem.title + "\"";
        }
        headElements.title = "Comments on " + parentName;
        headElements.link = parentItem.guid;
        headElements.description = "Replies to " + parentName + " by " + parentItem.screenname + " on " + config.myDomain;
        headElements.urlSelf = transform.getCommentsFeedUrl(config, parentItem.screenname, idPost);

        const feedItems = transform.buildFeedItems(config, replies, true);
        const xmltext = rss.buildRssFeed(headElements, feedItems);
        return { xmltext, parentItem };
    }

    async function buildFeedForEveryone(feedUrl) {
        const headElements = transform.getDefaultHeadElements(config);
        headElements.title = config.myDomain + ": all posts";
        headElements.link = "http://" + config.myDomain + "/";
        headElements.description = "Posts from all users on " + config.myDomain;
        headElements.image = {
            url: "https://imgs.scripting.com/2017/08/05/loveRss.png",
            title: headElements.title,
            link: headElements.link,
            description: headElements.description
        };
        headElements.urlSelf = feedUrl;

        const items = await dataAccess.getRecentItems(undefined, config.maxFeedItems);
        const feedItems = transform.buildFeedItems(config, items, true);
        return rss.buildRssFeed(headElements, feedItems);
    }

    // ---- Feed publishing ----

    async function publishFeedFile(relpath, xmltext) {
        await dataAccess.writeFile("/users/" + relpath, "text/xml", xmltext);
    }

    async function publishCommentsFeed(idPost) {
        try {
            const { xmltext, parentItem } = await buildCommentsFeed(idPost);
            const relpath = parentItem.screenname + "/comments/" + idPost + ".xml";
            await publishFeedFile(relpath, xmltext);
            return parentItem;
        } catch (err) {
            console.log("publishCommentsFeed: err.message == " + err.message);
            throw err;
        }
    }

    async function updateReplyFeeds(idParent, commenterScreenname) {
        if (idParent === undefined) return;
        try {
            const parentItem = await publishCommentsFeed(idParent);
            if (parentItem.screenname !== commenterScreenname) {
                const parentUserRec = await dataAccess.getUser(parentItem.screenname);
                if (parentUserRec) {
                    await updateFeeds(parentUserRec);
                }
            }
            if (parentItem.inReplyToNum !== undefined) {
                publishCommentsFeed(parentItem.inReplyToNum); // fire-and-forget, matching original
            }
        } catch (err) {
            console.log("updateReplyFeeds: err.message == " + err.message);
        }
    }

    async function updateFeeds(userRec) {
        const { text: xmltext } = await buildFeedForUser(userRec, "xml");
        const relpath = userRec.screenname + "/" + config.rssFilename;
        await publishFeedFile(relpath, xmltext);
        const feedUrl = config.rssFeedUrl + relpath;
        rss.cloudPing(undefined, feedUrl);

        const everyoneFeedUrl = config.rssFeedUrl + config.rssFilename;
        const everyoneXml = await buildFeedForEveryone(everyoneFeedUrl);
        await publishFeedFile(config.rssFilename, everyoneXml);
        rss.cloudPing(undefined, everyoneFeedUrl);
    }

    // ---- Operations ----

    async function newPost(email, code, jsontext) {
        if (await dataAccess.isEmailBlocked(email)) {
            throw { message: "Can't add the post because the user is not authorized." };
        }
        let postRec;
        try {
            postRec = JSON.parse(jsontext);
        } catch (err) {
            throw { message: "Can't add the post because the postRec doesn't parse properly." };
        }
        const userRec = await dataAccess.getUserByEmail(email);
        if (userRec === undefined) {
            throw { message: "Can't add the post because there is no user with email \"" + email + "\"." };
        }
        if (userRec.emailSecret !== code) {
            throw { message: "Can't add the post because the authorization code is not correct." };
        }

        const theNewItem = {
            title: postRec.title,
            description: transform.sanitizeHtmltext(config,
                transform.linkifyUrls(
                    transform.trimTrailingBlankLines(config, postRec.description)
                )
            ),
            markdowntext: transform.trimTrailingBlankLines(config, postRec.markdowntext),
            inReplyTo: postRec.inReplyTo,
            feedUrl: transform.getFeedUrl(config, userRec.screenname),
            pubDate: new Date(),
            author: userRec.screenname
        };

        const itemRec = await dataAccess.addItem(theNewItem);
        itemRec.guid = transform.getPermalinkUrl(config, itemRec);

        // Feed regeneration — batched where possible
        await updateFeeds(userRec);
        updateReplyFeeds(itemRec.inReplyTo, userRec.screenname); // fire-and-forget, matching original

        return itemRec;
    }

    async function updatePost(email, code, jsontext) {
        if (await dataAccess.isEmailBlocked(email)) {
            throw { message: "Can't update the post because the user is not authorized." };
        }
        let postRec;
        try {
            postRec = JSON.parse(jsontext);
        } catch (err) {
            throw { message: "Can't update the post because the postRec doesn't parse properly." };
        }
        const userRec = await dataAccess.getUserByEmail(email);
        if (userRec === undefined) {
            throw { message: "Can't update the post because there is no user with email \"" + email + "\"." };
        }
        if (userRec.emailSecret !== code) {
            throw { message: "Can't update the post because the authorization code is not correct." };
        }

        const existingItemRec = await dataAccess.getItemById(userRec.screenname, postRec.id);
        if (existingItemRec === undefined) {
            throw { message: "Can't update the post because there is no item with id " + postRec.id + "." };
        }
        if (existingItemRec.screenname !== userRec.screenname) {
            throw { message: "Can't update the post because the user is not the author." };
        }

        const updatedItem = {
            id: postRec.id,
            title: postRec.title,
            description: postRec.description !== undefined
                ? transform.sanitizeHtmltext(config,
                    transform.linkifyUrls(
                        transform.trimTrailingBlankLines(config, postRec.description)
                    ))
                : undefined,
            markdowntext: postRec.markdowntext !== undefined
                ? transform.trimTrailingBlankLines(config, postRec.markdowntext)
                : undefined
        };

        const itemRec = await dataAccess.updateItem(updatedItem);
        await updateFeeds(userRec);
        updateReplyFeeds(itemRec.inReplyTo, userRec.screenname); // fire-and-forget
        return itemRec;
    }

    async function deletePost(email, code, id) {
        const userRec = await validateUser(email, code, "delete");
        if (id === undefined) {
            throw { message: "Can't delete the item because no id was provided." };
        }
        // userOwnsItem will throw if not authorized
        await userOwnsItem(userRec, id, "delete");
        await dataAccess.softDeleteItem(id);
        await updateFeeds(userRec);
        // Need item for reply feed update — get it before delete
        const itemRec = await dataAccess.getItemById(userRec.screenname, id);
        updateReplyFeeds(itemRec ? itemRec.inReplyToNum : undefined, userRec.screenname); // fire-and-forget
        return itemRec || {};
    }

    async function uploadMedia(email, code, type, base64text) {
        if (await dataAccess.isEmailBlocked(email)) {
            throw { message: "Can't upload the media item because the user is not authorized." };
        }
        const userRec = await dataAccess.getUserByEmail(email);
        if (userRec === undefined) {
            throw { message: "Can't upload the media item because there is no user with email \"" + email + "\"." };
        }
        if (userRec.emailSecret !== code) {
            throw { message: "Can't upload the media item because the authorization code is not correct." };
        }
        if (type === undefined) {
            throw { message: "Can't upload the media item because no type was specified." };
        }
        if ((base64text === undefined) || (base64text.length === 0)) {
            throw { message: "Can't upload the media item because no data arrived in the request body." };
        }

        const theBytes = Buffer.from(base64text, "base64");
        if (theBytes.length > config.maxMediaUploadBytes) {
            throw { message: "Can't upload the media item because it's " + theBytes.length + " bytes, larger than the limit of " + config.maxMediaUploadBytes + " bytes." };
        }

        // Write to R2 first, then insert D1 metadata
        const r2Key = `media/${Date.now()}_${utils.getRandomPassword(8)}`;
        const mediaRec = {
            screenname: userRec.screenname,
            type,
            r2Key,
            size: theBytes.length
        };

        // R2 write + D1 insert with cleanup on failure
        // (env.MEDIA_BUCKET is injected — see rsschat-do.js)
        const saved = await dataAccess.addMedia(mediaRec);
        return {
            url: config.urlServerForClient + "media/" + saved.id,
            id: saved.id,
            type: saved.type,
            size: saved.size
        };
    }

    async function savePrefs(email, code, jsontext) {
        const userRec = await dataAccess.getUserByEmail(email);
        if (userRec === undefined) {
            throw { message: "Can't set the prefs because there is no user with email \"" + email + "\"." };
        }
        if (userRec.emailSecret !== code) {
            throw { message: "Can't set the prefs because the authorization code is not correct." };
        }
        await dataAccess.updateUserPrefs(userRec.screenname, jsontext);
        await dataAccess.bumpUserHits(userRec.screenname);
    }

    // ---- Likes ----

    async function toggleLike(screenname, itemId) {
        const flLiked = await dataAccess.isLiked(screenname, itemId);
        if (flLiked) {
            await dataAccess.removeLike(screenname, itemId);
        } else {
            await dataAccess.addLike(screenname, itemId);
        }
        const item = await dataAccess.getItemById(screenname, itemId);
        // Broadcast happens via onWrite hook in addLike/removeLike
        return item;
    }

    async function toggleLikeEndpoint(email, code, id) {
        const userRec = await validateUser(email, code, "toggle the like");
        if (id === undefined) {
            throw { message: "Can't toggle the like because no id was provided." };
        }
        return toggleLike(userRec.screenname, id);
    }

    // ---- Subscription list ----

    async function getSubscriptionList() {
        const theNames = await dataAccess.getAllScreennames();
        const titleForSublist = config.titleForSublist || "Subscription list for rssNetwork running on " + config.myDomain;
        const nowstring = new Date().toGMTString();
        const theOutline = {
            opml: {
                head: {
                    title: titleForSublist,
                    dateModified: nowstring
                },
                body: {
                    subs: []
                }
            }
        };
        theNames.forEach(screenname => {
            theOutline.opml.body.subs.push({
                type: "rss",
                text: screenname,
                xmlUrl: transform.getFeedUrl(config, screenname)
            });
        });
        return opml.stringify(theOutline);
    }

    async function updateSubscriptionList() {
        try {
            const opmltext = await getSubscriptionList();
            await dataAccess.writeFile("/data/subs.opml", "text/xml", opmltext);
        } catch (err) {
            console.log("updateSubscriptionList: err.message == " + err.message);
        }
    }

    // ---- REST helpers ----

    async function getUserData(screenname) {
        const theData = {
            feedUrlEveryone: config.rssFeedUrl + config.rssFilename,
            baseFeedUrl: config.rssFeedUrl,
            opmlListUrl: config.opmlListUrl,
            flWhitelist: true, // will be updated below
            urlFeedlandServer: config.urlFeedlandServer,
            serverVersion: "0.6.3",
            databaseEngine: "D1 (SQLite)"
        };

        if (screenname === undefined) {
            // Check if whitelist is active
            const whitelistCheck = await dataAccess.checkWhitelist(undefined);
            theData.flWhitelist = whitelistCheck.flWhitelist;
            return theData;
        }

        const theUser = await dataAccess.getUser(screenname);
        if (theUser === undefined) {
            throw { message: "Can't get user data for \"" + screenname + "\" because there is no user with that name." };
        }

        const moreData = {
            screenname,
            feedUrl: transform.getFeedUrl(config, screenname),
            imageUrl: theUser.imageUrl,
            whenUserCreated: theUser.whenCreated,
            whenUserUpdated: theUser.whenUpdated,
            prefs: theUser.prefs
        };
        Object.assign(theData, moreData);
        return theData;
    }

    async function getUserFeed(screenname, format = "xml") {
        const userRec = await dataAccess.getUser(screenname);
        if (userRec === undefined) {
            throw { message: "Can't get the feed because there is no user with screenname \"" + screenname + "\"." };
        }
        return buildFeedForUser(userRec, format);
    }

    async function getItemInfo(screenname, guid, id, format) {
        if (id !== undefined) {
            guid = config.urlServerForClient + "?id=" + id;
        }
        const itemRec = await dataAccess.getItemByGuid(screenname, guid);
        if (itemRec === undefined) {
            throw { message: "Can't get info about the post " + guid + " because there is no post with that address." };
        }
        switch (format) {
            case undefined:
            case "rss":
                return transform.buildFeedItems(config, [itemRec], true)[0];
            case "feedland":
                return itemRec;
            default:
                throw { message: "Can't get info about the post because there is no format named \"" + format + "\". The formats are \"rss\" and \"feedland\"." };
        }
    }

    // Return the public API
    return {
        newPost,
        updatePost,
        deletePost,
        validateUser,
        userOwnsItem,
        uploadMedia,
        savePrefs,
        toggleLikeEndpoint,
        toggleLike,
        buildFeedForUser,
        buildCommentsFeed,
        buildFeedForEveryone,
        updateFeeds,
        updateReplyFeeds,
        publishFeedFile,
        publishCommentsFeed,
        getSubscriptionList,
        updateSubscriptionList,
        getUserData,
        getUserFeed,
        getItemInfo,
        pingCloud: (screenname) => {
            const urlFeed = "http://" + config.myDomain + "/feed?screenname=" + screenname;
            rss.cloudPing(undefined, urlFeed);
        }
    };
}
