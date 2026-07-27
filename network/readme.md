# What is the RSS.chat network?

rss.chat isn't really a product. It's an application built on something bigger: a network of feeds, lists, formats and protocols, all open, that anyone can plug into without asking permission. The app is one way to use the network. This page is a map of the rest of it.

Dave Winer wrote about the idea [on Scripting News](http://scripting.com/2026/07/26.html) -- the web as small pieces loosely joined, with the emphasis on small. If the pieces are connected by open formats and protocols, you can make anything you want out of the pieces. You can do what you want with the data, and if you want to build new data that includes this stuff, go right ahead.

Here are the pieces.

### Every user is a feed

From the moment an account is created, it has an RSS 2.0 feed at a predictable address. Dave's is [https://rss.chat/users/dave/rss.xml](https://rss.chat/users/dave/rss.xml) -- every user's feed is at `users/<screenname>/rss.xml`. Every post is an item in the author's feed. That means anything that reads RSS -- a feed reader, a script, another server -- is already a client of the RSS.chat network, with nothing to install and no key to request.

### The everyone feed

The whole community in a single feed: [https://rss.chat/users/rss.xml](https://rss.chat/users/rss.xml). Subscribe to it and you're following the server, not just one person.

### The subscription list

One OPML file listing every user's feed: [https://rss.chat/data/subs.opml](https://rss.chat/data/subs.opml). It's the reading list for the whole network, ready to hand to any feed reader or aggregator that takes subscription lists.

### The source namespace

Our feeds carry a few elements beyond core RSS, from the [source namespace](https://source.scripting.com/). The important one is `source:comments` -- it's how a post points to the feed of its replies, which is how conversations thread across the open web. There's also `source:account`, which says who published the feed and where to find them. The namespace is documented so other feeds can carry the same elements, and other readers can understand them.

### Textcasting

[Textcasting](http://textcasting.org/) is the spec for the posts themselves -- the features writers need, applied to social media the way podcasting applied enclosures to feeds. Six things: titles are optional, links work, simple styling (bold and italic), enclosures, unlimited length, and posts are editable. Every one of them is supported here, because our users are writers. When two apps both support the textcasting features, a post can move between them without losing anything the writer put into it.

### Markdown

Writers know markdown -- it's the closest thing writing on the web has to a lingua franca. And they trust it, because plain text has nowhere to hide anything. Writers don't like apps that add things to their writing, and markdown makes that visible: if HTML shows up in your text, you know something's been in there.

So the editor takes markdown, and it doesn't stop at the edit box: when a post is written in markdown, the feed carries the writer's original markdown in `source:markdown` alongside the rendered HTML in `description`. A consuming app gets both -- the finished output for display, and the source for editing or re-rendering. The writing survives the trip.

### The firehose

The server broadcasts over a websocket as posts arrive and change -- every new post, every edit, as it happens. It's how the rss.chat client keeps timelines current without polling, and any app can listen the same way. Documented in [the firehose doc](../server/docs/firehose.md), with working demo apps in [examples/firehose](../examples/firehose/).

### rssCloud

The firehose covers apps watching this server; [rssCloud](http://rsscloud.co/) is realtime for the feeds themselves, across servers, and it's been an open protocol since 2001. Every feed here carries a `<cloud>` element naming a notification server, and when a feed updates, the server pings it. Any subscriber anywhere that registered with the cloud gets notified within seconds -- it's why a post published on rss.chat shows up in FeedLand moments later, no polling involved.

### The API

For the things feeds can't do -- publishing a post, editing it, likes, reading a whole thread in one call -- there's an HTTP interface, documented in [api.md](../server/docs/api.md). Reading requires no authentication at all. Writing uses the same passwordless identity the app uses.

### The JavaScript interface

[api.js](../client/docs/apijs.md) is the API for browser-based apps -- every endpoint as a one-line method call, with the authentication and response handling done for you. It's the same code the rss.chat client itself runs on.

### The examples

[Working apps](../examples/readme.md), each small enough to read in one sitting: a blog renderer, a thread reader, firehose listeners, a WordPress connection. Each one is meant to be cribbed from.

### The worknotes feed

The project announces itself the way it publishes everything else -- as a feed: [https://news.rss.chat/worknotes/rss.xml](https://news.rss.chat/worknotes/rss.xml). Every improvement to rss.chat, server and client together, arrives as it ships, newest first. Subscribe and you'll hear the drum.

## It's already working

None of this is theoretical. [Micro.blog loads rss.chat conversations](https://news.micro.blog/2026/07/23/added-rudimentary-support-for-loading.html) by following the `source:comments` trail. Scott Hanson runs a service that mirrors his rss.chat posts to his WordPress site. People post from bash scripts and run the server on Raspberry Pis. Nobody asked permission, because there's no permission to ask -- the network is the open part, and the open part is the point.
