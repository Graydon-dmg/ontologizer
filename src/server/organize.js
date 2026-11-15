// @ts-check
// POST /v1/t/{tenant}/maps/organize: organise a supplied list of items into a map. Placeholder (Epic S);
// Epic A owns this file. The gates before it (auth, scope, limits, body size, queue, store) are the router's.

/**
 * @param {{ req: any, res: any, body: any, tenant: string, principal: any, actor: any, store: any,
 *   startRun: (tenant: string, draftId: string, kind: string, work: (engine: any) => any, opts?: { timeoutMs?: number }) => void,
 *   engineFor: (tenant: string, id: string) => Promise<any>, durable: (store: any) => Promise<void>,
 *   json: Function, fail: (res: any, status: number, error: string, headers?: Record<string, string>) => any }} c
 */
export async function organizeRoute(c) {
  const { res, body, fail } = c;
  if (!body || typeof body.name !== 'string' || !body.name || !Array.isArray(body.items)) return fail(res, 400, 'give name and items');
  return fail(res, 501, 'organize_map is not built yet');
}
