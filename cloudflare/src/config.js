// config.js — build config object from environment variables
// Matches the shape rssnetwork.js expects.

export function buildConfig(env) {
    const config = {
        productName: env.PRODUCT_NAME || "rssChat",
        productNameForDisplay: env.PRODUCT_NAME || "rssChat",
        myDomain: env.MY_DOMAIN || "myserver.chat",
        urlServerForClient: env.URL_SERVER_FOR_CLIENT || "https://myserver.chat/",
        urlServerForEmail: env.URL_SERVER_FOR_EMAIL || env.URL_SERVER_FOR_CLIENT || "https://myserver.chat/",
        urlServerHomePageSource: env.URL_SERVER_HOME_PAGE_SOURCE || "https://code.scripting.com/rsschat/index.html",
        flWebsocketEnabled: true, // always enabled in DO
        urlWebsocketServerForClient: "",

        maxFeedItems: parseInt(env.MAX_FEED_ITEMS, 10) || 100,
        maxRecentItems: parseInt(env.MAX_RECENT_ITEMS, 10) || 100,
        maxMediaUploadBytes: parseInt(env.MAX_MEDIA_UPLOAD_BYTES, 10) || 2 * 1024 * 1024,

        rssLanguage: env.RSS_LANGUAGE || "en-us",
        rssDocs: env.RSS_DOCS || "http://cyber.law.harvard.edu/rss/rss.html",
        rssMaxFeedItems: parseInt(env.RSS_MAX_FEED_ITEMS, 10) || 100,
        flRssCloudEnabled: env.FL_RSS_CLOUD_ENABLED !== "false",
        rssCloudDomain: env.RSS_CLOUD_DOMAIN || "rpc.rsscloud.io",
        rssCloudPort: parseInt(env.RSS_CLOUD_PORT, 10) || 5337,
        rssCloudPath: env.RSS_CLOUD_PATH || "/pleaseNotify",
        rssCloudRegisterProcedure: env.RSS_CLOUD_REGISTER_PROCEDURE || "",
        rssCloudProtocol: env.RSS_CLOUD_PROTOCOL || "http-post",

        flFeedsInDatabase: true, // always true — feeds served from D1 files table
        flRemoveBlanksAtEnd: env.FL_REMOVE_BLANKS_AT_END !== "false",
        rssFilename: "rss.xml",

        robotsText: env.ROBOTS_TEXT || "",
        urlFavicon: env.URL_FAVICON || "",
        urlFeedlandServer: env.URL_FEEDLAND_SERVER || "https://feedland.social/",
        urlFeedlandRedirect: env.URL_FEEDLAND_REDIRECT || "https://feedland.social/?item=",

        mailSender: env.MAIL_SENDER || "",
        confirmEmailSubject: env.CONFIRM_EMAIL_SUBJECT || "rss.chat confirmation",
        operationToConfirm: env.OPERATION_TO_CONFIRM || "sign in to rss.chat",

        // Security boundary — hardcoded, not operator-configurable
        legalTags: {
            allowedTags: ["p", "br", "a", "b", "i", "strong", "em", "img", "blockquote", "ul", "ol", "li", "h3"],
            allowedAttributes: {
                a: ["href"],
                img: ["src", "alt"]
            }
        }
    };

    // Derived fields (equivalent to initDatabaseUrls in rssnetwork.js)
    config.rssFeedUrl = config.urlServerForClient + "users/";
    config.opmlListUrl = config.urlServerForClient + "data/subs.opml";

    return config;
}
