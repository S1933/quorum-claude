export interface PluginCtx {
  workspaceRoot: string;
  env: Record<string, string | undefined>;
}

export function defaultPluginCtx(workspaceRoot: string = process.cwd()): PluginCtx {
  return {
    workspaceRoot,
    env: { ...process.env },
  };
}
