// @ts-check
// The hydrate action (POST …/actions {type:'hydrate'}). Placeholder (Epic S); Epic B owns this file.

/** @param {{ res: any, body: any, json: Function, bad: (error: string) => any }} c */
export async function hydrateAction(c) {
  const { res, body, json, bad } = c;
  if (!Array.isArray(body.nodeIds) && !body.all) return bad('give nodeIds or all');
  return json(res, 501, { ok: false, error: 'hydrate is not built yet' });
}
