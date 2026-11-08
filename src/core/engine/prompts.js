// @ts-check
// Every prompt the engine sends. Each states its output format exactly, says "one JSON object per
// line, nothing else", and gives one example line. Prompts return { system, prompt }.

const LINES = 'Output one JSON object per line, nothing else: no prose, no headings, no code fences, no arrays.';

/** @param {any} brief */
function briefText(brief) {
  return [
    `Context (the reader's own words): ${brief.context}`,
    `Subject: ${brief.subject}`,
    `Scope: ${brief.scope}`,
    `Purpose: ${brief.purpose}`,
    `Reader level: ${brief.level}`,
  ].join('\n');
}

const MAPPER = `You build ontologies: maps of everything inside a topic, as a tree of concepts with short, vivid descriptions.
Write for the reader described in the brief, at their level. Labels are short noun phrases in Title Case (1 to 4 words), specific to this subject, never generic ("Overview", "Other", "Misc", "Basics").
summary: one plain sentence saying what the thing is (at most 20 words).
hook: one surprising, concrete fact or angle that makes the reader want to click (at most 20 words).`;

// ---------------------------------------------------------------------------------------------
// The context check

/**
 * @param {string} context
 * @param {{ id: string, question?: string, answer: string }[]} answers
 */
export function checkPrompt(context, answers) {
  const system = `You decide whether a reader's request is clear enough to build a topic map from, before any work starts.
Apply four tests to the context plus any answers already given:
1. subject: it names one subject with one meaning (not an ambiguous word like "modeling", which could be plastic scale models, fashion, 3D, data or math).
2. scope: the subject fans out into roughly 6 to 12 meaningful branches (not so narrow it has three facts, not so broad it is "science").
3. purpose: you can tell why the reader wants it (getting started, a decision, teaching, curiosity, work).
4. level: you can tell if the reader is a beginner, intermediate or expert.
Be practical: infer what is reasonably implied. If a test is only weakly implied, pick the most likely reading and pass it.
If all four pass, output:
{"ready":true,"brief":{"context":"<the reader's context, verbatim>","subject":"<one clear subject>","scope":"<what is in and out>","purpose":"<why>","level":"beginner|intermediate|expert"},"name":"<short-kebab-case-name>"}
If any test fails, output at most 3 questions, only for the tests that fail, each with 2 to 5 short answer options:
{"ready":false,"questions":[{"id":"subject","text":"Which kind of modeling do you mean?","options":["Plastic scale models","Fashion modeling","3D modeling","Data modeling"]}]}
Question ids are the test names: subject, scope, purpose, level.
name: 1 to 4 lowercase words joined by hyphens, naming the subject, e.g. "plastic-modeling".
Output exactly one JSON object on one line, nothing else: no prose, no code fences.`;
  const answered = answers.length
    ? '\n\nAnswers already given:\n' + answers.map((a) => `- ${a.question ?? a.id}: ${a.answer}`).join('\n')
    : '';
  return { system, prompt: `Context: ${context}${answered}` };
}

// ---------------------------------------------------------------------------------------------
// Build waves

/** Wave 0: the categories. @param {any} brief */
export function wave0Prompt(brief) {
  const system = `${MAPPER}
Task: list the top-level categories of the subject: 6 to 10 categories that together cover it for this reader, with little overlap. Order them as a newcomer would meet them.
${LINES}
Each line: {"label":"…","summary":"…","hook":"…"}
Example line: {"label":"Tools","summary":"The hand tools that cut, clean, join and finish plastic parts.","hook":"A good hobby knife does more for a first kit than an airbrush."}`;
  return { system, prompt: briefText(brief) };
}

/**
 * Wave 1: one category's children (and grandchildren when depth > 2).
 * @param {any} brief @param {string} category @param {string[]} allCategories @param {number} depth
 */
export function wave1Prompt(brief, category, allCategories, depth) {
  const deeper = depth > 2
    ? `Then, for the 3 or 4 most important of those children, add 2 to 4 children each, with "parent" set to that child's label.`
    : `Do not go deeper than one level.`;
  const system = `${MAPPER}
Task: list the children of one category: 5 to 8 concepts inside it, specific and concrete, each one a thing a reader could click to learn more. Stay inside this category; the other categories cover the rest.
${deeper}
${LINES}
Each line: {"label":"…","parent":"<the category label, or a child label you already wrote>","summary":"…","hook":"…"}
Example line: {"label":"Adhesives","parent":"Tools","summary":"Glues that bond styrene parts.","hook":"Plastic cement does not glue: it melts both faces into one."}`;
  const prompt = `${briefText(brief)}

All categories: ${allCategories.join(', ')}
The category to expand: ${category}`;
  return { system, prompt };
}

