import { z } from "zod";

const text = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => !value.includes("\0"), "NUL characters are not allowed");
const id = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[a-z0-9][a-z0-9._:-]*$/i)
	.refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const empty = z.strictObject({});
const binding = z.strictObject({
	key: z.string().min(1).max(32),
	ctrl: z.boolean().optional(),
	shift: z.boolean().optional(),
	alt: z.boolean().optional(),
});
const bindings = z.strictObject({
	addZoom: binding.optional(),
	splitClip: binding.optional(),
	addAnnotation: binding.optional(),
	addKeyframe: binding.optional(),
	deleteSelected: binding.optional(),
	playPause: binding.optional(),
});

export const SYSTEM_AUTOMATION_SCHEMAS = {
	"app.windows": empty,
	"app.window": z.strictObject({
		id: z.number().int().positive(),
		action: z.enum(["show", "focus", "hide", "minimize", "maximize", "restore", "close"]),
	}),
	"app.open": z.strictObject({ window: z.enum(["editor", "recorder", "sources"]) }),
	"app.quit": empty,
	"settings.get": empty,
	"settings.hud.get": empty,
	"settings.hud.set": z.strictObject({ captureProtection: z.boolean() }),
	"settings.set": z.strictObject({
		theme: z.enum(["light", "dark", "system"]).optional(),
		locale: z
			.enum(["en", "es", "fr", "it", "nl", "ko", "pt-BR", "ru", "zh-CN", "zh-TW"])
			.optional(),
	}),
	"settings.directories.get": empty,
	"settings.directories.set": z.strictObject({ recordingsPath: text }),
	"shortcuts.get": empty,
	"shortcuts.set": z.strictObject({ bindings }),
	"fonts.list": empty,
	"fonts.add": z.strictObject({
		name: z.string().trim().min(1).max(128),
		fontFamily: z
			.string()
			.trim()
			.min(1)
			.max(128)
			.regex(/^[\p{L}\p{N} _-]+$/u),
		importUrl: z.string().url().max(2048),
	}),
	"fonts.remove": z.strictObject({ id: text }),
	"wallpapers.list": empty,
	"wallpapers.add": z.strictObject({ path: text }),
	"wallpapers.remove": z.strictObject({ path: text }),
	"extensions.list": empty,
	"extensions.discover": empty,
	"extensions.install": z.strictObject({ path: text, overwrite: z.boolean().optional() }),
	"extensions.uninstall": z.strictObject({ id }),
	"extensions.setEnabled": z.strictObject({ id, enabled: z.boolean() }),
	"extensions.settings.get": z.strictObject({ id }),
	"extensions.settings.set": z.strictObject({ id, settingId: id, value: z.json() }),
	"extensions.marketplace.search": z.strictObject({
		query: z.string().max(256).optional(),
		sort: z.enum(["popular", "recent", "rating"]).optional(),
		page: z.number().int().min(1).max(1000).optional(),
		pageSize: z.number().int().min(1).max(100).optional(),
	}),
	"extensions.marketplace.get": z.strictObject({ id }),
	"extensions.marketplace.install": z.strictObject({
		id,
		overwrite: z.boolean().optional(),
		enabled: z.boolean().optional(),
	}),
	"updates.status": empty,
	"updates.check": empty,
	"updates.download": empty,
	"updates.install": empty,
	"updates.defer": z.strictObject({
		delayMs: z
			.number()
			.int()
			.min(60_000)
			.max(7 * 24 * 60 * 60 * 1000)
			.optional(),
	}),
	"updates.dismiss": empty,
	"updates.skip": empty,
	"updates.preview": empty,
	"diagnostics.get": empty,
	"logs.read": z.strictObject({
		id: z.enum(["updater", "app"]),
		maxBytes: z.number().int().min(1).max(65536).optional(),
	}),
	"logs.clear": z.strictObject({ id: z.literal("app") }),
	"clipboard.write": z.strictObject({ text: z.string().max(65536) }),
	"files.reveal": z.strictObject({ path: text }),
	"folders.open": z.strictObject({
		kind: z.enum(["recordings", "projects", "extensions", "userData"]),
	}),
	"sources.highlight": z.strictObject({ sourceId: text }),
	"project.rename": z.strictObject({
		name: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.refine(
				(value) =>
					!Array.from(value).some((char) => char.charCodeAt(0) < 32) &&
					!/[/\\]/.test(value) &&
					value !== "." &&
					value !== "..",
			),
	}),
} as const;

export type SystemAutomationCommand = keyof typeof SYSTEM_AUTOMATION_SCHEMAS;
export function isSystemAutomationCommand(method: string): method is SystemAutomationCommand {
	return Object.keys(SYSTEM_AUTOMATION_SCHEMAS).includes(method);
}
export function parseSystemAutomationParams(
	method: SystemAutomationCommand,
	value: unknown,
): Record<string, unknown> {
	return SYSTEM_AUTOMATION_SCHEMAS[method].parse(value) as Record<string, unknown>;
}

