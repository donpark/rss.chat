# rssNetwork

 A simple server that supports communities of users of rss.chat and compatible products. 

## Local development

From the repository root, start the client file server (it adds CORS headers and copies `config.local.json` to `config.json`):

```bash
python3 client/devserver.py
```

In a second terminal, install dependencies and start the RSS server:

```bash
cd server/code
npm install
npm install-scripts approve better-sqlite3  # npm 12 only; leaves a local package.json setting
npm rebuild better-sqlite3                  # npm 12 only, after approval
node rssnetwork.js
```

Open `http://localhost:1420/`. The local server creates `data/data.db` automatically. Create a local account without email using:

```text
http://localhost:1420/localnewuser?screenname=localdev&email=you@example.com
```

Keep `config.local.json`, `data/`, `stats.json`, and `prefs.json` local; they are not production configuration or source data.

