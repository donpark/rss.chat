# The RSS.chat validator

[valid.rss.chat](https://valid.rss.chat/) checks feeds and lists to see if they interop with RSS.chat-compatible apps.

Enter the URL of a feed or list and click Check to start the scan.

It reads the file at the address you give it, looks at the contents, and decides what it's looking at. It can recognize three kinds of files:

1. **A user's feed** -- one person's posts, the kind of feed rss.chat publishes for every user.
2. **An aggregate feed** -- a feed that gathers posts from more than one source.
3. **A subscription list** -- an OPML file listing feeds.

Each kind is checked by its own rules. To see which kind it decided your file was, look at the end of the small text under the results -- it says, for example, "The validator read this as a user feed."

It doesn't stop at the file you gave it. When the file points at other files, the validator reads those too. In a subscription list, it reads every feed the list names, to be sure each one answers. In a feed, it follows the addresses the items hand out -- the guid of each post, the feed of replies named by source:comments, the author's feed named by the source element, and the post a reply says it's replying to. You'll see each address go by in the progress line while it works.

It's a beta. The rules will grow and change as people run their feeds through it and tell us what they find.
