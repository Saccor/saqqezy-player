export type ProdEnvApp = 'tv' | 'companion';
type Env = Record<string, string | boolean | undefined>;

export const PROD_ENV: Readonly<Record<ProdEnvApp, Readonly<Record<string, string>>>>;
export function strictProdEnv(processEnv?: Record<string, string | undefined>): boolean;
export function missingProdEnv(app: ProdEnvApp, env: Env): string[];
export function bakedValues(app: ProdEnvApp, env: Env): string[];
export function prodEnvMessage(app: ProdEnvApp, missing: readonly string[], strict: boolean): string | undefined;
export function checkProdEnv(app: ProdEnvApp, env: Env, opts?: { strict?: boolean; warn?: (message: string) => void }): string[];
export function prodEnvCheck(app: ProdEnvApp): {
  name: string;
  apply: 'build';
  configResolved(config: { isProduction: boolean; env: Env }): void;
};
export function viteEnv(dir: string, mode?: string, processEnv?: Record<string, string | undefined>): Record<string, string>;
