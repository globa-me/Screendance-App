import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const localesDir = path.join(root, "src", "i18n", "locales");

const locales = fs
	.readdirSync(localesDir)
	.filter((entry) => {
		const fullPath = path.join(localesDir, entry);
		return fs.statSync(fullPath).isDirectory();
	})
	.sort((left, right) => left.localeCompare(right));

const localeConfig = fs.readFileSync(path.join(root, "src", "i18n", "config.ts"), "utf8");
const supportedLocalesMatch = localeConfig.match(/export const SUPPORTED_LOCALES = (\[[^\]]+\])/);
if (!supportedLocalesMatch) {
	console.error("i18n-check: cannot read SUPPORTED_LOCALES from src/i18n/config.ts");
	process.exit(1);
}
const supportedLocales = JSON.parse(supportedLocalesMatch[1]).sort((left, right) => left.localeCompare(right));
if (JSON.stringify(locales) !== JSON.stringify(supportedLocales)) {
	console.error(`i18n-check: locale directories and SUPPORTED_LOCALES differ: directories=${locales.join(",")} configured=${supportedLocales.join(",")}`);
	process.exit(1);
}

if (!locales.includes("en")) {
	console.error('i18n-check: expected base locale directory "en"');
	process.exit(1);
}

function loadJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`i18n-check: failed to load ${path.relative(root, filePath)}: ${message}`);
	}
}

function collectKeyPaths(obj, prefix = "") {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
		return prefix ? [prefix] : [];
	}

	const keys = Object.keys(obj);
	if (keys.length === 0) {
		return prefix ? [prefix] : [];
	}

	const paths = [];
	for (const key of keys) {
		const nextPrefix = prefix ? `${prefix}.${key}` : key;
		const value = obj[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			paths.push(...collectKeyPaths(value, nextPrefix));
		} else {
			paths.push(nextPrefix);
		}
	}
	return paths;
}

const baseLocaleDir = path.join(localesDir, "en");
const namespaceFiles = fs
	.readdirSync(baseLocaleDir)
	.filter((file) => file.endsWith(".json"))
	.sort((left, right) => left.localeCompare(right));

let hasErrors = false;
const contextSource = fs.readFileSync(path.join(root, "src", "contexts", "I18nContext.tsx"), "utf8");
const menuSource = fs.readFileSync(path.join(root, "src", "components", "launch", "popovers", "MorePopover.tsx"), "utf8");
const menuLabels = menuSource.match(/const LOCALE_LABELS:[^=]+ = \{([\s\S]*?)\};/)?.[1] ?? "";
for (const locale of locales) {
	const quotedLocale = JSON.stringify(locale);
	if (!contextSource.includes(`${quotedLocale}: {`) && !contextSource.includes(`${locale}: {`)) {
		console.error(`i18n-check: ${locale} is missing from I18nContext messages`);
		hasErrors = true;
	}
	if (!menuLabels.includes(`${quotedLocale}:`) && !menuLabels.includes(`${locale}:`)) {
		console.error(`i18n-check: ${locale} is missing from the language menu`);
		hasErrors = true;
	}
	for (const namespaceFile of namespaceFiles) {
		if (!contextSource.includes(`/locales/${locale}/${namespaceFile}`)) {
			console.error(`i18n-check: ${locale}/${namespaceFile} is not imported by I18nContext`);
			hasErrors = true;
		}
	}
}

for (const namespaceFile of namespaceFiles) {
	const baseData = loadJson(path.join(baseLocaleDir, namespaceFile));
	const baseKeys = new Set(collectKeyPaths(baseData));

	for (const locale of locales) {
		if (locale === "en") continue;

		const localeFile = path.join(localesDir, locale, namespaceFile);
		if (!fs.existsSync(localeFile)) {
			console.error(`i18n-check: missing namespace file ${locale}/${namespaceFile}`);
			hasErrors = true;
			continue;
		}

		const localeData = loadJson(localeFile);
		const localeKeys = new Set(collectKeyPaths(localeData));

		for (const key of baseKeys) {
			if (!localeKeys.has(key)) {
				console.error(`i18n-check: missing key ${locale}/${namespaceFile}:${key}`);
				hasErrors = true;
			}
		}

		for (const key of localeKeys) {
			if (!baseKeys.has(key)) {
				console.error(`i18n-check: extra key ${locale}/${namespaceFile}:${key}`);
				hasErrors = true;
			}
		}
	}
}

if (hasErrors) {
	process.exit(1);
}

console.log("i18n-check: locale files are structurally consistent");