/**
 * Wave 2: cross-links over the built tree, then insights.
 * @param {any} brief @param {string[]} paths  every node as a label path, "Tools > Adhesives"
 */
export function wave2Prompt(brief, paths) {
  const system = `You find the hidden connections in a topic map.
Task: given every node of the map as a label path, find 10 to 25 cross-links between nodes in DIFFERENT branches that a reader would find illuminating. Never link a node to its own parent or child.
type is one of: influences, requires, part-of, bridge, analog.
why: one plain sentence (at most 20 words).
from and to: copy a label path from the list exactly.
After the links, write 1 to 3 insights: short observations about the shape of the whole field that only show up once it is mapped (at most 30 words each), each about one node.
${LINES}
Link lines: {"from":"<label path>","to":"<label path>","type":"influences","why":"…"}
Insight lines: {"insight":"…","about":"<label path>"}
Example line: {"from":"Tools > Adhesives > Plastic Cement","to":"Techniques > Seam Filling","type":"influences","why":"Cement that melts the plastic leaves seams that need far less filling."}`;
  const prompt = `${briefText(brief)}

The map:
${paths.join('\n')}`;
  return { system, prompt };
}

// ---------------------------------------------------------------------------------------------
// Jobs

/**
 * Research in context: the brief plus the node's full label path.
 * @param {any} brief @param {string[]} labelPath  root first, the researched node last
 * @param {string[]} existing  labels already under the node
 */
export function researchContextPrompt(brief, labelPath, existing) {
  const node = labelPath[labelPath.length - 1];
  const system = `${MAPPER}
Task: research one node of this map further, for this reader and this purpose. List 4 to 8 new concepts that belong directly under it, specific to the subject as the brief frames it. Do not repeat what is already there.
${LINES}
Each line: {"label":"…","summary":"…","hook":"…"}
Example line: {"label":"Plastic Cement","summary":"A solvent that welds styrene by melting both surfaces.","hook":"The thin kind wicks into a joint by capillary action, so you apply it after the parts touch."}`;
  const prompt = `${briefText(brief)}

The node to research, as a path in the map: ${labelPath.join(' > ')}
Already under ${node}: ${existing.length ? existing.join(', ') : '(nothing yet)'}`;
  return { system, prompt };
}

/**
 * Research in general: only the node's own label, no brief. Deliberately broad.
 * @param {string} label @param {string[]} existing
 */
export function researchGeneralPrompt(label, existing) {
  const system = `${MAPPER}
Task: a reader has met a term and wants the general picture across every field it belongs to, not just one hobby or niche. List 4 to 8 concepts that sit directly under the term in general, as an encyclopedia or textbook would organise it. Do not repeat what is already listed.
${LINES}
Each line: {"label":"…","summary":"…","hook":"…"}
Example line: {"label":"Epoxies","summary":"Two-part resins that cure into strong, rigid bonds.","hook":"Aircraft are held together with them in places once riveted."}`;
  const prompt = `The term: ${label}
Already listed: ${existing.length ? existing.join(', ') : '(nothing yet)'}`;
  return { system, prompt };
}

/** Explain: a short article, grounded with web search. @param {any} brief @param {string[]} labelPath */
export function explainPrompt(brief, labelPath) {
  const system = `You write short, accurate explainer articles for one node of a topic map, for the reader described in the brief.
Search the web first (at most 3 searches) so the facts are current and checkable.
Then output exactly one JSON object on one line, nothing else: no prose before or after, no code fences.
{"summary":"<2 to 4 plain sentences>","keyFacts":["<3 to 6 short, concrete facts>"],"whyItMatters":"<1 or 2 sentences, for this reader's purpose>","seeAlso":["<2 to 4 labels of related concepts>"]}
Example line: {"summary":"Plastic cement is a solvent that softens styrene so two parts fuse into one.","keyFacts":["Thin cement wicks into a closed joint."],"whyItMatters":"It is the first glue a beginner needs.","seeAlso":["CA Glue","Seam Filling"]}`;
  const prompt = `${briefText(brief)}

Explain this node: ${labelPath.join(' > ')}`;
  return { system, prompt };
}

/** Sources: find good references with web search. @param {any} brief @param {string[]} labelPath */
export function sourcesPrompt(brief, labelPath) {
  const system = `You find the best sources on one node of a topic map, for the reader described in the brief.
Search the web (at most 3 searches). Choose 3 to 6 sources that are reliable and useful for this reader: guides, references, respected publications. No shops, no spam.
${LINES}
Each line: {"title":"…","url":"<a URL that appeared in your search results>"}
Example line: {"title":"Choosing Plastic Cement","url":"https://example.org/plastic-cement"}`;
  const prompt = `${briefText(brief)}

Find sources for: ${labelPath.join(' > ')}`;
  return { system, prompt };
}
