const TYPING_INTERVAL_MS = 4000;

/** One bot's best-effort Telegram typing indicator: one request at a time, one failure report per lease. */
export class TelegramTypingLease {
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight: AbortController | null = null;
	private failureReported = false;

	constructor(
		private readonly sendTyping: (signal: AbortSignal) => Promise<unknown>,
		private readonly options: { onFailure?: (error: unknown) => void } = {},
	) {}

	start(): void {
		if (this.timer) return;
		this.failureReported = false;
		this.timer = setInterval(() => this.tick(), TYPING_INTERVAL_MS);
		this.timer.unref();
		this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		// A request landing after the reply would show "typing" again for five seconds.
		this.inFlight?.abort();
		this.inFlight = null;
	}

	private tick(): void {
		if (this.inFlight) return;
		const request = new AbortController();
		this.inFlight = request;
		void this.sendTyping(request.signal)
			.catch((error) => {
				if (!this.timer || this.failureReported) return;
				this.failureReported = true;
				this.options.onFailure?.(error);
			})
			.finally(() => {
				if (this.inFlight === request) this.inFlight = null;
			});
	}
}
