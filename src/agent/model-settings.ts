import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export type PiModelDefaults = ReturnType<typeof loadPiModelDefaults>;

/** Read Pi's merged global/project defaults without copying or exposing credential data. */
export function loadPiModelDefaults(projectRoot: string, agentDir = getAgentDir()) {
	const settings = SettingsManager.create(projectRoot, agentDir);
	const loadErrors = settings.drainErrors();
	if (loadErrors.length > 0) {
		throw new Error(
			`Pi settings unavailable (${[...new Set(loadErrors.map((error) => error.scope))].join(",")}). Fix Pi settings, then restart.`,
		);
	}

	return {
		provider: settings.getDefaultProvider(),
		model: settings.getDefaultModel(),
	};
}
