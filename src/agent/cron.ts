import { type Database, getDaemonState, setDaemonState } from "../db/db.ts";

export type CronJob = { id: string; schedule: string; prompt: string; next: number; once: boolean };

const FIELD = /^(\*|\d+(-\d+)?)(\/[1-9]\d*)?(,(\*|\d+(-\d+)?)(\/[1-9]\d*)?)*$/;
const match = (expr: string, v: number, min: number, max: number) =>
	FIELD.test(expr) &&
	expr.split(",").some((p) => {
		const [r, s = "1"] = p.split("/");
		const [lo, hi = lo] = r === "*" ? [min, max] : r!.split("-").map(Number);
		return lo! >= min && hi! <= max && lo! <= hi! && v >= lo! && v <= hi! && (v - lo!) % Number(s) === 0;
	});

export function parseSchedule(spec: string, now = Date.now()): { next: number; once: boolean } {
	const rel = /^\+?(\d+)\s*(s|m|h|d)$/i.exec(spec.trim());
	if (rel) {
		const ms = Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]!.toLowerCase() as "s"]!;
		if (ms < 10_000 || ms > 366 * 86_400_000) throw new Error("delay must be 10s..366d");
		return { next: now + ms, once: true };
	}
	const parts = spec.trim().split(/\s+/);
	if (parts.length !== 5) {
		const next = Date.parse(spec);
		if (!Number.isFinite(next) || next <= now)
			throw new Error("expected future ISO datetime, +Nm/h/d, or 5-field cron");
		return { next, once: true };
	}
	const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
	for (let t = (Math.floor(now / 60_000) + 1) * 60_000, i = 0; i < 527_040; i++, t += 60_000) {
		const d = new Date(t);
		if (
			match(m, d.getMinutes(), 0, 59) &&
			match(h, d.getHours(), 0, 23) &&
			match(dom, d.getDate(), 1, 31) &&
			match(mon, d.getMonth() + 1, 1, 12) &&
			(match(dow, d.getDay(), 0, 7) || (d.getDay() === 0 && match(dow, 7, 0, 7)))
		)
			return { next: t, once: false };
	}
	throw new Error("invalid cron schedule");
}

const read = (db: Database): CronJob[] => JSON.parse(getDaemonState(db, "crons") ?? "[]") as CronJob[];
const write = (db: Database, jobs: CronJob[]) => setDaemonState(db, "crons", JSON.stringify(jobs));
const fmt = (ms: number) => new Date(ms).toLocaleString("sv-SE");

export const describeCrons = (db: Database): string =>
	read(db)
		.map(
			(j) =>
				`${j.id} [${j.once ? "once" : j.schedule} -> ${fmt(j.next)}] ${j.prompt.replace(/\s+/g, " ").slice(0, 80)}`,
		)
		.join("\n");

export function addCron(db: Database, schedule: string, prompt: string): string {
	const jobs = read(db);
	if (jobs.length >= 16) throw new Error("cron limit (16) reached");
	const parsed = parseSchedule(schedule);
	const seq = Number(getDaemonState(db, "cron_seq") ?? "0") + 1;
	setDaemonState(db, "cron_seq", String(seq));
	const job: CronJob = { id: `c${seq}`, schedule: schedule.trim(), prompt: prompt.trim(), ...parsed };
	write(db, [...jobs, job]);
	return `${job.id} scheduled for ${fmt(job.next)}`;
}

export function removeCron(db: Database, id: string): boolean {
	const jobs = read(db);
	const kept = jobs.filter((j) => j.id !== id);
	if (kept.length !== jobs.length) write(db, kept);
	return kept.length !== jobs.length;
}

export function tickCrons(db: Database, fire: (job: CronJob) => boolean, now = Date.now()): void {
	const jobs = read(db);
	if (!jobs.some((j) => j.next <= now)) return;
	write(
		db,
		jobs.flatMap((j) =>
			j.next > now || !fire(j) ? [j] : j.once ? [] : [{ ...j, next: parseSchedule(j.schedule, now).next }],
		),
	);
}
