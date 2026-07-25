// transform.js — Pure transformation functions copied from rssnetwork.js
// Adapted for ESM exports. Functions that referenced global config/module vars
// now accept them as parameters.

import TurndownService from "turndown";
import Autolinker from "autolinker";
import sanitizeHtml from "sanitize-html";
import utils from "daveutils";

// myVersion and myProductName are global in rssnetwork.js — 
// we embed them as config fields or pass via the factory.
const myVersion = "0.6.3";
const myProductName = "rss.network";

// ---- Misc transforms ----

export function getMarkdownFromHtml(htmltext) {
    const myTurndown = new TurndownService();
    const markdowntext = myTurndown.turndown(htmltext);
    return markdowntext;
}

export function getCommentsFeedUrl(config, screenname, idPost) {
    return config.rssFeedUrl + screenname + "/comments/" + idPost + ".xml";
}

export function linkifyUrls(htmltext) {
    if (htmltext === undefined) {
        return undefined;
    }
    const fileExtensionsNotDomains = ["md", "zip", "sh", "py"];
    const theLinker = new Autolinker({
        urls: true,
        email: false,
        phone: false,
        stripPrefix: false,
        stripTrailingSlash: false,
        newWindow: false,
        replaceFn: function (match) {
            if (match.getType() === "url") {
                if (match.getUrlMatchType() === "tld") {
                    const matchedText = utils.stringLower(match.getMatchedText());
                    let flLooksLikeFilename = false;
                    fileExtensionsNotDomains.forEach(function (extension) {
                        if (matchedText.endsWith("." + extension)) {
                            flLooksLikeFilename = true;
                        }
                    });
                    if (flLooksLikeFilename) {
                        return false;
                    }
                }
            }
            return true;
        }
    });
    return theLinker.link(htmltext);
}

export function trimTrailingBlankLines(config, theText) {
    if (config.flRemoveBlanksAtEnd) {
        if (theText === undefined) {
            return undefined;
        }
        const regexTrailingWhitespace = /(\s|&nbsp;)+$/i;
        const regexEmptyFinalParagraph = /<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>$/i;
        const regexBreaksBeforeFinalClose = /(\s|&nbsp;|<br\s*\/?>)+<\/p>$/i;
        let flChanged = true;
        while (flChanged) {
            flChanged = false;
            if (regexTrailingWhitespace.test(theText)) {
                theText = theText.replace(regexTrailingWhitespace, "");
                flChanged = true;
            }
            if (regexEmptyFinalParagraph.test(theText)) {
                theText = theText.replace(regexEmptyFinalParagraph, "");
                flChanged = true;
            }
            else {
                if (regexBreaksBeforeFinalClose.test(theText)) {
                    theText = theText.replace(regexBreaksBeforeFinalClose, "</p>");
                    flChanged = true;
                }
            }
        }
        return theText;
    }
    return theText;
}

export function sanitizeHtmltext(config, htmltext) {
    if (htmltext === undefined) {
        return undefined;
    }
    return sanitizeHtml(htmltext, config.legalTags);
}

// ---- Type converters ----

export function convertString(theString) {
    if ((theString === null) || (theString === undefined)) {
        return undefined;
    }
    if (theString.length === 0) {
        return undefined;
    }
    return theString;
}

export function convertNumber(theNumber) {
    if ((theNumber === null) || (theNumber === undefined)) {
        return undefined;
    }
    return theNumber;
}

export function convertDate(theDate) {
    if ((theDate === null) || (theDate === undefined)) {
        return undefined;
    }
    const d = new Date(theDate);
    if (isNaN(d)) {
        return undefined;
    }
    return d;
}

export function convertJson(jsontext) {
    if ((jsontext === null) || (jsontext === undefined)) {
        return undefined;
    }
    return JSON.parse(jsontext);
}

// ---- Record converters ----

export function convertUser(theUser) {
    return {
        screenname: convertString(theUser.screenname),
        emailAddress: convertString(theUser.emailAddress),
        emailSecret: convertString(theUser.emailSecret),
        imageUrl: convertString(theUser.imageUrl),
        whenCreated: convertDate(theUser.whenCreated),
        whenUpdated: convertDate(theUser.whenUpdated),
        prefs: convertJson(theUser.prefs)
    };
}