const descriptions: Record<SystemAutomationCommand, string> = {
	"app.windows": "List application windows, visibility, focus and bounds.",
	"app.window":
		"Control one application window by the exact id returned by app.windows. Close refuses unsaved work or active operations.",
	"app.open": "Open or focus the editor, recorder or capture-source selector.",
	"app.quit":
		"Quit the desktop application only when no unsaved work or active operations remain.",
	"settings.get": "Read current theme and locale preferences.",
	"settings.hud.get": "Read recording-controls capture protection and platform support.",
	"settings.hud.set":
		"Explicitly hide or show recording controls in future capture using the existing HUD setting.",
	"settings.set":
		"Apply supplied theme/locale preferences through their live application providers.",
	"settings.directories.get": "Read application, recording and project directories.",
	"settings.directories.set":
		"Use an existing absolute directory for future recordings; existing media is not moved.",
	"shortcuts.get": "Read configurable and fixed editor keyboard shortcuts.",
	"shortcuts.set": "Update supplied editor keyboard shortcuts and refuse conflicts.",
	"fonts.list": "List registered custom fonts.",
	"fonts.add": "Load and register a font from an HTTPS Google Fonts stylesheet.",
	"fonts.remove": "Remove a custom font registration by id.",
	"wallpapers.list": "List built-in, custom and extension wallpapers.",
	"wallpapers.add": "Register an existing local image/video as a custom wallpaper.",
	"wallpapers.remove": "Remove a custom wallpaper registration without deleting the media file.",
	"extensions.list": "List installed extensions, status, contributions and permissions.",
	"extensions.discover":
		"Refresh the extension catalog and reconcile configured active extensions.",
	"extensions.install":
		"Install a local extension folder; replacement requires overwrite=true. Installing an extension authorizes its declared code and permissions.",
	"extensions.uninstall": "Uninstall a user extension; built-in extensions cannot be removed.",
	"extensions.setEnabled":
		"Explicitly enable or disable an installed extension and synchronize its runtime.",
	"extensions.settings.get": "Read an extension's registered setting fields and current values.",
	"extensions.settings.set":
		"Set one declared extension field after validating its type/range/options.",
	"extensions.marketplace.search": "Browse the configured extension marketplace.",
	"extensions.marketplace.get": "Read one marketplace extension by id.",
	"extensions.marketplace.install":
		"Download a selected catalog extension from its trusted marketplace origin and install transactionally. Replacement requires overwrite=true; enabled defaults to true as in the UI.",
	"updates.status": "Read updater availability, state and visible notification.",
	"updates.check":
		"Check the configured Screendance update feed without showing an information dialog.",
	"updates.download": "Download the available application update without installing it.",
	"updates.install":
		"Install a ready update and restart only when the application has no unsaved work or active operations.",
	"updates.defer": "Defer a downloaded update reminder.",
	"updates.dismiss": "Dismiss the current update notification.",
	"updates.skip": "Skip the currently available update version.",
	"updates.preview":
		"Show the application's development update-notification preview. This changes the updater's preview state without downloading or installing an update.",
	"diagnostics.get":
		"Read application/runtime and last native-capture diagnostics; no arbitrary filesystem access.",
	"logs.read": "Read a bounded tail of the application's app/updater log by fixed catalog id.",
	"logs.clear":
		"Clear the application log through its existing logging service; updater logs are retained.",
	"clipboard.write": "Copy supplied text to the system clipboard.",
	"files.reveal": "Reveal an existing absolute local file or directory in Finder.",
	"folders.open": "Open one of the application's managed folders in Finder.",
	"sources.highlight":
		"Highlight the exact selected capture source using the existing native highlight operation.",
	"project.rename":
		"Rename the current saved project through its live save pipeline, refusing conflicting targets.",
};
const readOnly = new Set<SystemAutomationCommand>([
	"app.windows",
	"settings.get",
	"settings.hud.get",
	"settings.directories.get",
	"shortcuts.get",
	"fonts.list",
	"wallpapers.list",
	"extensions.list",
	"extensions.settings.get",
	"extensions.marketplace.search",
	"extensions.marketplace.get",
	"updates.status",
	"diagnostics.get",
	"logs.read",
]);
const destructive = new Set<SystemAutomationCommand>([
	"app.quit",
	"extensions.install",
	"extensions.marketplace.install",
	"extensions.uninstall",
	"updates.install",
	"project.rename",
	"logs.clear",
]);
export const SYSTEM_AUTOMATION_COMMANDS = (
	Object.keys(SYSTEM_AUTOMATION_SCHEMAS) as SystemAutomationCommand[]
).map((name) => {
	const { $schema: _schema, ...inputSchema } = z.toJSONSchema(SYSTEM_AUTOMATION_SCHEMAS[name], {
		unrepresentable: "any",
	});
	return {
		name,
		description: descriptions[name],
		readOnly: readOnly.has(name),
		destructive: destructive.has(name),
		inputSchema: {
			...inputSchema,
			type: "object" as const,
			properties: inputSchema.properties ?? {},
		},
	};
});
