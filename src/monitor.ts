import { notify, type FaultEvent } from "./notify";
import { fetchFaults, type Fault } from "./vodafone";

/** Addresses viewed within this window keep being polled so their statistics stay complete. */
export const WATCH_MS = 30 * 24 * 60 * 60 * 1000;
/** A fault must stay absent this long before it counts as resolved; absorbs flapping upstream results. */
export const RESOLVE_GRACE_MS = 9 * 60 * 1000;
/** Results younger than this are served from D1 instead of querying Vodafone again. */
export const FRESH_MS = 2 * 60 * 1000;

const MAX_ADDRESSES_PER_RUN = 150;
const CONCURRENCY = 4;
const UNCONFIRMED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AddressRow {
	id: string;
	postal_code: string;
	city: string;
	district: string | null;
	street: string;
	house_number: string;
	created_at: number;
	last_viewed_at: number;
	last_checked_at: number | null;
	check_count: number;
	error_count: number;
	last_error: string | null;
}

export interface FaultRow {
	id: number;
	address_id: string;
	fault_id: string;
	category: string;
	service_type: string;
	affected_services: string | null;
	description: string | null;
	raw: string;
	first_seen: number;
	last_seen: number;
	missing_since: number | null;
	resolved_at: number | null;
}

/** Stores one observation of an address and returns the resulting fault transitions. */
export async function recordCheck(db: D1Database, address: AddressRow, faults: Fault[], now: number): Promise<FaultEvent[]> {
	const { results: active } = await db
		.prepare("SELECT * FROM faults WHERE address_id = ? AND resolved_at IS NULL")
		.bind(address.id)
		.all<FaultRow>();
	const activeById = new Map(active.map((f) => [f.fault_id, f]));
	const statements: D1PreparedStatement[] = [];
	// Statements whose `changes` decide whether an event fires; concurrent checks (cron vs. page view)
	// race on the same rows, and only the one that actually changed a row notifies.
	const pending: { index: number; event: FaultEvent }[] = [];

	for (const fault of faults) {
		const existing = activeById.get(fault.faultId);
		if (existing) {
			statements.push(
				db
					.prepare(
						"UPDATE faults SET last_seen = ?, missing_since = NULL, affected_services = ?, description = ?, raw = ? WHERE id = ?",
					)
					.bind(now, fault.affectedServices ?? null, fault.description ?? null, JSON.stringify(fault), existing.id),
			);
			continue;
		}
		pending.push({
			index: statements.length,
			event: {
				type: "opened",
				address,
				fault: {
					faultId: fault.faultId,
					category: fault.category,
					serviceType: fault.serviceType,
					affectedServices: fault.affectedServices ?? null,
					description: fault.description ?? null,
					firstSeen: now,
					resolvedAt: null,
				},
			},
		});
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO faults
					(address_id, fault_id, category, service_type, affected_services, description, raw, first_seen, last_seen)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					address.id,
					fault.faultId,
					fault.category,
					fault.serviceType,
					fault.affectedServices ?? null,
					fault.description ?? null,
					JSON.stringify(fault),
					now,
					now,
				),
		);
	}

	const seen = new Set(faults.map((f) => f.faultId));
	for (const row of active) {
		if (seen.has(row.fault_id)) continue;
		if (row.missing_since === null) {
			statements.push(db.prepare("UPDATE faults SET missing_since = ? WHERE id = ?").bind(now, row.id));
		} else if (now - row.missing_since >= RESOLVE_GRACE_MS) {
			pending.push({
				index: statements.length,
				event: {
					type: "resolved",
					address,
					fault: {
						faultId: row.fault_id,
						category: row.category,
						serviceType: row.service_type,
						affectedServices: row.affected_services,
						description: row.description,
						firstSeen: row.first_seen,
						resolvedAt: row.missing_since,
					},
				},
			});
			statements.push(
				db.prepare("UPDATE faults SET resolved_at = missing_since WHERE id = ? AND resolved_at IS NULL").bind(row.id),
			);
		}
	}

	statements.push(
		db
			.prepare("UPDATE addresses SET last_checked_at = ?, check_count = check_count + 1, last_error = NULL WHERE id = ?")
			.bind(now, address.id),
	);

	const results = await db.batch(statements);
	return pending.filter((p) => results[p.index].meta.changes > 0).map((p) => p.event);
}

export async function recordError(db: D1Database, addressId: string, err: unknown, now: number): Promise<void> {
	await db
		.prepare("UPDATE addresses SET last_checked_at = ?, error_count = error_count + 1, last_error = ? WHERE id = ?")
		.bind(now, String(err).slice(0, 500), addressId)
		.run();
}

/** Queries Vodafone for one address, records the result, and returns transitions to notify about. */
export async function checkAddress(
	env: Env,
	address: AddressRow,
	postalCache?: Map<string, Promise<{ faultInfos?: Fault[] }>>,
): Promise<FaultEvent[]> {
	const now = Date.now();
	let faults: Fault[];
	try {
		faults = await fetchFaults(env, address.postal_code, address.id, postalCache);
	} catch (err) {
		await recordError(env.DB, address.id, err, now);
		throw err;
	}
	return recordCheck(env.DB, address, faults, now);
}

export async function runMonitor(env: Env, now = Date.now()): Promise<void> {
	await env.DB.prepare("DELETE FROM subscriptions WHERE confirmed_at IS NULL AND created_at < ?")
		.bind(now - UNCONFIRMED_TTL_MS)
		.run();

	// Oldest first, so addresses beyond the per-run cap are picked up by the next run.
	const { results: addresses } = await env.DB.prepare(
		`SELECT a.* FROM addresses a
		WHERE a.last_viewed_at > ?1
			OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.address_id = a.id AND s.confirmed_at IS NOT NULL)
		ORDER BY a.last_checked_at IS NOT NULL, a.last_checked_at
		LIMIT ?2`,
	)
		.bind(now - WATCH_MS, MAX_ADDRESSES_PER_RUN)
		.all<AddressRow>();

	const postalCache = new Map<string, Promise<{ faultInfos?: Fault[] }>>();
	let next = 0;
	let failed = 0;
	const worker = async () => {
		while (next < addresses.length) {
			const address = addresses[next++];
			try {
				const events = await checkAddress(env, address, postalCache);
				if (events.length) await notify(env, events);
			} catch (err) {
				failed++;
				console.error(`check ${address.id} failed:`, err);
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	console.log(`monitor: checked ${addresses.length} addresses, ${failed} failed`);
}
