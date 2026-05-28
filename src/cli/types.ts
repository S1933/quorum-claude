import type { QuorumConfig } from '../config/schema.ts';
import type { InitConfigOptions, InitConfigResult } from '../config/init.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { createRuntime as createRuntimeDefault } from '../runtime/runtime.ts';
import type { WorkspaceInfo } from '../core/task.ts';
import type { WriteStreamLike } from '../ui/terminal.ts';
import type { SelectChoice } from '../ui/select.ts';

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
  createInitConfig(opts: InitConfigOptions): Promise<InitConfigResult>;
  inferRepoRoot(start?: string): Promise<string>;
  probeWorkspace(opts: { root: string; baseRef?: string }): Promise<WorkspaceInfo>;
  createRuntime(opts: Parameters<typeof createRuntimeDefault>[0]): Promise<Runtime>;
  isInteractive(): boolean;
  prompt(question: string, io: CliIo): Promise<string>;
  selectMany(
    question: string,
    choices: SelectChoice[],
    defaults: string[],
    io: CliIo,
  ): Promise<string[]>;
  now(): number;
}
