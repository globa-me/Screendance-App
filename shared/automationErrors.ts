export interface AutomationErrorData {
	code: string;
	message: string;
	details?: unknown;
}

export class AutomationError extends Error {
	constructor(
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "AutomationError";
	}
}

export function toAutomationError(error: unknown): AutomationErrorData {
	if (error instanceof AutomationError) {
		return {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	return {
		code: "INTERNAL_ERROR",
		message: error instanceof Error ? error.message : String(error),
	};
}
