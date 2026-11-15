// @ts-check
// The add_node action (POST …/actions {type:'add_node'}). Placeholder (Epic S); Epic C owns this file.

/** @param {{ res: any, body: any, json: Function, bad: (error: string) => any }} c */
export async function addNodeAction(c) {
  const { res, body, json, bad } = c;
  const given = (/** @type {any} */ v) => typeof v === 'string' && v.length > 0;
  if (!given(body.parentId) || !given(body.label)) return bad('give parentId and label');
  return json(res, 501, { ok: false, error: 'add_node is not built yet' });
}
