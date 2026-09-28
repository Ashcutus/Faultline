import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redact } from './investigation.js';

export type AnalysisDepth = 'STANDARD' | 'DEEP';
export type ExecutionLocation = 'LOCAL' | 'EXTERNAL' | 'UNVERIFIED';
export type AnalysisProfile = { depth: AnalysisDepth; location: ExecutionLocation };
export type AnalysisInput = { id: string; kind: 'evidence' | 'observation' | 'inference' | 'assertion' | 'hypothesis' | 'attempt'; text: string };
export type AnalysisRequest = { version: 1; incidentRevision: number; profile: AnalysisProfile; question: string; inputs: AnalysisInput[]; payloadHash: string };
export interface AnalysisProvider {
  readonly id: string;
  readonly location: ExecutionLocation;
  analyze(request: AnalysisRequest, signal: AbortSignal): Promise<unknown>;
}

const id = z.string().uuid();
const reference = z.array(id).min(1).max(30);
const statement = z.string().min(1).max(2000);
const inference = z.object({ statement, references: reference, limitations: statement, reasoningSummary: statement }).strict();
const hypothesis = z.object({ proposition: statement, prediction: statement, weakeningResult: statement, references: reference, limitations: statement }).strict();
const observationCandidate = z.object({ statement, evidenceId: id, exactQuote: statement, limitations: statement }).strict();
const test = z.object({ action: statement, why: statement, changes: statement, constants: statement, expectedInformation: statement, risk: statement, reversibility: statement, references: reference }).strict();
const deferAction = z.object({ action: statement, why: statement, reconsiderWhen: statement, references: reference }).strict();
const outputSchema = z.object({ version: z.literal(1), inferenceProposals: z.array(inference).max(20), hypothesisProposals: z.array(hypothesis).max(20), observationCandidates: z.array(observationCandidate).max(20), testProposals: z.array(test).max(20), deferActionProposals: z.array(deferAction).max(20), unknowns: z.array(statement).max(20) }).strict();
export type AnalysisOutput = z.infer<typeof outputSchema>;

export function prepareAnalysis(incidentRevision: number, profile: AnalysisProfile, question: string, inputs: AnalysisInput[]): { request: AnalysisRequest; redactions: string[] } {
  if (!Number.isInteger(incidentRevision) || incidentRevision < 1 || inputs.length > 100) throw new Error('Invalid analysis scope.');
  const categories = new Set<string>();
  const clean = (value: string) => { const result = redact(value); result.categories.forEach(x => categories.add(x)); return result.text; };
  const selected = inputs.map(input => ({ id: id.parse(input.id), kind: input.kind, text: clean(input.text).slice(0, 6000) }));
  const payload = { version: 1 as const, incidentRevision, profile, question: clean(question).slice(0, 2000), inputs: selected };
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { request: { ...payload, payloadHash }, redactions: [...categories] };
}

export function validateAnalysis(raw: unknown, request: AnalysisRequest): AnalysisOutput {
  const serialised = JSON.stringify(raw);
  if (!serialised || serialised.length > 100_000) throw new Error('AI output exceeds its limit.');
  const output = outputSchema.parse(raw);
  const allowed = new Set(request.inputs.map(i => i.id));
  const check = (refs: string[]) => { if (refs.some(ref => !allowed.has(ref))) throw new Error('AI response referenced evidence outside the approved request.'); };
  output.inferenceProposals.forEach(x => check(x.references));
  output.hypothesisProposals.forEach(x => check(x.references));
  output.testProposals.forEach(x => check(x.references));
  output.deferActionProposals.forEach(x => check(x.references));
  for (const x of output.observationCandidates) {
    const input = request.inputs.find(i => i.id === x.evidenceId && i.kind === 'evidence');
    if (!input || !input.text.includes(x.exactQuote)) throw new Error('AI observation quote is absent from supplied evidence.');
  }
  return output;
}

export class FakeAnalysisProvider implements AnalysisProvider {
  readonly id = 'fake-for-tests';
  readonly location: ExecutionLocation = 'LOCAL';
  constructor(private readonly reply: unknown) {}
  async analyze(_request: AnalysisRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error('Analysis cancelled.');
    return this.reply;
  }
}
