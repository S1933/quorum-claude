import type { QuorumConfig } from '../config/schema.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { createRuntime as createRuntimeDefault } from '../runtime/runtime.ts';
import type { WorkspaceInfo } from '../core/task.ts';
import type { WriteStreamLike } from '../ui/terminal.ts';

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface CliIo {
  stdout: WriteStreamLike;
  stderr: WriteStreamLike;
}

export interface CliDeps {
  loadConfigFromPath(path: string): Promise<QuorumConfig>;
  findConfigPath(cwd?: string): string;
  inferRepoRoot(start?: string): Promise<string>;
  probeWorkspace(opts: { root: string; baseRef?: string }): Promise<WorkspaceInfo>;
  createRuntime(opts: Parameters<typeof createRuntimeDefault>[0]): Promise<Runtime>;
  now(): number;
  initConfigIfMissing?(configPath: string, examplePath: string): Promise<boolean>;
  readConfigFile?(configPath: string): Promise<string>;
  writeConfigFile?(configPath: string, content: string): Promise<void>;
}
