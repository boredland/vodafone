import { Hono, type Context } from "hono";
import { FRESH_MS, checkAddress, runMonitor, type AddressRow, type FaultRow } from "./monitor";
import { notify, sendConfirmationEmail } from "./notify";
import { computeStats } from "./stats";
import { UpstreamError, suggestAddresses, suggestPlaces, suggestStreets, type Address } from "./vodafone";
import { b64urlEncode, isAllowedEndpoint, isValidSubscription } from "./webpush";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HISTORY_LIMIT = 100;

function clientIp(c: Context): string {
	return c.req.header("cf-connecting-ip") ?? "local";
}

async function limited(limiter: RateLimit, key: string): Promise<boolean> {
	return !(await limiter.limit({ key })).success;
}

function newToken(): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

app.onError((err, c) => {
	if (err instanceof UpstreamError || err.name === "TimeoutError") {
		console.warn("upstream:", err.message);
		return c.json({ error: "Die Vodafone-Schnittstelle ist gerade nicht erreichbar." }, 502);
	}
	console.error(err);
	return c.json({ error: "Interner Fehler" }, 500);
});

app.use("/suggest/*", async (c, next) => {
	if (await limited(c.env.LOOKUP_LIMITER, clientIp(c))) return c.json({ error: "Zu viele Anfragen" }, 429);
	await next();
});

app.get("/suggest/places", async (c) => {
	const q = c.req.query("q")?.trim() ?? "";
	if (q.length < 2) return c.json([]);
	return c.json(await suggestPlaces(c.env, q));
});

app.get("/suggest/streets", async (c) => {
	const { postCode, city, q } = c.req.query();
	if (!postCode || !city || !q || q.trim().length < 2) return c.json([]);
	return c.json(await suggestStreets(c.env, { postCode, city }, q.trim()));
});

app.get("/suggest/addresses", async (c) => {
	const { postCode, city, street, number } = c.req.query();
	if (!postCode || !city || !street || !number?.trim()) return c.json([]);
	return c.json(await suggestAddresses(c.env, { postCode, city }, street, number.trim()));
});

