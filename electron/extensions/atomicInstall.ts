import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Copy and validate first, retain the previous plugin until publication and metadata succeed. */
export async function replaceExtensionDirectory(
	sourcePath: string,
	targetPath: string,
	validate: (directory: string) => Promise<void>,
	commit: () => Promise<void>,
) {
	const source = await fs.realpath(sourcePath);
	const parent = await fs.realpath(path.dirname(targetPath));
	const target = path.join(parent, path.basename(targetPath));
	if (
		source === target ||
		source.startsWith(`${target}${path.sep}`) ||
		target.startsWith(`${source}${path.sep}`)
	)
		throw new Error("Extension source and installation target must be separate directories.");
	const prior = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (prior && (!prior.isDirectory() || prior.isSymbolicLink()))
		throw new Error("Extension target is not a regular directory.");
	const staging = path.join(parent, `.install-${randomUUID()}`);
	const backup = path.join(parent, `.backup-${randomUUID()}`);
	let priorMoved = false;
	let publishedIdentity: { dev: number; ino: number } | null = null;
	try {
		await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false });
		await validate(staging);
		const current = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (
			Boolean(current) !== Boolean(prior) ||
			(current &&
				prior &&
				(current.dev !== prior.dev ||
					current.ino !== prior.ino ||
					current.isSymbolicLink()))
		)
			throw new Error("Extension target changed during installation.");
		if (prior) {
			await fs.rename(target, backup);
			priorMoved = true;
		}
		await fs.rename(staging, target);
		const published = await fs.lstat(target);
		publishedIdentity = { dev: published.dev, ino: published.ino };
		await commit();
	} catch (error) {
		const current = await fs.lstat(target).catch(() => null);
		const ownsTarget =
			current &&
			publishedIdentity &&
			current.dev === publishedIdentity.dev &&
			current.ino === publishedIdentity.ino &&
			!current.isSymbolicLink();
		if (ownsTarget) await fs.rm(target, { recursive: true, force: true });
		if (priorMoved) {
			if (!(await fs.lstat(target).catch(() => null))) await fs.rename(backup, target);
			else
				throw new Error(
					`Extension installation failed; previous version retained at ${backup}. ${error instanceof Error ? error.message : String(error)}`,
				);
		}
		throw error;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
	if (priorMoved)
		await fs
			.rm(backup, { recursive: true, force: true })
			.catch((error) =>
				console.warn(`Could not remove old extension backup ${backup}:`, error),
			);
}
