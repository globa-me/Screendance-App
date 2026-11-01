export interface CountdownResult {
	success: boolean;
	cancelled?: boolean;
	error?: string;
}

export interface CountdownWindow {
	isDestroyed(): boolean;
	close(): void;
	once(event: "closed", callback: () => void): unknown;
	removeListener(event: "closed", callback: () => void): unknown;
	webContents: {
		isDestroyed(): boolean;
		isLoadingMainFrame(): boolean;
		send(channel: string, remaining: number): void;
		once(event: "did-finish-load" | "did-fail-load", callback: () => void): unknown;
		removeListener(event: "did-finish-load" | "did-fail-load", callback: () => void): unknown;
	};
}

type CountdownTimer = ReturnType<typeof setInterval>;
export interface CountdownState {
	inProgress: boolean;
	cancelled: boolean;
	remaining: number | null;
	timer: CountdownTimer | null;
}

interface CountdownDependencies {
	createWindow: () => CountdownWindow;
	onState: (state: CountdownState) => void;
	setInterval?: (callback: () => void, delayMs: number) => CountdownTimer;
	clearInterval?: (timer: CountdownTimer) => void;
}

interface CountdownSession {
	window: CountdownWindow;
	contents: CountdownWindow["webContents"];
	remaining: number;
	timer: CountdownTimer | null;
	resolve: (result: CountdownResult) => void;
	onLoad: () => void;
	onFailure: () => void;
	onClosed: () => void;
}

/** One owner controls its window, callbacks, timer and pending IPC result together. */
export class CountdownController {
	private active: CountdownSession | null = null;
	constructor(private readonly dependencies: CountdownDependencies) {}

	start(seconds: number): Promise<CountdownResult> {
		if (this.active)
			return Promise.resolve({ success: false, error: "Countdown already in progress" });
		if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 0) {
			return Promise.resolve({
				success: false,
				error: "Countdown seconds must be a nonnegative integer",
			});
		}
		if (seconds === 0) return Promise.resolve({ success: true });
		let window: CountdownWindow;
		try {
			window = this.dependencies.createWindow();
		} catch (error) {
			return Promise.resolve({ success: false, error: String(error) });
		}

		return new Promise<CountdownResult>((resolve) => {
			const session: CountdownSession = {
				window,
				contents: window.webContents,
				remaining: seconds,
				timer: null,
				resolve,
				onLoad: () => this.beginTicks(session),
				onFailure: () =>
					this.finish(session, {
						success: false,
						error: "Countdown window failed to load",
					}),
				onClosed: () => this.finish(session, { success: false, cancelled: true }),
			};
			this.active = session;
			this.publish(session);
			try {
				window.once("closed", session.onClosed);
				if (!this.alive(session)) {
					this.finish(session, { success: false, cancelled: true });
					return;
				}
				session.contents.once("did-fail-load", session.onFailure);
				if (session.contents.isLoadingMainFrame())
					session.contents.once("did-finish-load", session.onLoad);
				else this.beginTicks(session);
			} catch (error) {
				this.finish(session, { success: false, error: String(error) });
			}
		});
	}

	cancel(): { success: true } {
		if (this.active) this.finish(this.active, { success: false, cancelled: true });
		return { success: true };
	}

	private alive(session: CountdownSession): boolean {
		return !session.window.isDestroyed() && !session.contents.isDestroyed();
	}

	private publish(session: CountdownSession): void {
		this.dependencies.onState({
			inProgress: true,
			cancelled: false,
			remaining: session.remaining,
			timer: session.timer,
		});
	}

	private beginTicks(session: CountdownSession): void {
		if (this.active !== session || session.timer !== null) return;
		if (!this.alive(session)) {
			this.finish(session, { success: false, cancelled: true });
			return;
		}
		try {
			session.contents.send("countdown-tick", session.remaining);
			const tick = () => this.tick(session);
			session.timer = this.dependencies.setInterval
				? this.dependencies.setInterval(tick, 1000)
				: setInterval(tick, 1000);
			this.publish(session);
		} catch (error) {
			this.finish(session, { success: false, error: String(error) });
		}
	}

	private tick(session: CountdownSession): void {
		if (this.active !== session) return;
		if (!this.alive(session)) {
			this.finish(session, { success: false, cancelled: true });
			return;
		}
		session.remaining -= 1;
		if (session.remaining <= 0) {
			this.finish(session, { success: true });
			return;
		}
		try {
			session.contents.send("countdown-tick", session.remaining);
			this.publish(session);
		} catch (error) {
			this.finish(session, { success: false, error: String(error) });
		}
	}

	private finish(session: CountdownSession, result: CountdownResult): void {
		if (this.active !== session) return;
		this.active = null;
		if (session.timer !== null)
			(this.dependencies.clearInterval ?? clearInterval)(session.timer);
		session.window.removeListener("closed", session.onClosed);
		session.contents.removeListener("did-finish-load", session.onLoad);
		session.contents.removeListener("did-fail-load", session.onFailure);
		this.dependencies.onState({
			inProgress: false,
			cancelled: result.cancelled === true,
			remaining: null,
			timer: null,
		});
		// Resolve even if closing a native window fails; its old callbacks no longer own anything.
		session.resolve(result);
		try {
			if (!session.window.isDestroyed()) session.window.close();
		} catch {
			/* The IPC result and timer cleanup have already completed. */
		}
	}
}
