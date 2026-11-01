import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

// Resource files are sealed by their containing bundle. Signing every binary
// data file (locale.pak, images, fonts, model data) creates bogus signatures and
// sends hundreds of unnecessary timestamp requests.
const machMagic = new Set([
	0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
export function isMacCodeComponent(filename) {
	const stat = statSync(filename);
	if (stat.isDirectory())
		return [".app", ".framework", ".xpc", ".appex", ".bundle"].includes(path.extname(filename));
	if (!stat.isFile() || stat.size < 4) return false;
	const file = openSync(filename, "r");
	try {
		const magic = Buffer.alloc(4);
		return readSync(file, magic, 0, 4, 0) === 4 && machMagic.has(magic.readUInt32BE(0));
	} finally {
		closeSync(file);
	}
}
