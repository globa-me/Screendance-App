type GradientStop = {
	color: string;
	position: number | null;
};

function clampUnit(value: number) {
	return Math.min(1, Math.max(0, value));
}

export function splitCssGradientArguments(params: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;

	for (const char of params) {
		if (char === "(") {
			depth++;
			current += char;
			continue;
		}
		if (char === ")") {
			depth = Math.max(0, depth - 1);
			current += char;
			continue;
		}
		if (char === "," && depth === 0) {
			if (current.trim()) {
				parts.push(current.trim());
			}
			current = "";
			continue;
		}

		current += char;
	}

	if (current.trim()) {
		parts.push(current.trim());
	}

	return parts;
}

function parseCssGradientColorStop(part: string): GradientStop | null {
	const colorMatch = part.match(/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+(?:\([^)]*\)|[\w-]*))/);
	if (!colorMatch) {
		return null;
	}

	const color = colorMatch[1];
	const positionMatch = part
		.slice(color.length)
		.trim()
		.match(/^(-?\d*\.?\d+)%/);

	return {
		color,
		position: positionMatch ? clampUnit(Number(positionMatch[1]) / 100) : null,
	};
}

function resolveGradientStopPositions(stops: GradientStop[]): Array<{
	color: string;
	position: number;
}> {
	if (stops.length === 1) {
		return [
			{ color: stops[0].color, position: 0 },
			{ color: stops[0].color, position: 1 },
		];
	}

	const resolved = stops.map((stop) => ({ ...stop }));
	resolved[0].position ??= 0;
	resolved[resolved.length - 1].position ??= 1;

	let index = 0;
	while (index < resolved.length) {
		if (resolved[index].position !== null) {
			index++;
			continue;
		}

		const startIndex = index - 1;
		let endIndex = index + 1;
		while (endIndex < resolved.length && resolved[endIndex].position === null) {
			endIndex++;
		}

		const start = resolved[startIndex]?.position ?? 0;
		const end = resolved[endIndex]?.position ?? 1;
		const gap = endIndex - startIndex;
		for (let fillIndex = index; fillIndex < endIndex; fillIndex++) {
			resolved[fillIndex].position = start + ((end - start) * (fillIndex - startIndex)) / gap;
		}
		index = endIndex;
	}

	return resolved.map((stop) => ({
		color: stop.color,
		position: clampUnit(stop.position ?? 0),
	}));
}

function parseLinearGradientDirection(direction: string | null) {
	if (!direction) {
		return { dx: 0, dy: 1 };
	}

	const normalized = direction.trim().toLowerCase();
	const angleMatch = normalized.match(/^(-?\d*\.?\d+)deg$/);
	if (angleMatch) {
		const radians = (Number(angleMatch[1]) * Math.PI) / 180;
		return {
			dx: Math.sin(radians),
			dy: -Math.cos(radians),
		};
	}

	if (normalized.startsWith("to ")) {
		const dx = normalized.includes("right") ? 1 : normalized.includes("left") ? -1 : 0;
		const dy = normalized.includes("bottom") ? 1 : normalized.includes("top") ? -1 : 0;
		if (dx !== 0 || dy !== 0) {
			return { dx, dy };
		}
	}

	return { dx: 0, dy: 1 };
}

function createLinearCssGradient(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	direction: string | null,
) {
	const { dx, dy } = parseLinearGradientDirection(direction);
	const length = Math.abs(width * dx) + Math.abs(height * dy) || height;
	const centerX = width / 2;
	const centerY = height / 2;

	return ctx.createLinearGradient(
		centerX - (dx * length) / 2,
		centerY - (dy * length) / 2,
		centerX + (dx * length) / 2,
		centerY + (dy * length) / 2,
	);
}

function createRadialCssGradient(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	shapePart: string | null,
) {
	const normalized = shapePart?.toLowerCase() ?? "";
	const atMatch = normalized.match(/at\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%/);
	const centerX = atMatch ? (Number(atMatch[1]) / 100) * width : width / 2;
	const centerY = atMatch ? (Number(atMatch[2]) / 100) * height : height / 2;
	const radius = Math.max(
		Math.hypot(centerX, centerY),
		Math.hypot(width - centerX, centerY),
		Math.hypot(centerX, height - centerY),
		Math.hypot(width - centerX, height - centerY),
	);

	return ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
}

function isLinearDirection(part: string) {
	const normalized = part.trim().toLowerCase();
	return normalized.startsWith("to ") || /^-?\d*\.?\d+deg$/.test(normalized);
}

function isRadialShape(part: string) {
	return /\b(circle|ellipse|closest|farthest|at)\b/i.test(part);
}

export function createCanvasGradientFromCss(
	ctx: CanvasRenderingContext2D,
	wallpaper: string,
	width: number,
	height: number,
): CanvasGradient | null {
	const gradientMatch = wallpaper.match(/^(linear|radial)-gradient\((.+)\)$/i);
	if (!gradientMatch) {
		return null;
	}

	const [, type, params] = gradientMatch;
	const parts = splitCssGradientArguments(params);
	if (parts.length === 0) {
		return null;
	}

	const firstPart = parts[0];
	const directionOrShape =
		type === "linear"
			? isLinearDirection(firstPart)
				? (parts.shift() ?? null)
				: null
			: isRadialShape(firstPart)
				? (parts.shift() ?? null)
				: null;
	const stops = resolveGradientStopPositions(
		parts.map(parseCssGradientColorStop).filter((stop): stop is GradientStop => Boolean(stop)),
	);
	if (stops.length === 0) {
		return null;
	}

	const gradient =
		type === "linear"
			? createLinearCssGradient(ctx, width, height, directionOrShape)
			: createRadialCssGradient(ctx, width, height, directionOrShape);

	try {
		for (const stop of stops) {
			gradient.addColorStop(stop.position, stop.color);
		}
	} catch (error) {
		console.warn("[VideoExporter] Unable to apply CSS gradient color stop", error);
		return null;
	}

	return gradient;
}
