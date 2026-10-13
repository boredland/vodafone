-- All timestamps are Unix epoch milliseconds.

CREATE TABLE addresses (
	id TEXT PRIMARY KEY, -- Vodafone addressId
	postal_code TEXT NOT NULL,
	city TEXT NOT NULL,
	district TEXT,
	street TEXT NOT NULL,
	house_number TEXT NOT NULL, -- including extension, e.g. "12a"
	created_at INTEGER NOT NULL,
	last_viewed_at INTEGER NOT NULL,
	last_checked_at INTEGER,
	check_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT
);

-- One row per outage episode. A Vodafone faultId that disappears and later reappears opens a new episode.
CREATE TABLE faults (
	id INTEGER PRIMARY KEY,
	address_id TEXT NOT NULL REFERENCES addresses (id) ON DELETE CASCADE,
	fault_id TEXT NOT NULL,
	category TEXT NOT NULL, -- cable | dsl | mobilephone
	service_type TEXT NOT NULL, -- incident | maintenance | SI
	affected_services TEXT,
	description TEXT,
	raw TEXT NOT NULL, -- latest upstream faultInfo object as JSON
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	missing_since INTEGER, -- absent in the latest check but not yet considered resolved
	resolved_at INTEGER
);

CREATE UNIQUE INDEX faults_active ON faults (address_id, fault_id) WHERE resolved_at IS NULL;
CREATE INDEX faults_address ON faults (address_id, first_seen);

CREATE TABLE subscriptions (
	id INTEGER PRIMARY KEY,
	address_id TEXT NOT NULL REFERENCES addresses (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('push', 'email')),
	target TEXT NOT NULL, -- push endpoint or email address
	p256dh TEXT,
	auth TEXT,
	token TEXT NOT NULL UNIQUE, -- confirm/unsubscribe capability
	confirmed_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX subscriptions_target ON subscriptions (address_id, kind, target);
CREATE INDEX subscriptions_confirmed ON subscriptions (address_id) WHERE confirmed_at IS NOT NULL;
