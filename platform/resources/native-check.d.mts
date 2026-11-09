export interface ToolchainLock {
  version: 1; node: string; npm: string; python: string; pythonRequirements: string;
  minimumFreeBytes: number; packages: Record<string, string>; sha256: string; requirementsSha256: string;
}
export interface ProgramPin { path: string; sha256: string; version: string }
export function fail(code: string, message: string): never;
export function absolute(path: unknown): string;
export function isolatedPythonArgs(cacheRoot: string, args: string[]): string[];
export function contains(parent: string, path: string): boolean;
export function readJson(path: string, limit?: number): Record<string, any>;
export function sha256File(path: string): string;
export function readToolchain(codeRoot: string): ToolchainLock;
export function assertNodeVersion(codeRoot: string): ToolchainLock;
export function inspectProgram(path: string): { path: string; canonical: string; sha256: string; identity: string };
export function nativeEnvironment(systemRoot?: string): NodeJS.ProcessEnv;
export function checkPython(codeRoot: string, pythonPath: string, systemRoot?: string): ProgramPin & { packages: Record<string, string> };
export function checkNpm(codeRoot: string, npmCli: string, systemRoot?: string): ProgramPin;
export function checkNodeDependencies(codeRoot: string): { lockSha256: string; checked: number; optionalMissing: number };
