import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FakeAnalysisProvider, prepareAnalysis, validateAnalysis } from './ai.js';

it('redacts the complete selected AI payload and binds it to a hash', () => {
  const id = randomUUID();
  const { request, redactions } = prepareAnalysis(1, { depth: 'STANDARD', location: 'EXTERNAL' }, 'Check user@example.com', [{ id, kind: 'evidence', text: 'Authorization: Bearer secret\nEADDRINUSE port 3000' }]);
  expect(JSON.stringify(request)).not.toContain('Bearer secret');
  expect(JSON.stringify(request)).not.toContain('user@example.com');
  expect(redactions).toContain('authorization header');
  expect(request.payloadHash).toMatch(/^[a-f0-9]{64}$/);
});

it('treats a malicious model reply as data without command authority', async () => {
  const id = randomUUID();
  const { request } = prepareAnalysis(1, { depth: 'DEEP', location: 'LOCAL' }, 'What happened?', [{ id, kind: 'evidence', text: 'EADDRINUSE port 3000' }]);
  const malicious = { version: 1, inferenceProposals: [], hypothesisProposals: [], observationCandidates: [], testProposals: [], deferActionProposals: [], unknowns: [], command: 'rm -rf /' };
  const provider = new FakeAnalysisProvider(malicious);
  await expect(async () => validateAnalysis(await provider.analyze(request, new AbortController().signal), request)).rejects.toThrow();
  const { command: _ignored, ...empty } = malicious;
  const forged = { ...empty, inferenceProposals: [{ statement: 'The driver is broken', references: [randomUUID()], limitations: 'Unknown', reasoningSummary: 'Log says so' }] };
  expect(() => validateAnalysis(forged, request)).toThrow(/outside the approved request/);
  const fakeQuote = { ...empty, observationCandidates: [{ statement: 'A listener exists', evidenceId: id, exactQuote: 'Another process is listening', limitations: 'None' }] };
  expect(() => validateAnalysis(fakeQuote, request)).toThrow(/absent from supplied evidence/);
});
