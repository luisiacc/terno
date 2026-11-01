export interface DeployStep {
  name: string;
  cmd?: string;
  args?: string[];
  cwd?: "repo";
  capture?: boolean;
  ensureDatabase?: string;
  hint: string;
}
export function deploySteps(o: { preview: boolean }): DeployStep[];
export function runSteps(
  steps: DeployStep[],
  io: { exec(step: DeployStep): Promise<{ ok: boolean; stdout?: string }>; ensureDatabase(name: string): Promise<boolean> },
): Promise<{ ok: boolean; failed?: string; hint?: string; stdout: string }>;