export function convertItem(config, theItem) {
    function getAuthor(theItem) {
        const feedTitle = convertString(theItem.feedTitle);
        if (feedTitle !== undefined) {
            return feedTitle;
        }
        return convertString(theItem.author);
    }
    const jstruct = {
        id: convertNumber(theItem.id),
        feedUrl: convertString(theItem.feedUrl),
        guid: getPermalinkUrl(config, theItem),
        title: convertString(theItem.title),
        inReplyToNum: convertNumber(theItem.inReplyTo),
        inReplyToUrl: getInReplyToPermalink(config, convertNumber(theItem.inReplyTo)),
        link: convertString(theItem.link),
        description: convertString(theItem.description),
        pubDate: convertDate(theItem.pubDate),
        enclosureUrl: convertString(theItem.enclosureUrl),
        enclosureType: convertString(theItem.enclosureType),
        enclosureLength: convertNumber(theItem.enclosureLength),
        whenCreated: convertDate(theItem.whenCreated),
        whenUpdated: convertDate(theItem.whenUpdated),
        markdowntext: convertString(theItem.markdowntext),
        outlineJsontext: convertString(theItem.outlineJsontext),
        imageUrl: convertString(theItem.imageUrl),
        author: getAuthor(theItem),
        screenname: convertString(theItem.author),
        feedLink: convertString(theItem.feedLink),
        feedDescription: convertString(theItem.feedDescription),
        flDeleted: utils.getBoolean(theItem.flDeleted),
        ctLikes: convertNumber(theItem.ctLikes),
        flLiked: utils.getBoolean(theItem.flLiked),
        inReplyToAuthor: convertString(theItem.inReplyToAuthor),
        ctReplies: convertNumber(theItem.ctReplies)
    };
    const theConvertedItem = {};
    for (const x in jstruct) {
        if (jstruct[x] !== undefined) {
            theConvertedItem[x] = jstruct[x];
        }
    }
    return theConvertedItem;
}

// ---- URL helpers ----

export function getPermalinkUrl(config, theItem) {
    return config.urlServerForClient + "?id=" + theItem.id;
}

export function getInReplyToPermalink(config, id) {
    if (id !== undefined) {
        return config.urlServerForClient + "?id=" + id;
    }
    return undefined;
}

export function getFeedUrl(config, screenname) {
    const relpath = screenname + "/" + config.rssFilename;
    return config.rssFeedUrl + relpath;
}

// ---- Feed building ----

export function getDefaultHeadElements(config) {
    return {
        language: config.rssLanguage,
        docs: config.rssDocs,
        maxFeedItems: config.rssMaxFeedItems,
        flRssCloudEnabled: config.rssCloudPort,
        rssCloudDomain: config.rssCloudDomain,
        rssCloudPort: config.rssCloudPort,
        rssCloudPath: config.rssCloudPath,
        rssCloudRegisterProcedure: config.rssCloudRegisterProcedure,
        rssCloudProtocol: config.rssCloudProtocol,
        generator: myProductName + " v" + myVersion
    };
}

export function buildFeedItems(config, items, flSourceAttribution = false) {
    const feedItems = [];
    items.forEach(function (theItem) {
        const feedItem = {
            text: theItem.description,
            when: theItem.pubDate,
            title: theItem.title,
            link: theItem.link,
            guid: { flPermalink: true, value: theItem.guid },
            markdowntext: theItem.markdowntext
        };
        if (theItem.enclosureUrl !== undefined) {
            feedItem.enclosure = {
                url: theItem.enclosureUrl,
                type: theItem.enclosureType,
                length: theItem.enclosureLength
            };
        }
        if (theItem.inReplyToUrl !== undefined) {
            feedItem.inReplyTo = {
                flPermalink: true,
                value: theItem.inReplyToUrl
            };
        }
        if (theItem.ctReplies > 0) {
            feedItem.comments = {
                count: theItem.ctReplies,
                feedUrl: getCommentsFeedUrl(config, theItem.screenname, theItem.id)
            };
        }
        if (flSourceAttribution) {
            feedItem.source = {
                url: theItem.feedUrl,
                title: theItem.author
            };
        }
        feedItems.push(feedItem);
    });
    return feedItems;
}
