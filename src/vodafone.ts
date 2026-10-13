// Client for the API behind https://www.vodafone.de/stoerung/validate (the "net-assistant" SPA).

const HOST = "eu3.api.vodafone.com";
const BASE_PATH = "/netassistant/v1";
const TIMEOUT_MS = 15_000;

export interface Place {
	postCode: string;
	city: string;
}

export interface Address {
	addressId: string;
	postCode: string;
	city: string;
	district?: string;
	streetName: string;
	streetNr: string;
	streetNrExt?: string;
}

export interface Fault {
	faultId: string;
	category: string; // cable | dsl | mobilephone
	serviceType: string; // incident | maintenance | SI
	affectedServices?: string;
	description?: string;
	text?: string;
	infoText?: string;
	[key: string]: unknown;
}

export class UpstreamError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

type VodafoneEnv = Pick<Env, "VODAFONE_API_KEY" | "APP_URL">;

// Not fetch(): Workers add `CF-Visitor: {"scheme":"https"}` to every outbound fetch, and Vodafone's gateway rejects
// any request carrying that header with 400 invalid_request. A raw socket sends exactly the request written here.
async function post<T>(env: VodafoneEnv, path: string, body: unknown): Promise<T> {
	// Imported lazily so Node-based tests can load this module.
	const { connect } = await import("cloudflare:sockets");
	const encoder = new TextEncoder();
	const payload = encoder.encode(JSON.stringify(body));
	const head = [
		`POST ${BASE_PATH}/${path} HTTP/1.1`,
		`Host: ${HOST}`,
		"Content-Type: application/json",
		`Content-Length: ${payload.length}`,
		`X-APIKEY: ${env.VODAFONE_API_KEY}`,
		`User-Agent: vodafone-stoerungen (+${env.APP_URL})`,
		"Accept-Encoding: identity",
		"Connection: close",
		"",
		"",
	].join("\r\n");

	const socket = connect({ hostname: HOST, port: 443 }, { secureTransport: "on", allowHalfOpen: false });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const exchange = (async () => {
			const writer = socket.writable.getWriter();
			await writer.write(encoder.encode(head));
			await writer.write(payload);
			writer.releaseLock();
			return new Uint8Array(await new Response(socket.readable).arrayBuffer());
		})();
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${path}: timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
		});
		const res = parseHttpResponse(await Promise.race([exchange, timeout]));
		if (res.status < 200 || res.status >= 300) {
			throw new UpstreamError(res.status, `${path}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
		}
		return JSON.parse(res.body) as T;
	} finally {
		clearTimeout(timer);
		socket.close().catch(() => {});
	}
}

const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

function indexOfBytes(data: Uint8Array, needle: Uint8Array, from = 0): number {
	outer: for (let i = from; i <= data.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

function dechunk(data: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	let pos = 0;
	for (;;) {
		const eol = indexOfBytes(data, CRLF, pos);
		if (eol < 0) throw new Error("truncated chunked body");
		const size = parseInt(new TextDecoder().decode(data.subarray(pos, eol)), 16);
		if (Number.isNaN(size) || eol + 2 + size > data.length) throw new Error("malformed chunked body");
		if (size === 0) break;
		parts.push(data.subarray(eol + 2, eol + 2 + size));
		pos = eol + 2 + size + 2;
	}
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** Parses a complete HTTP/1.1 response as read from a `Connection: close` socket. */
export function parseHttpResponse(raw: Uint8Array): { status: number; body: string } {
	const end = indexOfBytes(raw, HEADER_END);
	if (end < 0) throw new Error("truncated HTTP response");
	const [statusLine, ...lines] = new TextDecoder().decode(raw.subarray(0, end)).split("\r\n");
	const status = Number(statusLine.split(" ")[1]);
	if (!Number.isInteger(status)) throw new Error(`malformed status line: ${statusLine}`);
	const headers = new Map(
		lines.map((l) => {
			const i = l.indexOf(":");
			return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as const;
		}),
	);
	let body = raw.subarray(end + HEADER_END.length);
	if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) body = dechunk(body);
	else if (headers.has("content-length")) body = body.subarray(0, Number(headers.get("content-length")));
	return { status, body: new TextDecoder().decode(body) };
}

// The suggest endpoint answers 400 for inputs it considers too short or malformed; that is "no suggestions".
async function suggest<T>(env: VodafoneEnv, body: Record<string, string>): Promise<T[]> {
	try {
		return (await post<{ data?: T[] }>(env, "suggest", body)).data ?? [];
	} catch (err) {
		if (err instanceof UpstreamError && err.status === 400) return [];
		throw err;
	}
}

export function suggestPlaces(env: VodafoneEnv, query: string): Promise<Place[]> {
	return suggest(env, { searchKey: "postCodeOrCity", postCodeOrCity: query });
}

export async function suggestStreets(env: VodafoneEnv, place: Place, query: string): Promise<string[]> {
	const streets = await suggest<{ streetName: string }>(env, {
		searchKey: "streetName",
		postCode: place.postCode,
		city: place.city.toLowerCase(),
		streetName: query.toLowerCase(),
	});
	return streets.map((s) => s.streetName);
}

export async function suggestAddresses(env: VodafoneEnv, place: Place, street: string, number: string): Promise<Address[]> {
	const addresses = await suggest<Address>(env, {
		searchKey: "streetNr",
		postCode: place.postCode,
		city: place.city.toLowerCase(),
		streetName: street.toLowerCase(),
		streetNr: number.toLowerCase(),
	});
	// Unknown house numbers are echoed back with addressId "0".
	return addresses.filter((a) => a.addressId && a.addressId !== "0");
}

// Mirrors the SPA's filterMobileOutages: mobile incidents are only shown for site-level fault IDs.
const SHOWN_MOBILE_INCIDENT = /^._NEV\d{8}A$/;

export function isRelevant(fault: Fault): boolean {
	return !(fault.serviceType === "incident" && fault.category === "mobilephone") || SHOWN_MOBILE_INCIDENT.test(fault.faultId);
}

type FaultResponse = { faultInfos?: Fault[] };

/**
 * Like the SPA, queries by postal code (DSL/mobile) and by address ID (cable) and merges both.
 * `postalCache` deduplicates postal code lookups across addresses within one monitor run.
 */
export async function fetchFaults(
	env: VodafoneEnv,
	postCode: string,
	addressId: string,
	postalCache?: Map<string, Promise<FaultResponse>>,
): Promise<Fault[]> {
	let byPostal = postalCache?.get(postCode);
	if (!byPostal) {
		byPostal = post<FaultResponse>(env, "faultinfo", { postalCode: postCode });
		postalCache?.set(postCode, byPostal);
	}
	const responses = await Promise.all([byPostal, post<FaultResponse>(env, "faultinfo", { addressId })]);
	const faults = new Map<string, Fault>();
	for (const fault of responses.flatMap((r) => r.faultInfos ?? [])) {
		if (fault.faultId && isRelevant(fault)) faults.set(fault.faultId, fault);
	}
	return [...faults.values()];
}

export function faultLabel(fault: { category: string; serviceType: string }): string {
	const category = { cable: "Kabel", dsl: "DSL", mobilephone: "Mobilfunk" }[fault.category] ?? fault.category;
	return `${category}-${fault.serviceType === "maintenance" ? "Wartung" : "Störung"}`;
}
