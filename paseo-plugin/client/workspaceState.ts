import { z } from "zod";

export const workspaceTabSchema = z.object({ agentId: z.string().nullable(), outline: z.json() });
export const defaultWorkspaceState: z.infer<typeof workspaceTabSchema> = { agentId: null, outline: {} };

export function selectWorkspaceAgent(agentId: string | null): z.infer<typeof workspaceTabSchema> {
  return { agentId, outline: {} };
}
