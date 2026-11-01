/** Bounded JSON-schema validation for small data-only command contracts. */
export function validateCommandSchema(
	value: unknown,
	schema: Record<string, unknown>,
	location = "params",
	depth = 0,
): string | null {
	if (depth > 48) return `${location} is too deeply nested.`;
	if (Array.isArray(schema.enum) && !schema.enum.includes(value))
		return `${location} is not a supported value.`;
	if (schema.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return `${location} must be an object.`;
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		const object = value as Record<string, unknown>;
		if (
			Object.keys(object).some(
				(key) =>
					["__proto__", "constructor", "prototype"].includes(key) || !(key in properties),
			)
		)
			return `${location} has unexpected fields.`;
		for (const key of (schema.required ?? []) as string[])
			if (!Object.keys(object).includes(key)) return `${location}.${key} is required.`;
		for (const [key, item] of Object.entries(object)) {
			const error = validateCommandSchema(
				item,
				properties[key],
				`${location}.${key}`,
				depth + 1,
			);
			if (error) return error;
		}
		return null;
	}
	if (schema.type === "array") {
		if (
			!Array.isArray(value) ||
			value.length > Number(schema.maxItems ?? 10000) ||
			value.length < Number(schema.minItems ?? 0)
		)
			return `${location} must be a bounded array.`;
		for (let index = 0; index < value.length; index++) {
			const error = validateCommandSchema(
				value[index],
				schema.items as Record<string, unknown>,
				`${location}[${index}]`,
				depth + 1,
			);
			if (error) return error;
		}
		return null;
	}
	if (schema.type === "string")
		return typeof value !== "string" ||
			value.includes("\0") ||
			value.length < Number(schema.minLength ?? 0) ||
			value.length > Number(schema.maxLength ?? 4096)
			? `${location} must be a valid bounded string.`
			: null;
	if (schema.type === "boolean")
		return typeof value === "boolean" ? null : `${location} must be boolean.`;
	if (schema.type === "number" || schema.type === "integer")
		return typeof value !== "number" ||
			!Number.isFinite(value) ||
			(schema.type === "integer" && !Number.isSafeInteger(value)) ||
			value < Number(schema.minimum ?? -Number.MAX_SAFE_INTEGER) ||
			value > Number(schema.maximum ?? Number.MAX_SAFE_INTEGER)
			? `${location} must be a valid ${schema.type}.`
			: null;
	return `${location} has an unsupported schema.`;
}
