// Generic, idempotent importer of an evaluation definition through the NORMAL evaluations API (same `call` contract as the other provisioners:
// HTTP with the caller's session, or the in-process services transport as a named actor). Every authorization rule, validation, version and audit
// entry of the acting account applies. Nothing here is specific to an exam.
//
// definition = {
//   key (stable, lowercase), kind, title, description?, settings (the evaluation settings object),
//   sections: [{ title, description?, passage?: { title, body: Block[] }, questions: [{ prompt: Block[], category?, points?, options: string[], correct: "A".."L", explanation?: Block[] }] }],
//   assignments?: [{ role | groupId | userId, opensAt?, closesAt? }], publish?: boolean
// }
// Idempotent by `key` within the organization: if an evaluation with that key exists NOTHING is changed (the content belongs to its editors from then
// on; use Exam Builder or the API to evolve it). If the import fails midway the unpublished draft it created is removed, so a retry starts clean.

const letterIndex = (letter) => letter.charCodeAt(0) - 65;

export async function importEvaluation(call, organizationSlug, definition, log = () => {}) {
  const organization = (await call("GET", "/organizations")).json.find((item) => item.slug === organizationSlug);
  if (!organization) throw new Error(`Organization "${organizationSlug}" not found for this session`);
  const base = `/organizations/${organization.id}/evaluations`;
  const existing = (await call("GET", base)).json.find((item) => item.key === definition.key);
  if (existing) { log(`evaluation ${definition.key} already exists (${existing.status}); nothing changed`); return { organizationId: organization.id, evaluationId: existing.id, created: false, status: existing.status }; }

  const created = (await call("POST", base, { key: definition.key, kind: definition.kind, title: definition.title, description: definition.description ?? null })).json;
  const id = created.id;
  try {
    let revision = (await call("PATCH", `${base}/${id}`, { settings: definition.settings, expectedRevision: created.draftRevision })).json.draftRevision;
    const op = async (method, path, body) => { const result = (await call(method, `${base}/${id}${path}`, { ...body, expectedRevision: revision })).json; revision = result.draftRevision; return result; };
    const order = []; // [questionDefinition] in the order they were added
    for (const section of definition.sections) {
      const sectionId = (await op("POST", "/sections", { title: section.title, ...(section.description ? { description: section.description } : {}) })).id;
      const passageId = section.passage ? (await op("POST", "/passages", { title: section.passage.title, body: section.passage.body })).id : null;
      for (const question of section.questions) {
        await op("POST", "/questions", { sectionId, passageId, category: question.category ?? null, prompt: question.prompt, points: question.points ?? 1, explanation: question.explanation ?? [], options: question.options.map((text) => ({ text })) });
        order.push(question);
      }
    }
    // The server generated the option ids: read them back and mark each correct option (an audited operation of its own).
    const draft = (await call("GET", `${base}/${id}`)).json;
    revision = draft.draftRevision;
    for (const [index, question] of order.entries()) {
      const stored = draft.content.questions[index];
      const option = stored.options[letterIndex(question.correct)];
      if (!option) throw new Error(`Question ${index + 1}: correct option ${question.correct} does not exist`);
      await call("PUT", `${base}/${id}/questions/${stored.id}/correct-option`, { optionId: option.id, expectedRevision: revision }).then((result) => { revision = result.json.draftRevision; });
    }
    const report = (await call("POST", `${base}/${id}/validate`)).json;
    if (!report.valid) throw new Error(`The imported draft is not valid: ${report.issues.map((issue) => `${issue.path} ${issue.code}`).join(", ")}`);
    if (definition.assignments?.length) await call("PUT", `${base}/${id}/assignments`, { assignments: definition.assignments });
    let version = null;
    if (definition.publish) version = (await call("POST", `${base}/${id}/publish`)).json;
    log(`imported ${definition.key}: ${order.length} questions${version ? `, published v${version.version}` : " (draft)"}`);
    return { organizationId: organization.id, evaluationId: id, created: true, status: version ? "PUBLISHED" : "DRAFT", questions: order.length, version: version?.version ?? null };
  } catch (error) {
    // Never leave a half-imported draft behind (it could be mistaken for the real thing on the next run).
    await call("DELETE", `${base}/${id}`).catch(() => undefined);
    throw error;
  }
}
