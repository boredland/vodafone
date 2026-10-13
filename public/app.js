const $ = (id) => document.getElementById(id);

const LABELS = {
	cable: "Kabel",
	dsl: "DSL",
	mobilephone: "Mobilfunk",
};
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" });
const percent = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 2 });

let place = null; // { postCode, city }
let currentAddress = null;

function faultLabel(f) {
	return `${LABELS[f.category] ?? f.category}-${f.serviceType === "maintenance" ? "Wartung" : "Störung"}`;
}

function duration(ms) {
	if (ms == null) return "–";
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} Min.`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} Std. ${minutes % 60} Min.`;
	return `${Math.floor(hours / 24)} T. ${hours % 24} Std.`;
}

function el(tag, attrs = {}, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	node.append(...children.filter((c) => c != null));
	return node;
}

function flash(message) {
	$("flash").textContent = message;
	$("flash").hidden = !message;
}

async function api(path, options = {}) {
	const res = await fetch(`/api${path}`, {
		...options,
		headers: options.body ? { "Content-Type": "application/json" } : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

function debounce(fn, ms = 250) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

// --- Address search -------------------------------------------------------

let places = [];
let streets = [];

function fillDatalist(list, values) {
	list.replaceChildren(...values.map((v) => el("option", { value: v })));
}

const placeLabel = (p) => `${p.postCode} ${p.city}`;

$("place").addEventListener(
	"input",
	debounce(async (e) => {
		const value = e.target.value.trim();
		place = places.find((p) => placeLabel(p) === value) ?? null;
		$("street").disabled = !place;
		$("number").disabled = true;
		$("address-choices").hidden = true;
		if (place) {
			$("street").focus();
			return;
		}
		// The suggest API wants either a postal code or a city prefix, not both.
		const query = /^\d/.test(value) ? value.split(/\s/)[0] : value;
		places = query.length >= 2 ? await api(`/suggest/places?q=${encodeURIComponent(query)}`).catch(() => []) : [];
		fillDatalist($("place-list"), places.map(placeLabel));
		if (places.length === 1 && /^\d{5}$/.test(query)) {
			e.target.value = placeLabel(places[0]);
			e.target.dispatchEvent(new Event("input"));
		}
	}),
);

$("street").addEventListener(
	"input",
	debounce(async (e) => {
		const value = e.target.value.trim();
		const exact = streets.includes(value);
		$("number").disabled = !exact;
		$("address-choices").hidden = true;
		if (exact) {
			$("number").focus();
			return;
		}
		const params = new URLSearchParams({ postCode: place.postCode, city: place.city, q: value });
		streets = value.length >= 2 ? await api(`/suggest/streets?${params}`).catch(() => []) : [];
		fillDatalist($("street-list"), streets);
	}),
);

$("number").addEventListener(
	"input",
	debounce(async (e) => {
		const number = e.target.value.trim();
		const box = $("address-choices");
		if (!number) {
			box.hidden = true;
			return;
		}
		const params = new URLSearchParams({ postCode: place.postCode, city: place.city, street: $("street").value.trim(), number });
		const addresses = await api(`/suggest/addresses?${params}`).catch(() => []);
		// The API also returns numbers that merely start with the input; prefer exact matches.
		const exact = addresses.filter((a) => a.streetNr.toLowerCase() === number.toLowerCase());
		const shown = (exact.length ? exact : addresses).slice(0, 30);
		box.replaceChildren(
			...(shown.length
				? shown.map((a) =>
						el("button", { type: "button", onclick: () => selectAddress(a) }, `${a.streetName} ${a.streetNr}${a.streetNrExt ?? ""}`),
					)
				: [el("span", { class: "muted" }, "Keine passende Adresse gefunden.")]),
		);
		box.hidden = false;
	}, 350),
);

$("address-form").addEventListener("submit", (e) => e.preventDefault());

async function selectAddress(address) {
	try {
		const { id } = await api("/addresses", { method: "POST", body: JSON.stringify(address) });
		localStorage.setItem("lastAddress", id);
		history.pushState(null, "", `/?address=${encodeURIComponent(id)}`);
		await showAddress(id);
	} catch (err) {
		flash(err.message);
	}
}

$("change-address").addEventListener("click", () => {
	history.pushState(null, "", "/");
	showSearch();
});

window.addEventListener("popstate", route);

function showSearch() {
	currentAddress = null;
	$("result").hidden = true;
	$("search").hidden = false;
	$("place").focus();
}

// --- Status ---------------------------------------------------------------

async function showAddress(id) {
	$("search").hidden = true;
	$("result").hidden = false;
	$("status").replaceChildren(el("p", { class: "muted" }, "Prüfe bei Vodafone …"));
	$("status-meta").textContent = "";
	let data;
	try {
		data = await api(`/addresses/${encodeURIComponent(id)}`);
	} catch (err) {
		flash(err.message);
		showSearch();
		return;
	}
	currentAddress = data.address;
	const a = data.address;
	$("address-label").textContent = `${a.street} ${a.houseNumber}, ${a.postalCode} ${a.city}`;
	document.title = `${a.street} ${a.houseNumber} – Vodafone Störungsmelder`;
	$("status-meta").textContent =
		(data.checkedAt ? `Stand: ${dateTime.format(data.checkedAt)}` : "Noch nicht geprüft") +
		(data.checkError ? ` – ${data.checkError}` : "");
	$("status").replaceChildren(
		...(data.faults.length
			? data.faults.map((f) =>
					el(
						"div",
						{ class: `fault ${f.serviceType === "maintenance" ? "maintenance" : ""}` },
						el("h3", {}, faultLabel(f)),
						el("p", {}, f.description ?? ""),
						f.text ? el("p", {}, f.text) : null,
						el(
							"p",
							{ class: "muted small" },
							`Betroffen: ${f.affectedServices ?? "–"} · bekannt seit ${dateTime.format(f.firstSeen)} · ID ${f.faultId}`,
						),
					),
				)
			: [el("p", { class: "status-ok" }, "Keine bekannte Störung oder Wartung an dieser Adresse.")]),
	);
	await Promise.all([loadStats(id), refreshPushState()]);
	$("email-state").textContent = "";
}

// --- Statistics -----------------------------------------------------------

async function loadStats(id) {
	const { stats, history, historyTotal } = await api(`/addresses/${encodeURIComponent(id)}/stats`);
	$("stats-meta").textContent = `Beobachtet seit ${dateTime.format(stats.monitoredSince)} · ${stats.checks} Prüfungen${
		stats.errors ? `, ${stats.errors} fehlgeschlagen` : ""
	}`;

	$("stats-windows").replaceChildren(
		...stats.windows
			.filter((w, i) => i === 0 || stats.windows[i - 1].observedMs < w.observedMs)
			.map((w) =>
				el(
					"div",
					{ class: "window" },
					el("div", { class: "muted small" }, `Letzte ${w.days} Tage`),
					el("div", { class: "big" }, w.availability == null ? "–" : percent.format(w.availability)),
					el("div", { class: "muted small" }, "ohne Störung"),
					el(
						"dl",
						{},
						el("dt", {}, "Störungen"),
						el("dd", {}, String(w.incidents)),
						el("dt", {}, "Störungsdauer"),
						el("dd", {}, duration(w.incidentMs)),
						el("dt", {}, "Ø bis behoben"),
						el("dd", {}, duration(w.mttrMs)),
						el("dt", {}, "Längste"),
						el("dd", {}, duration(w.longestMs)),
						el("dt", {}, "Wartungen"),
						el("dd", {}, `${w.maintenances} (${duration(w.maintenanceMs)})`),
					),
				),
			),
	);

	const maxDay = Math.max(60, ...stats.daily.map((d) => d.incidentMinutes + d.maintenanceMinutes));
	// Days before monitoring started stay blank instead of looking like days without outages.
	const unobserved = Array.from({ length: 90 - stats.daily.length }, () => el("div", { class: "day", title: "nicht beobachtet" }));
	$("stats-daily").replaceChildren(
		...unobserved,
		...stats.daily.map((d) => {
			const day = el("div", {
				class: "day observed",
				title: `${d.date}: ${d.incidentMinutes} Min. Störung, ${d.maintenanceMinutes} Min. Wartung`,
			});
			for (const [cls, minutes] of [
				["incident", d.incidentMinutes],
				["maintenance", d.maintenanceMinutes],
			]) {
				if (minutes > 0) day.append(el("div", { class: cls, style: `height:${(minutes / maxDay) * 100}%` }));
			}
			return day;
		}),
	);

	renderBars($("stats-hour"), stats.byHour, (i) => `${i}`, (i) => `${i}–${i + 1} Uhr`);
	renderBars($("stats-weekday"), stats.byWeekday, (i) => WEEKDAYS[i], (i) => WEEKDAYS[i]);

	$("stats-category").replaceChildren(
		el("tr", {}, el("th", {}, "Art"), el("th", {}, "Anzahl"), el("th", {}, "Gesamtdauer")),
		...(stats.byCategory.length
			? stats.byCategory.map((c) =>
					el("tr", {}, el("td", {}, faultLabel(c)), el("td", {}, String(c.count)), el("td", {}, duration(c.totalMs))),
				)
			: [el("tr", {}, el("td", { colspan: "3", class: "muted" }, "Bisher nichts beobachtet."))]),
	);

	$("history").replaceChildren(
		el("tr", {}, el("th", {}, "Art"), el("th", {}, "Beginn"), el("th", {}, "Ende"), el("th", {}, "Dauer"), el("th", {}, "Betroffen")),
		...history.map((f) =>
			el(
				"tr",
				{ title: f.description ?? "" },
				el("td", {}, faultLabel(f)),
				el("td", {}, dateTime.format(f.firstSeen)),
				el("td", {}, f.resolvedAt ? dateTime.format(f.resolvedAt) : "aktiv"),
				el("td", {}, duration((f.resolvedAt ?? Date.now()) - f.firstSeen)),
				el("td", {}, f.affectedServices ?? "–"),
			),
		),
		...(historyTotal > history.length
			? [el("tr", {}, el("td", { colspan: "5", class: "muted" }, `… und ${historyTotal - history.length} ältere`))]
			: []),
	);
}

function renderBars(container, values, label, title) {
	const max = Math.max(1, ...values);
	container.replaceChildren(
		...values.map((v, i) => el("div", { style: `height:${(v / max) * 100}%`, title: `${title(i)}: ${v}` })),
	);
	const labels = el("div", { class: "bar-labels" }, ...values.map((_, i) => el("span", {}, values.length > 12 && i % 3 ? "" : label(i))));
	container.nextElementSibling?.classList.contains("bar-labels") ? container.nextElementSibling.replaceWith(labels) : container.after(labels);
}

// --- Push -----------------------------------------------------------------

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const pushTokens = () => JSON.parse(localStorage.getItem("pushTokens") ?? "{}");
const savePushTokens = (tokens) => localStorage.setItem("pushTokens", JSON.stringify(tokens));

function urlBase64ToUint8Array(base64) {
	const raw = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function refreshPushState() {
	const button = $("push-toggle");
	if (!pushSupported) {
		button.disabled = true;
		$("push-state").textContent = "Dieser Browser unterstützt keine Push-Benachrichtigungen. Auf iOS: Seite zum Home-Bildschirm hinzufügen.";
		return;
	}
	const subscribed = Boolean(pushTokens()[currentAddress.id]);
	button.textContent = subscribed ? "Push deaktivieren" : "Push aktivieren";
	button.className = subscribed ? "secondary" : "";
	button.disabled = false;
	$("push-state").textContent =
		Notification.permission === "denied"
			? "Benachrichtigungen sind für diese Seite blockiert."
			: subscribed
				? "Aktiv in diesem Browser."
				: "";
}

$("push-toggle").addEventListener("click", async () => {
	const button = $("push-toggle");
	button.disabled = true;
	const tokens = pushTokens();
	try {
		if (tokens[currentAddress.id]) {
			await api("/unsubscribe", { method: "POST", body: JSON.stringify({ token: tokens[currentAddress.id] }) });
			delete tokens[currentAddress.id];
		} else {
			if ((await Notification.requestPermission()) !== "granted") throw new Error("Benachrichtigungen wurden nicht erlaubt.");
			const registration = await navigator.serviceWorker.register("/sw.js");
			await navigator.serviceWorker.ready;
			const { key } = await api("/vapid-public-key");
			const subscription =
				(await registration.pushManager.getSubscription()) ??
				(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
			const { token } = await api(`/addresses/${encodeURIComponent(currentAddress.id)}/subscriptions`, {
				method: "POST",
				body: JSON.stringify({ kind: "push", subscription: subscription.toJSON() }),
			});
			tokens[currentAddress.id] = token;
		}
		savePushTokens(tokens);
	} catch (err) {
		$("push-state").textContent = err.message;
		button.disabled = false;
		return;
	}
	await refreshPushState();
});

// --- Email ----------------------------------------------------------------

$("email-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const button = e.target.querySelector("button");
	button.disabled = true;
	try {
		await api(`/addresses/${encodeURIComponent(currentAddress.id)}/subscriptions`, {
			method: "POST",
			body: JSON.stringify({ kind: "email", email: $("email").value }),
		});
		$("email-state").textContent = "Fast geschafft: Bitte bestätige den Link in der E-Mail, die wir Dir geschickt haben.";
		$("email").value = "";
	} catch (err) {
		$("email-state").textContent = err.message;
	} finally {
		button.disabled = false;
	}
});

// --- Routing --------------------------------------------------------------

async function route() {
	flash("");
	const params = new URLSearchParams(location.search);
	try {
		if (params.has("confirm")) {
			const { addressId } = await api("/confirm", { method: "POST", body: JSON.stringify({ token: params.get("confirm") }) });
			history.replaceState(null, "", `/?address=${encodeURIComponent(addressId)}`);
			flash("E-Mail-Benachrichtigungen sind aktiv.");
			return showAddress(addressId);
		}
		if (params.has("unsubscribe")) {
			const { addressId } = await api("/unsubscribe", { method: "POST", body: JSON.stringify({ token: params.get("unsubscribe") }) });
			history.replaceState(null, "", addressId ? `/?address=${encodeURIComponent(addressId)}` : "/");
			flash(addressId ? "Du erhältst keine Benachrichtigungen mehr für diese Adresse." : "Dieses Abo existiert nicht mehr.");
			return addressId ? showAddress(addressId) : showSearch();
		}
	} catch (err) {
		flash(err.message);
	}
	const id = params.get("address") ?? localStorage.getItem("lastAddress");
	return id ? showAddress(id) : showSearch();
}

route();
