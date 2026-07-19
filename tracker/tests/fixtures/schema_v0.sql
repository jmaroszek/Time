CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    process TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    domain TEXT,
    is_afk INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX idx_sessions_start ON sessions(start_ts);
CREATE INDEX idx_sessions_proc ON sessions(process);

CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    is_productive INTEGER NOT NULL DEFAULT 0,
    is_neutral INTEGER NOT NULL DEFAULT 0,
    is_ignored INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER
);

CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),
    pattern TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

INSERT INTO categories
    (id,name,color,is_productive,is_neutral,is_ignored,sort_order)
VALUES
    (1,'Dev','#3f9bf0',1,0,0,1),
    (2,'Browsing','#e0a53a',1,0,0,2);

INSERT INTO rules (id,match_type,pattern,category_id,priority)
VALUES
    (10,'process','googledrivefs.exe',1,3),
    (11,'process','googledrivefs.exe',2,3),
    (12,'process','code.exe',1,3),
    (13,'process','chrome.exe',2,3);

INSERT INTO sessions
    (id,start_ts,end_ts,process,title,domain,is_afk,source)
VALUES
    (20,100,140,'code.exe','valid',NULL,0,'live'),
    (21,200,200,'code.exe','zero',NULL,0,'live'),
    (22,300,250,'code.exe','negative',NULL,0,'live');

INSERT INTO settings (key,value)
VALUES
    ('rule_priority_scheme','low-wins-v1'),
    ('weekly_goal_hours','35');
