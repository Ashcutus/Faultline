import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { extract, compareEnvironment, compareSignatures, classifyOutcome, type Environment, type AttemptOutcome, type HypothesisStatus, type Signature } from '../core/investigation.js';

const id = () => randomUUID();
const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;
type Row = Record<string, unknown>;

export class Store {
  db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, captured_at TEXT NOT NULL, completeness TEXT NOT NULL, producer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, title TEXT NOT NULL, symptom TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_assertions(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), statement TEXT NOT NULL, scope TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incident_evidence(incident_id TEXT NOT NULL REFERENCES incidents(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), PRIMARY KEY(incident_id,evidence_id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, event_time TEXT, boot_id TEXT, process TEXT, device TEXT, subsystem TEXT, summary TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence(id), discovered_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_dispositions(id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ignore_rules(id TEXT PRIMARY KEY, kind TEXT NOT NULL, process TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incident_events(incident_id TEXT NOT NULL REFERENCES incidents(id), event_id TEXT NOT NULL REFERENCES events(id), PRIMARY KEY(incident_id,event_id));
      CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), predicate TEXT NOT NULL, statement TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, values_json TEXT NOT NULL, producer TEXT NOT NULL, created_at TEXT NOT NULL, supersedes TEXT, retracted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inferences(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), statement TEXT NOT NULL, support_json TEXT NOT NULL, limitations TEXT NOT NULL, producer TEXT NOT NULL, created_at TEXT NOT NULL, supersedes TEXT, retracted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS hypotheses(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), proposition TEXT NOT NULL, prediction TEXT NOT NULL, weakening_result TEXT NOT NULL, status TEXT NOT NULL, assessment_reason TEXT NOT NULL, created_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS hypothesis_assessments(id TEXT PRIMARY KEY, hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id), status TEXT NOT NULL, reason TEXT NOT NULL, support_json TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), baseline_id TEXT REFERENCES attempts(id), protocol_json TEXT NOT NULL, environment_json TEXT NOT NULL, outcome TEXT NOT NULL, exposure_minutes REAL NOT NULL, coverage INTEGER NOT NULL, classification TEXT NOT NULL, differences_json TEXT NOT NULL, qa_violation INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_evidence(attempt_id TEXT NOT NULL REFERENCES attempts(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), PRIMARY KEY(attempt_id,evidence_id));
      CREATE TABLE IF NOT EXISTS signatures(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), attempt_id TEXT REFERENCES attempts(id), evidence_id TEXT NOT NULL REFERENCES evidence(id), value_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), left_signature_id TEXT NOT NULL REFERENCES signatures(id), right_signature_id TEXT NOT NULL REFERENCES signatures(id), value_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS timeline(incident_id TEXT NOT NULL REFERENCES incidents(id), seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, actor TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(incident_id,seq));
      CREATE TABLE IF NOT EXISTS assessments(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), revision INTEGER NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(incident_id,revision));
      CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), outcome TEXT NOT NULL, root_cause_status TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, state TEXT NOT NULL, coverage_json TEXT NOT NULL, evidence_id TEXT REFERENCES evidence(id));
      CREATE TABLE IF NOT EXISTS purge_log(incident_id TEXT PRIMARY KEY, purged_at TEXT NOT NULL, reason TEXT NOT NULL, evidence_blobs_removed INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS timeline_no_update BEFORE UPDATE ON timeline BEGIN SELECT RAISE(ABORT,'timeline is append only'); END;
      CREATE TRIGGER IF NOT EXISTS timeline_no_delete BEFORE DELETE ON timeline BEGIN SELECT RAISE(ABORT,'timeline is append only'); END;
      CREATE INDEX IF NOT EXISTS ix_events_time ON events(event_time);
      CREATE INDEX IF NOT EXISTS ix_observations_incident ON observations(incident_id);
      CREATE INDEX IF NOT EXISTS ix_signatures_incident ON signatures(incident_id);
    `);
    const latest = this.db.prepare('SELECT a.incident_id,a.value_json FROM assessments a JOIN (SELECT incident_id,MAX(revision) AS revision FROM assessments GROUP BY incident_id) x ON x.incident_id=a.incident_id AND x.revision=a.revision').all() as Row[];
    for (const row of latest) {
      const value = parse<{ recommendation?: unknown }>(row.value_json);
      if (!value.recommendation) this.db.transaction(() => this.addTimeline(String(row.incident_id), 'ASSESSMENT_SCHEMA_UPDATED', { reason: 'Persist current recommendation fields.' }, 'migration:v1'))();
    }
  }

  private addTimeline(incidentId: string, type: string, payload: unknown, actor = 'user') {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM timeline WHERE incident_id=?').get(incidentId) as Row).seq;
    this.db.prepare('INSERT INTO timeline VALUES(?,?,?,?,?,?)').run(incidentId, seq, type, json(payload), actor, now());
    this.db.prepare('UPDATE incidents SET revision=revision+1 WHERE id=?').run(incidentId);
    this.snapshotAssessment(incidentId);
  }

  private snapshotAssessment(incidentId: string) {
    const incident = this.db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId) as Row;
    const observations = this.db.prepare('SELECT id,statement,evidence_id FROM observations WHERE incident_id=? AND retracted=0 ORDER BY created_at').all(incidentId);
    const inferences = this.db.prepare('SELECT id,statement,support_json,limitations FROM inferences WHERE incident_id=? AND retracted=0 ORDER BY created_at').all(incidentId);
    const hypotheses = this.db.prepare('SELECT id,proposition,status,assessment_reason FROM hypotheses WHERE incident_id=? AND retired=0 ORDER BY created_at').all(incidentId);
    const attempts = this.db.prepare('SELECT id,outcome,classification,qa_violation FROM attempts WHERE incident_id=? ORDER BY created_at').all(incidentId);
    const latestResolution = incident.status === 'CLOSED' ? this.db.prepare('SELECT outcome,root_cause_status,summary FROM resolutions WHERE incident_id=? ORDER BY created_at DESC LIMIT 1').get(incidentId) ?? null : null;
    const unknowns: string[] = [];
    if (!attempts.length) unknowns.push('Whether the failure reproduces under recorded conditions.');
    if (!this.db.prepare('SELECT 1 FROM signatures WHERE incident_id=? LIMIT 1').get(incidentId)) unknowns.push('A supported failure signature is not yet available.');
    const assertions = this.db.prepare('SELECT id,statement,scope FROM user_assertions WHERE incident_id=? ORDER BY created_at').all(incidentId);
    const recommendation = this.buildRecommendation(incidentId);
    const value = { incident: { id: incident.id, title: incident.title, symptom: incident.symptom, status: incident.status }, assertions, observations, inferences, hypotheses, attempts, unknowns, recommendation, nextTest: recommendation.action, doNotYet: recommendation.doNotYet, resolution: latestResolution, note: 'Pattern matches and nearby events do not establish causation.' };
    this.db.prepare('INSERT INTO assessments VALUES(?,?,?,?,?)').run(id(), incidentId, incident.revision, json(value), now());
  }

  private saveEvidence(bytes: Buffer, source: string, kind: string, completeness = 'COMPLETE_CAPTURE', producer = 'user'): string {
    if (bytes.length > 25 * 1024 * 1024) throw new Error('Evidence exceeds 25 MiB capture limit.');
    const used = Number((this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS used FROM evidence').get() as Row).used);
    if (used + bytes.length > 1024 * 1024 * 1024) throw new Error('The 1 GiB local evidence budget has been reached. Back up and purge unneeded investigations before collecting more.');
    const evidenceId = id(), hash = createHash('sha256').update(bytes).digest('hex');
    this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?)').run(evidenceId, hash, bytes, source, kind, now(), completeness, producer);
    return evidenceId;
  }

  importEvidence(incidentId: string, bytes: Buffer, source: string, kind: string, attemptId?: string) {
    return this.db.transaction(() => {
      this.requireIncident(incidentId);
      if (bytes.length > 10 * 1024 * 1024) throw new Error('Imports are limited to 10 MiB.');
      const evidenceId = this.saveEvidence(bytes, source, kind);
      this.db.prepare('INSERT INTO incident_evidence VALUES(?,?)').run(incidentId, evidenceId);
      if (attemptId) {
        const attempt = this.db.prepare('SELECT incident_id FROM attempts WHERE id=?').get(attemptId) as Row | undefined;
        if (!attempt || attempt.incident_id !== incidentId) throw new Error('Attempt does not belong to incident.');
        this.db.prepare('INSERT INTO attempt_evidence VALUES(?,?)').run(attemptId, evidenceId);
      }
      const derived = extract(bytes.toString('utf8'), evidenceId);
      for (const o of derived.observations) this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?,0)').run(id(), incidentId, evidenceId, o.predicate, o.statement, o.start, o.end, json(o.values), 'rule:v1', now(), null);
      if (derived.signature) this.db.prepare('INSERT INTO signatures VALUES(?,?,?,?,?,?)').run(id(), incidentId, attemptId ?? null, evidenceId, json(derived.signature), now());
      this.addTimeline(incidentId, 'EVIDENCE_IMPORTED', { evidenceId, source, observations: derived.observations.length, signature: derived.signature?.family ?? null });
      if (attemptId && derived.signature) this.compareLatestAttemptSignatures(incidentId, attemptId);
      return { evidenceId, observations: derived.observations.length, signature: derived.signature };
    })();
  }

  addDiscoveredEvent(sourceKey: string, kind: string, time: string | null, bootId: string | null, process: string | null, device: string | null, subsystem: string | null, summary: string, raw: Buffer) {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT id FROM events WHERE source_key=?').get(sourceKey)) return false;
      const evidenceId = this.saveEvidence(raw, `journal:${sourceKey}`, 'application/vnd.systemd.journal-json', 'COMPLETE_CAPTURE', 'linux-journal:v1');
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id(), sourceKey, kind, time, bootId, process, device, subsystem, summary, evidenceId, now());
      return true;
    })();
  }

  recordScan(startedAt: string, state: string, coverage: unknown, raw: Buffer | null) {
    return this.db.transaction(() => {
      const evidenceId = raw ? this.saveEvidence(raw, 'journalctl:scan', 'application/x-ndjson', state === 'COMPLETE' ? 'COMPLETE_CAPTURE' : 'TRUNCATED', 'linux-journal:v1') : null;
      this.db.prepare('INSERT INTO scans VALUES(?,?,?,?,?,?)').run(id(), startedAt, now(), state, json(coverage), evidenceId);
    })();
  }

  recent() {
    const rules = this.db.prepare('SELECT * FROM ignore_rules ORDER BY created_at DESC').all() as Row[];
    const active = rules.filter(r => r.active);
    const events = (this.db.prepare(`SELECT e.*,COALESCE((SELECT action FROM event_dispositions d WHERE d.event_id=e.id ORDER BY created_at DESC LIMIT 1),'NEW') AS disposition FROM events e ORDER BY e.event_time DESC, e.discovered_at DESC LIMIT 300`).all() as Row[]).map(e => { const ignoredByRule = e.disposition === 'NEW' && active.some(r => r.kind === e.kind && r.process === e.process); return { ...e, ignoredByRule, disposition: ignoredByRule ? 'IGNORED' : e.disposition }; });
    return { events, rules, scan: this.db.prepare('SELECT * FROM scans ORDER BY finished_at DESC LIMIT 1').get() ?? null };
  }

  addIgnoreRule(eventId: string) {
    const event = this.db.prepare('SELECT kind,process FROM events WHERE id=?').get(eventId) as Row | undefined;
    if (!event || !event.process) throw new Error('A process identity is required for a scoped ignore rule.');
    const ruleId = id();
    this.db.prepare('INSERT INTO ignore_rules VALUES(?,?,?,?,?)').run(ruleId, event.kind, event.process, 1, now());
    return { id: ruleId, kind: event.kind, process: event.process };
  }

  disableIgnoreRule(ruleId: string) {
    const changed = this.db.prepare('UPDATE ignore_rules SET active=0 WHERE id=? AND active=1').run(ruleId).changes;
    if (!changed) throw new Error('Active ignore rule not found.');
  }

  disposition(eventId: string, action: 'NEW' | 'DISMISSED' | 'IGNORED', reason: string) {
    if (!this.db.prepare('SELECT 1 FROM events WHERE id=?').get(eventId)) throw new Error('Event not found.');
    this.db.prepare('INSERT INTO event_dispositions VALUES(?,?,?,?,?)').run(id(), eventId, action, reason, now());
  }

  createIncident(title: string, symptom: string, eventIds: string[]) {
    return this.db.transaction(() => {
      const incidentId = id();
      this.db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)').run(incidentId, title, symptom, 'OPEN', 0, now());
      this.db.prepare('INSERT INTO user_assertions VALUES(?,?,?,?,?)').run(id(), incidentId, symptom, 'Reported symptom at incident creation', now());
      for (const eventId of [...new Set(eventIds)]) {
        const event = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Row | undefined;
        if (!event) throw new Error('Selected event not found.');
        this.db.prepare('INSERT INTO incident_events VALUES(?,?)').run(incidentId, eventId);
        this.db.prepare('INSERT OR IGNORE INTO incident_evidence VALUES(?,?)').run(incidentId, event.evidence_id);
        const evidence = this.getEvidence(String(event.evidence_id));
        const derived = extract(evidence.bytes.toString('utf8'), String(event.evidence_id));
        for (const o of derived.observations) this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?,0)').run(id(), incidentId, event.evidence_id, o.predicate, o.statement, o.start, o.end, json(o.values), 'rule:v1', now(), null);
        if (derived.signature) this.db.prepare('INSERT INTO signatures VALUES(?,?,?,?,?,?)').run(id(), incidentId, null, event.evidence_id, json(derived.signature), now());
      }
      this.addTimeline(incidentId, 'INCIDENT_CREATED', { title, eventIds });
      return incidentId;
    })();
  }

  listIncidents() { return this.db.prepare('SELECT * FROM incidents ORDER BY created_at DESC').all(); }
  requireIncident(incidentId: string) {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId) as Row | undefined;
    if (!row) throw new Error('Incident not found.');
    return row;
  }
  getEvidence(evidenceId: string) {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId) as (Row & { bytes: Buffer }) | undefined;
    if (!row) throw new Error('Evidence not found.');
    return row;
  }
  ownsEvidence(incidentId: string, evidenceId: string) { return !!this.db.prepare('SELECT 1 FROM incident_evidence WHERE incident_id=? AND evidence_id=?').get(incidentId, evidenceId); }

  getIncident(incidentId: string) {
    const incident = this.requireIncident(incidentId);
    const all = (sql: string) => this.db.prepare(sql).all(incidentId);
    const evidence = all('SELECT e.id,e.sha256,e.source,e.kind,e.captured_at,e.completeness,length(e.bytes) AS byte_length FROM evidence e JOIN incident_evidence ie ON ie.evidence_id=e.id WHERE ie.incident_id=? ORDER BY e.captured_at');
    const observations = all('SELECT * FROM observations WHERE incident_id=? ORDER BY created_at');
    const assertions = all('SELECT * FROM user_assertions WHERE incident_id=? ORDER BY created_at');
    const inferences = all('SELECT * FROM inferences WHERE incident_id=? ORDER BY created_at');
    const hypotheses = all('SELECT * FROM hypotheses WHERE incident_id=? ORDER BY created_at');
    const attempts = all('SELECT * FROM attempts WHERE incident_id=? ORDER BY created_at');
    const signatures = all('SELECT * FROM signatures WHERE incident_id=? ORDER BY created_at');
    const comparisons = all('SELECT * FROM comparisons WHERE incident_id=? ORDER BY created_at');
    const events = all('SELECT e.* FROM events e JOIN incident_events ie ON ie.event_id=e.id WHERE ie.incident_id=? ORDER BY e.event_time');
    const timeline = all('SELECT * FROM timeline WHERE incident_id=? ORDER BY seq');
    const assessment = this.db.prepare('SELECT * FROM assessments WHERE incident_id=? ORDER BY revision DESC LIMIT 1').get(incidentId);
    const assessments = all('SELECT * FROM assessments WHERE incident_id=? ORDER BY revision DESC');
    const resolutions = all('SELECT * FROM resolutions WHERE incident_id=? ORDER BY created_at');
    return { incident, assertions, evidence, observations, inferences, hypotheses, attempts, signatures, comparisons, events, timeline, assessment, assessments, resolutions };
  }

  private buildRecommendation(incidentId: string) {
    const evidence = Number((this.db.prepare('SELECT COUNT(*) AS n FROM incident_evidence WHERE incident_id=?').get(incidentId) as Row).n);
    const attempts = this.db.prepare('SELECT qa_violation FROM attempts WHERE incident_id=? ORDER BY created_at').all(incidentId) as Row[];
    if (!evidence) return { action: 'Import or collect relevant diagnostic evidence.', why: 'There is no source material in this incident.', changes: 'None', constants: 'Current configuration', information: 'Establish what the system recorded.', risk: 'Low', reversible: true, doNotYet: ['Reinstall the operating system', 'Change the kernel'] };
    if (!attempts.length) return { action: 'If safe, record a baseline attempt with its workload, configuration, and duration.', why: 'A comparable baseline is missing.', changes: 'None', constants: 'Known configuration', information: 'Shows whether the target failure occurs under documented conditions.', risk: 'Depends on failure severity; stop if unsafe', reversible: true, doNotYet: ['Reinstall the operating system', 'Change several variables at once'] };
    if (attempts.at(-1)?.qa_violation) return { action: 'Return to a documented baseline and test one setting only, if safe.', why: 'The last attempt changed multiple variables.', changes: 'One selected setting against baseline', constants: 'Workload and other relevant settings', information: 'Separates which change might matter.', risk: 'Depends on reproduction risk', reversible: true, doNotYet: ['Treat the multivariable result as causal proof'] };
    return { action: 'Review remaining unknowns, then choose a narrow, reversible test.', why: 'No single deterministic next test is justified by the recorded fields.', changes: 'To be selected', constants: 'Document baseline and workload', information: 'A user-defined prediction can make the next attempt discriminating.', risk: 'To be assessed', reversible: true, doNotYet: ['Reinstall the operating system without supporting evidence'] };
  }

  recommendation(incidentId: string) {
    this.requireIncident(incidentId);
    const snapshot = this.db.prepare('SELECT value_json FROM assessments WHERE incident_id=? ORDER BY revision DESC LIMIT 1').get(incidentId) as Row | undefined;
    return snapshot ? parse<{ recommendation: ReturnType<Store['buildRecommendation']> }>(snapshot.value_json).recommendation : null;
  }

  recurrence(incidentId: string) {
    const data = this.getIncident(incidentId);
    const families = new Set((data.signatures as Row[]).map(row => parse<Signature>(row.value_json).family));
    const episodes: { family: string; process: string; time: string; boot: string; device: string; evidenceId: string; uncertain: boolean }[] = [];
    const scanned = this.db.prepare('SELECT e.*,v.bytes FROM events e JOIN evidence v ON v.id=e.evidence_id ORDER BY e.event_time,e.discovered_at').all() as (Row & { bytes: Buffer })[];
    for (const e of scanned) {
      const signature = extract(e.bytes.toString('utf8'), String(e.evidence_id)).signature;
      if (!signature || !families.has(signature.family)) continue;
      const time = String(e.event_time ?? e.discovered_at);
      const process = signature.components.process ?? String(e.process ?? 'unknown');
      const boot = String(e.boot_id ?? 'unknown');
      const device = String(e.device ?? 'unknown');
      const prior = episodes.slice().reverse().find(item => item.family === signature.family && item.process === process && item.boot === boot && item.device === device);
      if (prior && Math.abs(Date.parse(time) - Date.parse(prior.time)) <= 30000) continue;
      episodes.push({ family: signature.family, process, time, boot, device, evidenceId: String(e.evidence_id), uncertain: !e.event_time || !e.boot_id });
    }
    const imported = (data.signatures as Row[]).filter(row => !scanned.some(e => e.evidence_id === row.evidence_id));
    for (const row of imported) {
      const signature = parse<Signature>(row.value_json);
      if (episodes.some(e => e.evidenceId === row.evidence_id)) continue;
      episodes.push({ family: signature.family, process: signature.components.process ?? 'unknown', time: String(row.created_at), boot: 'manual', device: 'unknown', evidenceId: String(row.evidence_id), uncertain: true });
    }
    return [...families].map(family => {
      const members = episodes.filter(e => e.family === family);
      const processes: Record<string, number> = {};
      for (const member of members) processes[member.process] = (processes[member.process] ?? 0) + 1;
      const times = members.map(e => e.time).sort();
      return { family, recordedEpisodes: members.length, first: times[0] ?? null, latest: times.at(-1) ?? null, processes, uncertainEpisodes: members.filter(e => e.uncertain).length, evidenceIds: members.map(e => e.evidenceId), note: 'Recorded episodes in available local evidence; grouping and source coverage may be incomplete. This is not a failure rate or a proven shared cause.' };
    });
  }

  addAssertion(incidentId: string, statement: string, scope: string) {
    return this.db.transaction(() => {
      this.requireIncident(incidentId);
      const assertionId = id();
      this.db.prepare('INSERT INTO user_assertions VALUES(?,?,?,?,?)').run(assertionId, incidentId, statement, scope, now());
      this.addTimeline(incidentId, 'USER_ASSERTION_ADDED', { assertionId, statement, scope });
      return assertionId;
    })();
  }

  retractObservation(incidentId: string, observationId: string, reason: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT incident_id,retracted FROM observations WHERE id=?').get(observationId) as Row | undefined;
      if (!row || row.incident_id !== incidentId || row.retracted) throw new Error('Active observation not found.');
      this.db.prepare('UPDATE observations SET retracted=1 WHERE id=?').run(observationId);
      const dependants = this.db.prepare('SELECT id,support_json FROM inferences WHERE incident_id=? AND retracted=0').all(incidentId) as Row[];
      for (const inference of dependants) if (parse<string[]>(inference.support_json).includes(observationId)) this.db.prepare('UPDATE inferences SET retracted=1 WHERE id=?').run(inference.id);
      this.addTimeline(incidentId, 'OBSERVATION_RETRACTED', { observationId, reason, dependentInferencesInvalidated: dependants.filter(i => parse<string[]>(i.support_json).includes(observationId)).map(i => i.id) });
    })();
  }

  addObservation(incidentId: string, evidenceId: string, start: number, end: number, statement: string) {
    return this.db.transaction(() => {
      if (!this.ownsEvidence(incidentId, evidenceId)) throw new Error('Evidence is not linked to incident.');
      const bytes = this.getEvidence(evidenceId).bytes;
      if (start < 0 || end <= start || end > bytes.toString('utf8').length) throw new Error('Invalid evidence span.');
      const observationId = id();
      this.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?,0)').run(observationId, incidentId, evidenceId, 'user_selected_span', statement, start, end, json({ quote: bytes.toString('utf8').slice(start, end) }), 'user', now(), null);
      this.addTimeline(incidentId, 'OBSERVATION_ADDED', { observationId, evidenceId, start, end });
      return observationId;
    })();
  }

  addInference(incidentId: string, statement: string, observationIds: string[], limitations: string) {
    return this.db.transaction(() => {
      if (!observationIds.length) throw new Error('An inference needs observation support.');
      for (const oid of observationIds) {
        const o = this.db.prepare('SELECT incident_id,retracted FROM observations WHERE id=?').get(oid) as Row | undefined;
        if (!o || o.incident_id !== incidentId || o.retracted) throw new Error('Invalid observation support.');
      }
      const inferenceId = id();
      this.db.prepare('INSERT INTO inferences VALUES(?,?,?,?,?,?,?,?,0)').run(inferenceId, incidentId, statement, json(observationIds), limitations, 'user', now(), null);
      this.addTimeline(incidentId, 'INFERENCE_ADDED', { inferenceId, observationIds });
      return inferenceId;
    })();
  }

  addHypothesis(incidentId: string, proposition: string, prediction: string, weakeningResult: string) {
    return this.db.transaction(() => {
      this.requireIncident(incidentId);
      const hypothesisId = id();
      this.db.prepare('INSERT INTO hypotheses VALUES(?,?,?,?,?,?,?,?,?)').run(hypothesisId, incidentId, proposition, prediction, weakeningResult, 'UNTESTED', 'Not yet tested.', now(), 0);
      this.addTimeline(incidentId, 'HYPOTHESIS_PROPOSED', { hypothesisId, proposition });
      return hypothesisId;
    })();
  }

  assessHypothesis(incidentId: string, hypothesisId: string, status: HypothesisStatus, reason: string, supportIds: string[]) {
    return this.db.transaction(() => {
      const h = this.db.prepare('SELECT * FROM hypotheses WHERE id=?').get(hypothesisId) as Row | undefined;
      if (!h || h.incident_id !== incidentId || h.retired) throw new Error('Hypothesis not active in incident.');
      const unique = [...new Set(supportIds)];
      for (const supportId of unique) {
        const observation = this.db.prepare('SELECT incident_id FROM observations WHERE id=? AND retracted=0').get(supportId) as Row | undefined;
        const attempt = this.db.prepare('SELECT incident_id FROM attempts WHERE id=?').get(supportId) as Row | undefined;
        if (observation?.incident_id !== incidentId && attempt?.incident_id !== incidentId) throw new Error('Support must belong to this incident.');
      }
      if (status === 'CONFIRMED_WITHIN_SCOPE') {
        const hasObservation = unique.some(s => !!this.db.prepare('SELECT 1 FROM observations WHERE id=? AND incident_id=? AND retracted=0').get(s, incidentId));
        const hasAttempt = unique.some(s => !!this.db.prepare('SELECT 1 FROM attempts WHERE id=? AND incident_id=?').get(s, incidentId));
        if (!hasObservation || !hasAttempt || reason.length < 40) throw new Error('Scoped confirmation needs an observation, a test attempt, and a detailed reviewed explanation.');
      }
      if (status === 'REJECTED' && !unique.length) throw new Error('Rejection needs a recorded contradictory result.');
      const assessmentId = id();
      this.db.prepare('INSERT INTO hypothesis_assessments VALUES(?,?,?,?,?,?,?)').run(assessmentId, hypothesisId, status, reason, json(unique), 'user', now());
      this.db.prepare('UPDATE hypotheses SET status=?,assessment_reason=? WHERE id=?').run(status, reason, hypothesisId);
      this.addTimeline(incidentId, 'HYPOTHESIS_ASSESSED', { hypothesisId, assessmentId, status, reason, supportIds: unique });
    })();
  }

  addAttempt(incidentId: string, baselineId: string | null, protocol: { workload: string; plannedMinutes: number; relevant: string[]; target: string }, environment: Environment, requestedOutcome: AttemptOutcome, exposureMinutes: number, coverage: boolean) {
    return this.db.transaction(() => {
      this.requireIncident(incidentId);
      let classification = 'UNCLASSIFIABLE', differences: unknown[] = [], qaViolation = false;
      if (baselineId) {
        const base = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(baselineId) as Row | undefined;
        if (!base || base.incident_id !== incidentId) throw new Error('Invalid baseline.');
        const diff = compareEnvironment(parse<Environment>(base.environment_json), environment, protocol.relevant);
        classification = diff.classification; differences = diff.differences; qaViolation = diff.qaViolation;
      }
      const outcome = classifyOutcome(requestedOutcome, exposureMinutes, protocol.plannedMinutes, coverage);
      const attemptId = id();
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptId, incidentId, baselineId, json(protocol), json(environment), outcome, exposureMinutes, Number(coverage), classification, json(differences), Number(qaViolation), now());
      this.addTimeline(incidentId, 'ATTEMPT_RECORDED', { attemptId, baselineId, outcome, classification, qaViolation });
      return { attemptId, outcome, classification, differences, qaViolation };
    })();
  }

  private compareLatestAttemptSignatures(incidentId: string, attemptId: string) {
    const current = this.db.prepare('SELECT * FROM signatures WHERE attempt_id=? ORDER BY created_at DESC LIMIT 1').get(attemptId) as Row | undefined;
    const attempt = this.db.prepare('SELECT baseline_id FROM attempts WHERE id=?').get(attemptId) as Row;
    if (!current || !attempt.baseline_id) return;
    const baseline = this.db.prepare('SELECT * FROM signatures WHERE attempt_id=? ORDER BY created_at DESC LIMIT 1').get(attempt.baseline_id) as Row | undefined;
    if (!baseline) return;
    const value = compareSignatures(parse<Signature>(baseline.value_json), parse<Signature>(current.value_json));
    const comparisonId = id();
    this.db.prepare('INSERT INTO comparisons VALUES(?,?,?,?,?,?)').run(comparisonId, incidentId, baseline.id, current.id, json(value), now());
    this.addTimeline(incidentId, 'SIGNATURE_COMPARED', { comparisonId, result: value.result, explanation: value.explanation }, 'rule:v1');
  }

  resolve(incidentId: string, outcome: string, rootCauseStatus: string, summary: string) {
    return this.db.transaction(() => {
      this.requireIncident(incidentId);
      if (outcome === 'ROOT_CAUSE_IDENTIFIED' && rootCauseStatus !== 'CONFIRMED_WITHIN_SCOPE') throw new Error('Identified root cause requires reviewed scoped confirmation.');
      if (rootCauseStatus === 'CONFIRMED_WITHIN_SCOPE' && !this.db.prepare("SELECT 1 FROM hypotheses WHERE incident_id=? AND status='CONFIRMED_WITHIN_SCOPE' LIMIT 1").get(incidentId)) throw new Error('A reviewed scoped hypothesis confirmation is required.');
      this.db.prepare('INSERT INTO resolutions VALUES(?,?,?,?,?,?)').run(id(), incidentId, outcome, rootCauseStatus, summary, now());
      this.db.prepare("UPDATE incidents SET status='CLOSED' WHERE id=?").run(incidentId);
      this.addTimeline(incidentId, 'RESOLVED', { outcome, rootCauseStatus, summary });
    })();
  }

  reopen(incidentId: string, reason: string) {
    return this.db.transaction(() => {
      this.requireIncident(incidentId);
      this.db.prepare("UPDATE incidents SET status='OPEN' WHERE id=?").run(incidentId);
      this.addTimeline(incidentId, 'REOPENED', { reason });
    })();
  }

  purgeIncident(incidentId: string, confirmedTitle: string, reason: string) {
    return this.db.transaction(() => {
      const incident = this.requireIncident(incidentId);
      if (incident.title !== confirmedTitle) throw new Error('The confirmation title does not match this investigation.');
      const evidenceIds = (this.db.prepare('SELECT evidence_id FROM incident_evidence WHERE incident_id=?').all(incidentId) as Row[]).map(row => String(row.evidence_id));
      this.db.exec('DROP TRIGGER evidence_no_delete; DROP TRIGGER timeline_no_delete;');
      this.db.prepare('DELETE FROM comparisons WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM signatures WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM observations WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM inferences WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM hypothesis_assessments WHERE hypothesis_id IN (SELECT id FROM hypotheses WHERE incident_id=?)').run(incidentId);
      this.db.prepare('DELETE FROM hypotheses WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM attempt_evidence WHERE attempt_id IN (SELECT id FROM attempts WHERE incident_id=?)').run(incidentId);
      this.db.prepare('DELETE FROM attempts WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM resolutions WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM user_assertions WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM assessments WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM timeline WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM incident_events WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM incident_evidence WHERE incident_id=?').run(incidentId);
      this.db.prepare('DELETE FROM incidents WHERE id=?').run(incidentId);
      let removed = 0;
      for (const evidenceId of evidenceIds) {
        const shared = this.db.prepare('SELECT 1 FROM incident_evidence WHERE evidence_id=? UNION SELECT 1 FROM events WHERE evidence_id=? UNION SELECT 1 FROM scans WHERE evidence_id=? LIMIT 1').get(evidenceId, evidenceId, evidenceId);
        if (!shared) removed += this.db.prepare('DELETE FROM evidence WHERE id=?').run(evidenceId).changes;
      }
      this.db.prepare('INSERT INTO purge_log VALUES(?,?,?,?)').run(incidentId, now(), reason, removed);
      this.db.exec(`
        CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;
        CREATE TRIGGER timeline_no_delete BEFORE DELETE ON timeline BEGIN SELECT RAISE(ABORT,'timeline is append only'); END;
      `);
      return { evidenceBlobsRemoved: removed, sharedDiscoveryRetained: evidenceIds.length - removed };
    })();
  }
}
