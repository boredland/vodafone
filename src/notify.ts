import type { AddressRow } from "./monitor";
import { faultLabel } from "./vodafone";
import { sendPush, type VapidKeys } from "./webpush";

export interface FaultEvent {
	type: "opened" | "resolved";
	address: AddressRow;
	fault: {
		faultId: string;
		category: string;
		serviceType: string;
		affectedServices: string | null;
		description: string | null;
		firstSeen: number;
		resolvedAt: number | null;
	};
}

interface SubscriptionRow {
	id: number;
	address_id: string;
	kind: "push" | "email";
	target: string;
	p256dh: string | null;
	auth: string | null;
	token: string;
}

export function formatAddress(a: Pick<AddressRow, "street" | "house_number" | "postal_code" | "city">): string {
	return `${a.street} ${a.house_number}, ${a.postal_code} ${a.city}`;
}

const dateFormat = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes} Min.`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} Std. ${minutes % 60} Min.`;
	return `${Math.floor(hours / 24)} Tage ${hours % 24} Std.`;
}

function describe(event: FaultEvent): { title: string; body: string } {
	const { fault } = event;
	const label = faultLabel(fault);
	if (event.type === "opened") {
		return {
			title: `Neue ${label}`,
			body: [fault.description, fault.affectedServices && `Betroffen: ${fault.affectedServices}`].filter(Boolean).join("\n"),
		};
	}
	return {
		title: `${label} behoben`,
		body: `Bekannt seit ${dateFormat.format(fault.firstSeen)}, Dauer ca. ${formatDuration(fault.resolvedAt! - fault.firstSeen)}`,
	};
}

export function vapidKeys(env: Env): VapidKeys {
	return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.APP_URL };
}

export function addressUrl(env: Env, addressId: string): string {
	return `${env.APP_URL}/?address=${encodeURIComponent(addressId)}`;
}

export async function notify(env: Env, events: FaultEvent[]): Promise<void> {
	const address = events[0].address;
	const { results: subscriptions } = await env.DB.prepare(
		"SELECT * FROM subscriptions WHERE address_id = ? AND confirmed_at IS NOT NULL",
	)
		.bind(address.id)
		.all<SubscriptionRow>();
	await Promise.all(
		subscriptions.map(async (sub) => {
			try {
				if (sub.kind === "push") await pushEvents(env, sub, events);
				else await emailEvents(env, sub, events);
			} catch (err) {
				console.error(`notify ${sub.kind} subscription ${sub.id} failed:`, err);
			}
		}),
	);
}

async function pushEvents(env: Env, sub: SubscriptionRow, events: FaultEvent[]): Promise<void> {
	for (const event of events) {
		const { title, body } = describe(event);
		const result = await sendPush(
			{ endpoint: sub.target, p256dh: sub.p256dh!, auth: sub.auth! },
			{
				title,
				body: `${formatAddress(event.address)}\n${body}`,
				url: addressUrl(env, event.address.id),
				tag: `${event.address.id}:${event.fault.faultId}`,
			},
			vapidKeys(env),
		);
		if (result === "gone") {
			await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(sub.id).run();
			return;
		}
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function emailEvents(env: Env, sub: SubscriptionRow, events: FaultEvent[]): Promise<void> {
	const address = formatAddress(events[0].address);
	const items = events.map(describe);
	const link = addressUrl(env, events[0].address.id);
	const unsubscribe = `${env.APP_URL}/?unsubscribe=${sub.token}`;
	await sendEmail(env, {
		to: sub.target,
		subject: items.length === 1 ? `${items[0].title}: ${address}` : `${items.length} Änderungen: ${address}`,
		text: [
			`Vodafone-Störungsmeldungen für ${address}:`,
			...items.map((i) => `\n${i.title}\n${i.body}`),
			`\nDetails & Statistik: ${link}`,
			`Abmelden: ${unsubscribe}`,
		].join("\n"),
		html: `<p>Vodafone-Störungsmeldungen für <strong>${escapeHtml(address)}</strong>:</p>
${items.map((i) => `<h3>${escapeHtml(i.title)}</h3><p>${escapeHtml(i.body).replace(/\n/g, "<br>")}</p>`).join("\n")}
<p><a href="${link}">Details &amp; Statistik</a></p>
<p style="color:#666;font-size:12px"><a href="${unsubscribe}">Benachrichtigungen abbestellen</a></p>`,
		unsubscribeToken: sub.token,
	});
}

export async function sendConfirmationEmail(env: Env, to: string, address: AddressRow, token: string): Promise<void> {
	const confirm = `${env.APP_URL}/?confirm=${token}`;
	const label = formatAddress(address);
	await sendEmail(env, {
		to,
		subject: `Bitte bestätigen: Störungsmeldungen für ${label}`,
		text: `Du möchtest per E-Mail benachrichtigt werden, wenn Vodafone an ${label} eine Störung oder Wartung meldet.\n\nBestätigen: ${confirm}\n\nWenn Du das nicht warst, ignoriere diese E-Mail.`,
		html: `<p>Du möchtest per E-Mail benachrichtigt werden, wenn Vodafone an <strong>${escapeHtml(label)}</strong> eine Störung oder Wartung meldet.</p>
<p><a href="${confirm}">Anmeldung bestätigen</a></p>
<p style="color:#666;font-size:12px">Wenn Du das nicht warst, ignoriere diese E-Mail.</p>`,
	});
}

async function sendEmail(
	env: Env,
	mail: { to: string; subject: string; text: string; html: string; unsubscribeToken?: string },
): Promise<void> {
	const headers: Record<string, string> = { "Auto-Submitted": "auto-generated" };
	if (mail.unsubscribeToken) {
		headers["List-Unsubscribe"] = `<${env.APP_URL}/api/unsubscribe?token=${mail.unsubscribeToken}>`;
		headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
	}
	await env.EMAIL.send({
		to: mail.to,
		from: { email: env.EMAIL_FROM, name: "Vodafone Störungsmelder" },
		subject: mail.subject,
		text: mail.text,
		html: mail.html,
		headers,
	});
}