/** Registers an address picked from suggestions. The addressId is verified against Vodafone before storing. */
app.post("/addresses", async (c) => {
	if (await limited(c.env.LOOKUP_LIMITER, clientIp(c))) return c.json({ error: "Zu viele Anfragen" }, 429);
	const body = await c.req.json<Partial<Address>>().catch(() => ({}) as Partial<Address>);
	const { addressId, postCode, city, streetName, streetNr } = body;
	if (!addressId || !postCode || !city || !streetName || !streetNr) return c.json({ error: "Adresse unvollständig" }, 400);

	const existing = await c.env.DB.prepare("SELECT id FROM addresses WHERE id = ?").bind(addressId).first();
	if (!existing) {
		const match = (await suggestAddresses(c.env, { postCode, city }, streetName, streetNr)).find((a) => a.addressId === addressId);
		if (!match) return c.json({ error: "Adresse nicht gefunden" }, 404);
		const now = Date.now();
		await c.env.DB.prepare(
			`INSERT OR IGNORE INTO addresses (id, postal_code, city, district, street, house_number, created_at, last_viewed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				match.addressId,
				match.postCode,
				match.city,
				match.district ?? null,
				match.streetName,
				`${match.streetNr}${match.streetNrExt ?? ""}`,
				now,
				now,
			)
			.run();
	}
	return c.json({ id: addressId });
});

/** Current status. Checks Vodafone unless the stored result is fresh. */
app.get("/addresses/:id", async (c) => {
	const id = c.req.param("id");
	let address = await c.env.DB.prepare("SELECT * FROM addresses WHERE id = ?").bind(id).first<AddressRow>();
	if (!address) return c.json({ error: "Unbekannte Adresse" }, 404);

	const now = Date.now();
	await c.env.DB.prepare("UPDATE addresses SET last_viewed_at = ? WHERE id = ?").bind(now, id).run();
	let checkError: string | null = null;
	if (!address.last_checked_at || now - address.last_checked_at > FRESH_MS) {
		if (await limited(c.env.LOOKUP_LIMITER, clientIp(c))) {
			checkError = "Zu viele Anfragen; zeige gespeicherten Stand.";
		} else {
			try {
				const events = await checkAddress(c.env, address);
				if (events.length) c.executionCtx.waitUntil(notify(c.env, events));
			} catch (err) {
				console.warn(`live check ${id} failed:`, err);
				checkError = "Die Vodafone-Schnittstelle ist gerade nicht erreichbar; zeige gespeicherten Stand.";
			}
			address = (await c.env.DB.prepare("SELECT * FROM addresses WHERE id = ?").bind(id).first<AddressRow>())!;
		}
	}

	const { results: active } = await c.env.DB.prepare(
		"SELECT * FROM faults WHERE address_id = ? AND resolved_at IS NULL ORDER BY first_seen DESC",
	)
		.bind(id)
		.all<FaultRow>();
	return c.json({
		address: publicAddress(address),
		checkedAt: address.last_checked_at,
		checkError,
		faults: active.map(publicFault),
	});
});

app.get("/addresses/:id/stats", async (c) => {
	const id = c.req.param("id");
	const address = await c.env.DB.prepare("SELECT * FROM addresses WHERE id = ?").bind(id).first<AddressRow>();
	if (!address) return c.json({ error: "Unbekannte Adresse" }, 404);
	const { results: faults } = await c.env.DB.prepare("SELECT * FROM faults WHERE address_id = ? ORDER BY first_seen DESC")
		.bind(id)
		.all<FaultRow>();
	return c.json({
		stats: computeStats(faults, address, Date.now()),
		history: faults.slice(0, HISTORY_LIMIT).map(publicFault),
		historyTotal: faults.length,
	});
});

function publicAddress(a: AddressRow) {
	return {
		id: a.id,
		postalCode: a.postal_code,
		city: a.city,
		district: a.district,
		street: a.street,
		houseNumber: a.house_number,
		monitoredSince: a.created_at,
	};
}

function publicFault(f: FaultRow) {
	const raw = JSON.parse(f.raw) as Record<string, unknown>;
	return {
		faultId: f.fault_id,
		category: f.category,
		serviceType: f.service_type,
		affectedServices: f.affected_services,
		description: f.description,
		text: typeof raw.text === "string" ? raw.text : null,
		firstSeen: f.first_seen,
		lastSeen: f.last_seen,
		resolvedAt: f.resolved_at,
	};
}

app.get("/vapid-public-key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY }));

app.post("/addresses/:id/subscriptions", async (c) => {
	const id = c.req.param("id");
	if (await limited(c.env.SUBSCRIBE_LIMITER, clientIp(c))) return c.json({ error: "Zu viele Anfragen" }, 429);
	const address = await c.env.DB.prepare("SELECT * FROM addresses WHERE id = ?").bind(id).first<AddressRow>();
	if (!address) return c.json({ error: "Unbekannte Adresse" }, 404);

	type Body =
		| { kind: "push"; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
		| { kind: "email"; email: string };
	const body = await c.req.json<Body>().catch(() => null);
	const now = Date.now();

	if (body?.kind === "push") {
		const endpoint = body.subscription?.endpoint;
		const p256dh = body.subscription?.keys?.p256dh;
		const auth = body.subscription?.keys?.auth;
		if (!endpoint || !p256dh || !auth || !isAllowedEndpoint(endpoint) || !isValidSubscription({ endpoint, p256dh, auth })) {
			return c.json({ error: "Ungültiges Push-Abonnement" }, 400);
		}
		// Push subscriptions are possessed only by the browser that created them, so they need no confirmation.
		const token = newToken();
		const row = await c.env.DB.prepare(
			`INSERT INTO subscriptions (address_id, kind, target, p256dh, auth, token, confirmed_at, created_at)
			VALUES (?, 'push', ?, ?, ?, ?, ?, ?)
			ON CONFLICT (address_id, kind, target) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
			RETURNING token`,
		)
			.bind(id, endpoint, p256dh, auth, token, now, now)
			.first<{ token: string }>();
		return c.json({ status: "subscribed", token: row!.token });
	}

	if (body?.kind === "email") {
		const email = body.email?.trim().toLowerCase();
		if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return c.json({ error: "Ungültige E-Mail-Adresse" }, 400);
		if (await limited(c.env.SUBSCRIBE_LIMITER, `email:${email}`)) return c.json({ error: "Zu viele Anfragen" }, 429);
		const existing = await c.env.DB.prepare(
			"SELECT token, confirmed_at FROM subscriptions WHERE address_id = ? AND kind = 'email' AND target = ?",
		)
			.bind(id, email)
			.first<{ token: string; confirmed_at: number | null }>();
		// Same response whether or not the address is already subscribed, so the endpoint doesn't reveal subscribers.
		if (existing?.confirmed_at) return c.json({ status: "pending" });
		const token = existing?.token ?? newToken();
		if (!existing) {
			await c.env.DB.prepare(
				"INSERT INTO subscriptions (address_id, kind, target, token, created_at) VALUES (?, 'email', ?, ?, ?)",
			)
				.bind(id, email, token, now)
				.run();
		}
		await sendConfirmationEmail(c.env, email, address, token);
		return c.json({ status: "pending" });
	}

	return c.json({ error: "Unbekannte Abo-Art" }, 400);
});

app.post("/confirm", async (c) => {
	const { token } = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
	if (!token) return c.json({ error: "Token fehlt" }, 400);
	const row = await c.env.DB.prepare(
		"UPDATE subscriptions SET confirmed_at = coalesce(confirmed_at, ?) WHERE token = ? RETURNING address_id",
	)
		.bind(Date.now(), token)
		.first<{ address_id: string }>();
	if (!row) return c.json({ error: "Link ungültig oder abgelaufen" }, 404);
	return c.json({ addressId: row.address_id });
});

/** Called by the page (JSON body) and by mail clients for RFC 8058 one-click unsubscribe (token in query). */
app.post("/unsubscribe", async (c) => {
	const body = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
	const token = c.req.query("token") ?? body.token;
	if (!token) return c.json({ error: "Token fehlt" }, 400);
	const row = await c.env.DB.prepare("DELETE FROM subscriptions WHERE token = ? RETURNING address_id")
		.bind(token)
		.first<{ address_id: string }>();
	return c.json({ addressId: row?.address_id ?? null });
});

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(runMonitor(env));
	},
} satisfies ExportedHandler<Env>;
