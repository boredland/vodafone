import { describe, expect, it } from "vitest";
import { parseHttpResponse } from "../src/vodafone";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("parseHttpResponse", () => {
	it("cuts the body at Content-Length, counted in bytes", () => {
		const body = '{"city":"Düsseldorf"}';
		const raw = bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${bytes(body).length}\r\n\r\n${body}trailing garbage`);
		expect(parseHttpResponse(raw)).toEqual({ status: 200, body });
	});

	it("reassembles a chunked body, including multi-byte characters split across chunks", () => {
		const [a, b] = [bytes('{"city":"D'), bytes('üsseldorf"}')];
		const raw = new Uint8Array([
			...bytes(`HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n${a.length.toString(16)}\r\n`),
			...a,
			...bytes(`\r\n${b.length.toString(16)}\r\n`),
			...b,
			...bytes("\r\n0\r\n\r\n"),
		]);
		expect(parseHttpResponse(raw)).toEqual({ status: 400, body: '{"city":"Düsseldorf"}' });
	});

	it("rejects a response cut off before the end of the headers", () => {
		expect(() => parseHttpResponse(bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n"))).toThrow("truncated");
	});
});
