import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const signingTeam = "BN3D9H4C7J";

export function describeCertificate(pemOrDer) {
	const certificate = new X509Certificate(pemOrDer);
	return {
		subject: certificate.subject,
		issuer: certificate.issuer,
		sha1: certificate.fingerprint.replaceAll(":", ""),
		serialNumber: certificate.serialNumber,
		validFrom: certificate.validFrom,
		validTo: certificate.validTo,
	};
}

export function requireG2Certificate(certificate) {
	if (
		!certificate.subject.split("\n").includes(`OU=${signingTeam}`) ||
		!certificate.subject
			.split("\n")
			.some((field) => field.startsWith("CN=Developer ID Application:")) ||
		!certificate.issuer.split("\n").includes("OU=G2") ||
		!certificate.issuer.split("\n").includes("CN=Developer ID Certification Authority")
	) {
		throw new Error(
			`Release signing requires Developer ID Application from issuer G2 for team ${signingTeam}; got ${certificate.sha1}, issuer ${certificate.issuer.replaceAll("\n", ", ")}`,
		);
	}
	if (Date.parse(certificate.validTo) <= Date.now()) {
		throw new Error(`G2 certificate ${certificate.sha1} has expired: ${certificate.validTo}`);
	}
	if (Date.parse(certificate.validFrom) > Date.now()) {
		throw new Error(
			`G2 certificate ${certificate.sha1} is not valid yet: ${certificate.validFrom}`,
		);
	}
	if (process.env.G2_SIGNING_SHA1 && process.env.G2_SIGNING_SHA1 !== certificate.sha1) {
		throw new Error(`Signature does not match G2_SIGNING_SHA1: ${certificate.sha1}`);
	}
	return certificate;
}

export function selectG2Identity() {
	const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
		encoding: "utf8",
	});
	const available = new Set(
		[...identities.matchAll(/\) ([A-F0-9]{40}) "Developer ID Application:[^\n]+/g)]
			.filter((match) => !match[0].includes("CSSMERR_"))
			.map((match) => match[1]),
	);
	const pem = execFileSync(
		"security",
		["find-certificate", "-a", "-c", "Developer ID Application", "-p"],
		{ encoding: "utf8" },
	);
	const candidates = (
		pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []
	)
		.map(describeCertificate)
		.filter((certificate) => available.has(certificate.sha1))
		.filter((certificate) => {
			try {
				requireG2Certificate(certificate);
				return true;
			} catch {
				return false;
			}
		});
	const unique = [
		...new Map(candidates.map((certificate) => [certificate.sha1, certificate])).values(),
	];
	if (unique.length !== 1) {
		throw new Error(
			`Expected one usable G2 signing identity for ${signingTeam}; found ${unique.length}. Install the shared G2 certificate with its private key, or set G2_SIGNING_SHA1 when multiple G2 identities exist.`,
		);
	}
	return unique[0];
}

export function verifyG2Signature(file) {
	execFileSync("codesign", ["--verify", "--deep", "--strict", file], { stdio: "pipe" });
	const display = spawnSync("codesign", ["--display", "--verbose=4", file], { encoding: "utf8" });
	if (display.status !== 0)
		throw new Error(display.stderr || `Cannot inspect signature: ${file}`);
	if (!/^Timestamp=.+/m.test(display.stderr)) {
		throw new Error(`Missing secure timestamp: ${file}`);
	}
	if (!display.stderr.split("\n").includes(`TeamIdentifier=${signingTeam}`)) {
		throw new Error(`Unexpected signing team: ${file}`);
	}
	const temporary = mkdtempSync(path.join(os.tmpdir(), "screendance-g2-certificate-"));
	try {
		const prefix = path.join(temporary, "certificate");
		execFileSync("codesign", ["--display", `--extract-certificates=${prefix}`, file], {
			stdio: "pipe",
		});
		const certificate = requireG2Certificate(describeCertificate(readFileSync(`${prefix}0`)));
		console.log(
			`[g2-signing] Verified ${file}: ${certificate.sha1}; expires ${certificate.validTo}`,
		);
		return certificate;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export default function afterSign(context) {
	if (context.electronPlatformName !== "darwin") return;
	verifyG2Signature(
		path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
	);
}
