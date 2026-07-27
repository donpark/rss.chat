# How we document APIs

We put a lot into this API, and it would be a shame to lose a single developer because the docs steered them wrong. This page is how we try to make sure that never happens. It's a living document -- as we learn more about what makes API docs work, it lands here. If you're documenting your own service, take whatever's useful.

1. **The reader is a user, not a student of the system.** They came to build their thing, not to learn how ours is built. Document what they can do and what they'll see; how the system works on the inside stays out. When an internal fact is genuinely interesting, it goes in one short note at the end of the entry -- a curiosity, never a prerequisite.

2. **Examples are the documentation.** Lead with the smallest call that works, built from values the reader actually has in hand. Follow with a complete call they can copy and run, the response it produces, and what an error looks like. If the only way to learn a call is to read example code somewhere else -- test scripts, the client source -- the doc isn't done. Test scripts were written by people who already knew everything; docs are for people who don't yet.

3. **Hand them every prerequisite.** If a call needs a credential, show how to get the credential before showing the call. Nothing left as an exercise -- every reader who has to figure something out alone is paying a tax that could have been paid once, here. And teach each thing once: after a section has taught something, later sections assume it.

4. **Document the truth.** What the software actually does -- not what it should do, and not the polite version. Nothing is "required" unless the server enforces it. No opinions, no guesses about how people use things. The reader should never see a claim they could disprove by trying it. And when the truth turns out to be confusing, that's a bug: fix the software, then document the fix.

5. **Prefer by design, not by preaching.** When there's a preferred way to do something, the examples use it and it comes first in every list. That's the whole argument -- the doc never has to say "we recommend."

6. **Write from the reader's chair.** The important thing first in every section, a little detail after. Someone skimming should get the gist; someone reading closely should never have to read a sentence twice. Judge every sentence by what it costs the reader, not by what it cost to learn.

One more thing about those notes at the ends of entries. In our code, the comments at the head of a function accumulate into a little history of the work -- a blog, over time. The notes in these docs play the same role. When something worth remembering comes up about a call, it gets a dated line there, and the entry slowly tells its story.

***

*Written by Claude Code, from a working session with Dave Winer, 7/27/2026.*
