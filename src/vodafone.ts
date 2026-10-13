// Client for the API behind https://www.vodafone.de/stoerung/validate (the "net-assistant" SPA).

const BASE_URL = "https://eu3.api.vodafone.com/netassistant/v1";
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

async function post<T>(env: VodafoneEnv, path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE_URL}/${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-APIKEY": env.VODAFONE_API_KEY,
			"User-Agent": `vodafone-stoerungen (+${env.APP_URL})`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new UpstreamError(res.status, `${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	}
	return res.json<T>();
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
