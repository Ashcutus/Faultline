import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { renderExport } from './export.js';

const stores: Store[] = [];
function createStore() { const s = new Store(':memory:'); stores.push(s); return s; }
afterEach(() => { for (const s of stores.splice(0)) s.db.close(); });

describe('saved investigations', () => {
  it('reopens a database with identical source bytes and backfills an older assessment format', () => {
    const directory = mkdtempSync(join(tmpdir(), 'faultline-store-'));
    const path = join(directory, 'faultline.db');
    let store: Store | undefined;
    try {
      store = new Store(path);
      const incident = store.createIncident('Persistent incident', 'Reported failure', []);
      const bytes = Buffer.from([0x00, 0xff, 0x45, 0x52, 0x52, 0x0a]);
      const evidence = store.importEvidence(incident, bytes, 'binary fixture', 'application/octet-stream');
      const original = store.getEvidence(evidence.evidenceId);
      const oldAssessment = store.getIncident(incident).assessment;
      const legacy = JSON.parse(String(oldAssessment.value_json)) as Record<string, unknown>;
      delete legacy.recommendation;
      store.db.prepare('UPDATE assessments SET value_json=? WHERE id=?').run(JSON.stringify(legacy), oldAssessment.id);
      store.db.close();
      store = new Store(path);
      expect(store.getEvidence(evidence.evidenceId).bytes.equals(bytes)).toBe(true);
      expect(store.getEvidence(evidence.evidenceId).sha256).toBe(original.sha256);
      expect(store.getIncident(incident).timeline.at(-1)?.type).toBe('ASSESSMENT_SCHEMA_UPDATED');
      expect(store.recommendation(incident)?.action).toMatch(/baseline attempt/);
      expect(JSON.parse(String(store.db.prepare('SELECT value_json FROM assessments WHERE id=?').get(oldAssessment.id)?.value_json)).recommendation).toBeUndefined();
    } finally {
      store?.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves source bytes, span links, and an append-only timeline', () => {
    const store = createStore();
    const incident = store.createIncident('GPU failure', 'The desktop disappeared', []);
    const bytes = Buffer.from('MetroExodus.exe AMDGPU GPUVM page fault PERMISSION_FAULTS=3\n');
    const result = store.importEvidence(incident, bytes, 'test log', 'text/plain');
    const source = store.getEvidence(result.evidenceId);
    expect(source.bytes.equals(bytes)).toBe(true);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => store.db.prepare('UPDATE evidence SET bytes=? WHERE id=?').run(Buffer.from('tampered'), result.evidenceId)).toThrow(/immutable/);
    const current = store.getIncident(incident);
    expect(current.observations.length).toBeGreaterThan(0);
    const first = current.observations[0];
    expect(bytes.toString().slice(first.span_start, first.span_end)).toMatch(/AMDGPU|GPUVM/);
    expect(current.timeline.map(x => x.type)).toEqual(['INCIDENT_CREATED', 'EVIDENCE_IMPORTED']);
    expect(() => store.db.prepare('DELETE FROM timeline WHERE incident_id=?').run(incident)).toThrow(/append only/);
  });

  it('invalidates an inference when its observation is retracted but preserves old assessments', () => {
    const store = createStore();
    const incident = store.createIncident('Port conflict', 'Server did not start', []);
    store.importEvidence(incident, Buffer.from('EADDRINUSE port 3000'), 'terminal', 'text/plain');
    const obs = store.getIncident(incident).observations[0];
    store.addInference(incident, 'Port conflict is plausible', [obs.id], 'The owner is not yet known.');
    const before = store.getIncident(incident).assessment;
    store.retractObservation(incident, obs.id, 'Record belonged to another run.');
    const after = store.getIncident(incident);
    expect(after.inferences[0].retracted).toBe(1);
    expect(store.db.prepare('SELECT value_json FROM assessments WHERE id=?').get(before.id)).toMatchObject({ value_json: expect.stringContaining('Port conflict is plausible') });
    expect(String(after.assessment.value_json)).not.toContain('Port conflict is plausible');
  });

  it('walks the Metro attempts through real comparisons and a non-causal conclusion', () => {
    const store = createStore();
    const incident = store.createIncident('Metro failure with GPU reset', 'Desktop restarted while playing', []);
    const baseline = { protonVersion: { value: 'Experimental', source: 'user' as const }, graphicsSetting: { value: 'On', source: 'user' as const }, workload: { value: 'Same scene', source: 'user' as const } };
    const protocol = { workload: 'Same scene', plannedMinutes: 10, relevant: Object.keys(baseline), target: 'GPUVM fault' };
    const a1 = store.addAttempt(incident, null, protocol, baseline, 'TARGET_FAILURE_OBSERVED', 10, true);
    store.importEvidence(incident, Buffer.from('MetroExodus.exe vkd3d_queue AMDGPU GPUVM page fault PERMISSION_FAULTS=3'), 'attempt 1', 'text/plain', a1.attemptId);
    const a2 = store.addAttempt(incident, a1.attemptId, protocol, baseline, 'TARGET_FAILURE_OBSERVED', 10, true);
    store.importEvidence(incident, Buffer.from('MetroExodus.exe vkd3d_queue AMDGPU GPUVM page fault PERMISSION_FAULTS=3'), 'attempt 2', 'text/plain', a2.attemptId);
    const a3 = store.addAttempt(incident, a1.attemptId, protocol, { ...baseline, protonVersion: { value: '9', source: 'user' as const } }, 'TARGET_FAILURE_OBSERVED', 10, true);
    store.importEvidence(incident, Buffer.from('MetroExodus.exe vkd3d_queue AMDGPU GPUVM page fault PERMISSION_FAULTS=3'), 'attempt 3', 'text/plain', a3.attemptId);
    expect(a2.classification).toBe('REPRODUCTION_ATTEMPT');
    expect(a3.classification).toBe('CONTROLLED_TEST');
    const comparisons = store.getIncident(incident).comparisons.map(row => JSON.parse(String(row.value_json)));
    expect(comparisons).toHaveLength(2);
    expect(comparisons.every(c => c.result === 'STRONG_MATCH')).toBe(true);
    const report = renderExport(store, incident);
    expect(report).toContain('root cause not proven');
    expect(report).toContain('do not establish causation');
  });

  it('keeps a Windows rollback result scoped and allows closure without proven cause', () => {
    const store = createStore();
    const incident = store.createIncident('Game crash', 'User reports crashes since driver update', []);
    const protocol = { workload: 'Same save', plannedMinutes: 60, relevant: ['driver', 'workload'], target: 'access violation' };
    const baseline = { driver: { value: 'new', source: 'user' as const }, workload: { value: 'Same save', source: 'user' as const } };
    const first = store.addAttempt(incident, null, protocol, baseline, 'TARGET_FAILURE_OBSERVED', 60, true);
    store.importEvidence(incident, Buffer.from('Game.exe nvwgf2umx.dll 0xc0000005'), 'WER', 'text/plain', first.attemptId);
    const rollback = store.addAttempt(incident, first.attemptId, protocol, { ...baseline, driver: { value: 'old', source: 'user' as const } }, 'TARGET_NOT_OBSERVED', 60, true);
    expect(rollback.classification).toBe('CONTROLLED_TEST');
    const h = store.addHypothesis(incident, 'The newer driver package is involved', 'Failure under new driver', 'No failure under old driver');
    store.assessHypothesis(incident, h, 'SUPPORTED', 'One comparable post-rollback run did not show the target failure.', [first.attemptId, rollback.attemptId]);
    expect(store.getIncident(incident).hypotheses[0].status).toBe('SUPPORTED');
    store.resolve(incident, 'WORKAROUND_FOUND', 'SUPPORTED', 'Rollback avoided failure in one comparable run; internal cause unproven.');
    expect(store.getIncident(incident).incident.status).toBe('CLOSED');
    expect(() => store.resolve(incident, 'ROOT_CAUSE_IDENTIFIED', 'SUPPORTED', 'Not established')).toThrow();
  });

  it('builds the Next.js port-conflict scenario from error and listener evidence', () => {
    const store = createStore();
    const incident = store.createIncident('Next.js dev server will not start', 'The development server reports that port 3000 is already in use.', []);
    const bind = store.importEvidence(incident, Buffer.from('Error: listen EADDRINUSE: address already in use :::3000\n'), 'next-dev stderr', 'text/plain');
    const listener = store.importEvidence(incident, Buffer.from('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 412 ash 23u IPv6 12345 0t0 TCP *:3000 (LISTEN)\n'), 'lsof -nP -iTCP:3000 -sTCP:LISTEN', 'text/plain');
    const observations = store.getIncident(incident).observations.filter(o => !o.retracted);
    expect(bind.signature?.family).toBe('bind');
    expect(observations.map(o => o.predicate)).toEqual(expect.arrayContaining(['bind_error_reported', 'port_named', 'listener_reported']));
    const supported = observations.filter(o => o.evidence_id === listener.evidenceId || o.evidence_id === bind.evidenceId).map(o => o.id);
    store.addInference(incident, 'A contemporaneous Node listener is a plausible explanation for the port conflict.', supported, 'The listener owner and intended service still need confirmation.');
    const report = renderExport(store, incident);
    expect(report).toContain('EADDRINUSE');
    expect(report).toContain('listener');
    expect(report).not.toContain('reinstall Node');
    expect(report).not.toContain('delete node_modules');
  });

  it('never lets a source event import become a duplicate occurrence on refresh', () => {
    const store = createStore();
    const raw = Buffer.from('{"MESSAGE":"AMDGPU GPUVM page fault","__CURSOR":"cursor-1"}\n');
    expect(store.addDiscoveredEvent('journal:cursor-1:GPU_FAULT', 'GPU_FAULT', '2026-09-28T20:00:00Z', 'boot', null, null, 'amdgpu', 'GPUVM', raw)).toBe(true);
    expect(store.addDiscoveredEvent('journal:cursor-1:GPU_FAULT', 'GPU_FAULT', '2026-09-28T20:00:00Z', 'boot', null, null, 'amdgpu', 'GPUVM', raw)).toBe(false);
    expect(store.recent().events).toHaveLength(1);
  });

  it('reports cross-process recurrence as a family without claiming one cause', () => {
    const store = createStore();
    const first = Buffer.from('{"MESSAGE":"MetroExodus.exe AMDGPU GPUVM page fault PERMISSION_FAULTS=3"}\n');
    const second = Buffer.from('{"MESSAGE":"OtherGame.exe AMDGPU GPUVM page fault PERMISSION_FAULTS=3"}\n');
    store.addDiscoveredEvent('j1', 'GPU_FAULT', '2026-09-12T20:00:00Z', 'boot-a', 'MetroExodus.exe', 'card0', 'amdgpu', 'Fault 1', first);
    store.addDiscoveredEvent('j2', 'GPU_FAULT', '2026-09-28T20:00:00Z', 'boot-b', 'OtherGame.exe', 'card0', 'amdgpu', 'Fault 2', second);
    const incident = store.createIncident('GPU faults', 'Two games affected', (store.recent().events as { id: string }[]).map(e => e.id));
    const recurrence = store.recurrence(incident).find(x => x.family === 'gpuvm');
    expect(recurrence?.recordedEpisodes).toBe(2);
    expect(recurrence?.processes).toEqual({ 'metroexodus.exe': 1, 'othergame.exe': 1 });
    expect(recurrence?.note).toContain('not a failure rate or a proven shared cause');
  });

  it('uses a process-scoped ignore rule without deleting detected evidence', () => {
    const store = createStore();
    const raw = Buffer.from('{"MESSAGE":"MetroExodus.exe AMDGPU GPUVM page fault"}\n');
    store.addDiscoveredEvent('j1', 'GPU_FAULT', '2026-09-28T20:00:00Z', 'boot', 'MetroExodus.exe', null, 'amdgpu', 'Fault', raw);
    const event = (store.recent().events as { id: string }[])[0];
    const rule = store.addIgnoreRule(event.id);
    store.addDiscoveredEvent('j2', 'GPU_FAULT', '2026-09-28T21:00:00Z', 'boot', 'MetroExodus.exe', null, 'amdgpu', 'Fault again', raw);
    store.addDiscoveredEvent('j3', 'GPU_FAULT', '2026-09-28T21:00:00Z', 'boot', 'OtherGame.exe', null, 'amdgpu', 'Other fault', raw);
    const recent = store.recent().events as { process: string; disposition: string }[];
    expect(recent.filter(e => e.process === 'MetroExodus.exe').every(e => e.disposition === 'IGNORED')).toBe(true);
    expect(recent.find(e => e.process === 'OtherGame.exe')?.disposition).toBe('NEW');
    store.disableIgnoreRule(rule.id);
    expect((store.recent().events as { disposition: string }[]).every(e => e.disposition === 'NEW')).toBe(true);
  });

  it('purges a reviewed incident without leaving mutable evidence or a broken schema', () => {
    const store = createStore();
    const first = store.createIncident('First incident', 'User symptom', []);
    const evidence = store.importEvidence(first, Buffer.from('EADDRINUSE port 3000'), 'manual', 'text/plain');
    expect(() => store.purgeIncident(first, 'wrong title', 'cleanup')).toThrow(/does not match/);
    expect(store.getEvidence(evidence.evidenceId).bytes.toString()).toBe('EADDRINUSE port 3000');
    expect(store.purgeIncident(first, 'First incident', 'reviewed cleanup').evidenceBlobsRemoved).toBe(1);
    expect(() => store.getIncident(first)).toThrow(/not found/);
    expect(() => store.getEvidence(evidence.evidenceId)).toThrow(/not found/);
    const second = store.createIncident('Second incident', 'Another symptom', []);
    const next = store.importEvidence(second, Buffer.from('SIGSEGV'), 'manual', 'text/plain');
    expect(() => store.db.prepare('DELETE FROM evidence WHERE id=?').run(next.evidenceId)).toThrow(/immutable/);
  });
});
