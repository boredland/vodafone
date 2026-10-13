import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { RESOLVE_GRACE_MS, recordCheck, type AddressRow, type FaultRow } from "../src/monitor";
import type { Fault } from "../src/vodafone";

const MIN = 60_000;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;
let address: AddressRow;

beforeAll(async () => {
	proxy = await getPlatformProxy<Env>({ persist: false });
	db = proxy.env.DB;
	const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
	for (const statement of schema.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
});

afterAll(() => proxy?.dispose());

beforeEach(async () => {
	await db.batch([db.prepare("DELETE FROM faults"), db.prepare("DELETE FROM addresses")]);
	await db
		.prepare(
			"INSERT INTO addresses (id, postal_code, city, street, house_number, created_at, last_viewed_at) VALUES ('1', '40549', 'Düsseldorf', 'Ferdinand-Braun-Platz', '1', 0, 0)",
		)
		.run();
	address = (await db.prepare("SELECT * FROM addresses").first<AddressRow>())!;
});

const cable: Fault = { faultId: "K1", category: "cable", serviceType: "incident", affectedServices: "Internet", description: "Kabel" };

const faults = async () => (await db.prepare("SELECT * FROM faults ORDER BY id").all<FaultRow>()).results;

describe("recordCheck", () => {
	it("opens a fault once and keeps it while it is reported", async () => {
		expect((await recordCheck(db, address, [cable], 0)).map((e) => e.type)).toEqual(["opened"]);
		expect(await recordCheck(db, address, [cable], 5 * MIN)).toEqual([]);
		const [row] = await faults();
		expect(row).toMatchObject({ first_seen: 0, last_seen: 5 * MIN, resolved_at: null });
		const updated = (await db.prepare("SELECT check_count FROM addresses").first<{ check_count: number }>())!;
		expect(updated.check_count).toBe(2);
	});

	it("resolves only after the grace period, at the time it first went missing", async () => {
		await recordCheck(db, address, [cable], 0);
		expect(await recordCheck(db, address, [], 5 * MIN)).toEqual([]);
		expect(await recordCheck(db, address, [], 5 * MIN + RESOLVE_GRACE_MS - 1)).toEqual([]);
		const events = await recordCheck(db, address, [], 5 * MIN + RESOLVE_GRACE_MS);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "resolved", fault: { faultId: "K1", firstSeen: 0, resolvedAt: 5 * MIN } });
		expect((await faults())[0].resolved_at).toBe(5 * MIN);
	});

	it("treats a brief disappearance as the same episode", async () => {
		await recordCheck(db, address, [cable], 0);
		await recordCheck(db, address, [], 5 * MIN);
		expect(await recordCheck(db, address, [cable], 10 * MIN)).toEqual([]);
		const rows = await faults();
		expect(rows).toHaveLength(1);
		expect(rows[0].missing_since).toBeNull();
	});

	it("opens a new episode when a resolved fault ID reappears", async () => {
		await recordCheck(db, address, [cable], 0);
		await recordCheck(db, address, [], MIN);
		await recordCheck(db, address, [], MIN + RESOLVE_GRACE_MS);
		const events = await recordCheck(db, address, [cable], 60 * MIN);
		expect(events.map((e) => e.type)).toEqual(["opened"]);
		expect((await faults()).map((f) => f.resolved_at)).toEqual([MIN, null]);
	});

	it("notifies only once when two checks race on the same transition", async () => {
		const [a, b] = await Promise.all([recordCheck(db, address, [cable], 0), recordCheck(db, address, [cable], 0)]);
		expect(a.length + b.length).toBe(1);
		await recordCheck(db, address, [], MIN);
		const [c, d] = await Promise.all([
			recordCheck(db, address, [], MIN + RESOLVE_GRACE_MS),
			recordCheck(db, address, [], MIN + RESOLVE_GRACE_MS),
		]);
		expect(c.length + d.length).toBe(1);
	});
});
