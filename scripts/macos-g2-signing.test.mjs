import assert from "node:assert/strict";
import { test } from "node:test";
import { requireG2Certificate } from "./macos-g2-signing.mjs";

const certificate = {
	subject: "CN=Developer ID Application: Gennadiy Zakharov (BN3D9H4C7J)\nOU=BN3D9H4C7J",
	issuer: "CN=Developer ID Certification Authority\nOU=G2\nO=Apple Inc.",
	sha1: "A".repeat(40),
	validFrom: new Date(Date.now() - 86400000).toUTCString(),
	validTo: new Date(Date.now() + 86400000).toUTCString(),
};

test("accepts a current Developer ID Application from G2 for the expected team", () => {
	assert.equal(requireG2Certificate(certificate), certificate);
});

test("rejects an identically named certificate from the previous authority", () => {
	assert.throws(
		() =>
			requireG2Certificate({
				...certificate,
				issuer: certificate.issuer.replace("OU=G2", "OU=Apple Certification Authority"),
			}),
		/requires Developer ID Application from issuer G2/,
	);
});

test("rejects a different team and a Developer ID Installer", () => {
	assert.throws(() =>
		requireG2Certificate({
			...certificate,
			subject: certificate.subject.replace("OU=BN3D9H4C7J", "OU=OTHER"),
		}),
	);
	assert.throws(() =>
		requireG2Certificate({
			...certificate,
			subject: certificate.subject.replace("Application:", "Installer:"),
		}),
	);
});

test("rejects expired and not-yet-valid release identities", () => {
	assert.throws(
		() => requireG2Certificate({ ...certificate, validTo: new Date(0).toUTCString() }),
		/has expired/,
	);
	assert.throws(
		() => requireG2Certificate({ ...certificate, validFrom: certificate.validTo }),
		/is not valid yet/,
	);
});

test("requires the explicitly pinned fingerprint when one is configured", () => {
	const previous = process.env.G2_SIGNING_SHA1;
	try {
		process.env.G2_SIGNING_SHA1 = "B".repeat(40);
		assert.throws(() => requireG2Certificate(certificate), /does not match G2_SIGNING_SHA1/);
		process.env.G2_SIGNING_SHA1 = certificate.sha1;
		assert.equal(requireG2Certificate(certificate), certificate);
	} finally {
		if (previous === undefined) delete process.env.G2_SIGNING_SHA1;
		else process.env.G2_SIGNING_SHA1 = previous;
	}
});
