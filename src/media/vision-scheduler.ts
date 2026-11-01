/** One deployment-wide gate over vision work: each description's preparation and provider call. */
export class VisionScheduler {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly concurrency: number) {}

	schedule<T>(run: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push(() => {
				this.active++;
				void run()
					.then(resolve, reject)
					.finally(() => {
						this.active--;
						this.drain();
					});
			});
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.concurrency) {
			const start = this.queue.shift();
			if (!start) return;
			start();
		}
	}
}
