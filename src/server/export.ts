import { Store } from './store.js';
import { redact, safeMarkdown } from '../core/investigation.js';

export function renderExport(store: Store, incidentId: string, privateExport = false) {
  const data = store.getIncident(incidentId);
  const clean = (value: unknown) => safeMarkdown(privateExport ? String(value ?? '') : redact(String(value ?? '')).text);
  const lines: string[] = [`# ${clean(data.incident.title)}`, '', '## Problem', '', clean(data.incident.symptom), '', '## Environment', ''];
  for (const a of data.attempts as Record<string, unknown>[]) {
    const env = JSON.parse(String(a.environment_json)) as Record<string, { value: string | null; source: string }>;
    lines.push(`- Attempt ${clean(a.id)}: ${Object.entries(env).map(([k, v]) => `${clean(k)}=${clean(v.value ?? 'unknown')} (${clean(v.source)})`).join('; ') || 'Not recorded'}`);
  }
  lines.push('', '## Timeline', '');
  for (const e of data.timeline as Record<string, unknown>[]) lines.push(`- ${clean(e.recorded_at)} — ${clean(e.type)}: ${clean(e.payload_json)}`);
  lines.push('', '## Evidence', '');
  for (const e of data.evidence as Record<string, unknown>[]) lines.push(`- ${clean(e.id)}: ${clean(e.source)}; SHA-256 ${clean(e.sha256)}; ${clean(e.completeness)}. Original bytes remain in the local store and are not embedded here.`);
  lines.push('', '## Observations', '');
  lines.push('### User assertions', '');
  for (const a of data.assertions as Record<string, unknown>[]) lines.push(`- User reports: ${clean(a.statement)} [${clean(a.id)}; scope: ${clean(a.scope)}]`);
  lines.push('', '### Evidence-backed observations', '');
  for (const o of data.observations as Record<string, unknown>[]) lines.push(`- ${clean(o.statement)} [${clean(o.id)}; evidence ${clean(o.evidence_id)}; span ${clean(o.span_start)}–${clean(o.span_end)}; ${clean(o.producer)}]${o.retracted ? ' (retracted)' : ''}`);
  lines.push('', '## Inferences', '');
  for (const i of data.inferences as Record<string, unknown>[]) lines.push(`- ${clean(i.statement)} [${clean(i.id)}; observation support ${clean(i.support_json)}; limits: ${clean(i.limitations)}]${i.retracted ? ' (retracted)' : ''}`);
  lines.push('', '## Test Attempts and Variable Changes', '');
  for (const a of data.attempts as Record<string, unknown>[]) lines.push(`- ${clean(a.id)}: baseline ${clean(a.baseline_id ?? 'none')}; outcome ${clean(a.outcome)}; ${clean(a.classification)}; exposure ${clean(a.exposure_minutes)} minutes; coverage ${a.coverage ? 'reported adequate' : 'incomplete'}; differences ${clean(a.differences_json)}${a.qa_violation ? '; QA violation: multiple variables' : ''}`);
  lines.push('', '## Failure Signature Comparison', '');
  for (const c of data.comparisons as Record<string, unknown>[]) lines.push(`- ${clean(c.left_signature_id)} vs ${clean(c.right_signature_id)}: ${clean(c.value_json)}`);
  lines.push('', '## Hypotheses', '');
  for (const h of data.hypotheses as Record<string, unknown>[]) lines.push(`- ${clean(h.proposition)} — ${clean(h.status)}. Prediction: ${clean(h.prediction)}. Assessment: ${clean(h.assessment_reason)}`);
  const assessment = data.assessment as Record<string, unknown> | undefined;
  const value = assessment ? JSON.parse(String(assessment.value_json)) as { observations?: { id: string; statement: string }[]; inferences?: { id: string; statement: string; limitations: string }[]; hypotheses?: { id: string; proposition: string; status: string }[]; unknowns?: string[]; nextTest?: string; doNotYet?: string[] } : {};
  lines.push('', '## Current Assessment', '', `Assessment revision: ${clean(assessment?.revision ?? 'none')}.`, '', `Symptom (user report): ${clean(data.incident.symptom)}`, '', '**Observed**');
  for (const o of value.observations ?? []) lines.push(`- ${clean(o.statement)} [${clean(o.id)}]`);
  if (!value.observations?.length) lines.push('- No supported observations yet.');
  lines.push('', '**Inferred**');
  for (const i of value.inferences ?? []) lines.push(`- ${clean(i.statement)} [${clean(i.id)}]; limitation: ${clean(i.limitations)}`);
  if (!value.inferences?.length) lines.push('- No active inference.');
  lines.push('', '**Hypotheses**');
  for (const h of value.hypotheses ?? []) lines.push(`- ${clean(h.proposition)} — ${clean(h.status)} [${clean(h.id)}]`);
  if (!value.hypotheses?.length) lines.push('- No active hypothesis.');
  lines.push('', '## Resolution', '');
  const resolution = (data.resolutions as Record<string, unknown>[]).at(-1);
  lines.push(resolution ? `${clean(resolution.outcome)}; root cause ${clean(resolution.root_cause_status)}. ${clean(resolution.summary)}` : 'Open; root cause not proven.');
  lines.push('', '## Remaining Unknowns', '');
  for (const unknown of value.unknowns ?? []) lines.push(`- ${clean(unknown)}`);
  lines.push('', '## Recommended Next Action', '', value.nextTest ? clean(value.nextTest) : 'Review missing evidence and choose a narrow, reversible test.', '', '## Do Not Yet', '');
  for (const action of value.doNotYet ?? []) lines.push(`- ${clean(action)}`);
  lines.push('', '> Pattern matches and nearby events do not establish causation. This export is a report, not a complete backup.', '');
  return lines.join('\n');
}
