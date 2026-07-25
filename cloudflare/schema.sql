-- schema.sql — D1 table definitions for rss.chat
-- Run via: npx wrangler d1 execute rsschat-db --file schema.sql

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
    r2Key text not null,
    size integer,
    whenCreated text default current_timestamp
);

create table if not exists auth_tokens (
    token text primary key,
    email text not null,
    screenname text,
    operation text not null,
    urlredirect text not null,
    whenCreated text default current_timestamp
);
create index if not exists auth_tokens_when on auth_tokens (whenCreated);

create table if not exists blocked_emails (
    email text primary key collate nocase,
    whenCreated text default current_timestamp
);

create table if not exists whitelist_emails (
    email text primary key collate nocase,
    whenCreated text default current_timestamp
);

-- Triggers (identical to original rssnetwork.js initNewDatabase)
create trigger if not exists usersWhenUpdated after update on users
begin
    update users set whenUpdated = datetime('now') where screenname = new.screenname;
end;

create trigger if not exists itemsWhenUpdated after update on items
begin
    update items set whenUpdated = datetime('now') where id = new.id;
end;
