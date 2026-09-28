import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { executeJournalScan, proposeJournalScan, type ScanProposal } from './collector.js';
import { renderExport } from './export.js';
import { compareSignatures, correlate, type Signature, type HypothesisStatus, type AttemptOutcome } from '../core/investigation.js';

process.umask(0o077);
const dataDir = process.env.WTFIX_DATA_DIR ?? join(homedir(), '.local', 'share', 'wtfix');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { chmodSync(dataDir, 0o700); } catch { /* existing ACL may control access */ }
const store = new Store(join(dataDir, 'wtfix.db'));
const app = Fastify({ bodyLimit: 14 * 1024 * 1024, logger: false });
const token = randomBytes(32).toString('hex');
const sessionToken = randomBytes(32).toString('hex');
let bootstrapAvailable = true;
const proposals = new Map<string, ScanProposal>();
let address = '';

app.addHook('onRequest', async (request, reply) => {
  const host = request.headers.host;
  if (address && host !== address) return reply.code(403).send({ error: 'Invalid Host header.' });
  const origin = request.headers.origin;
  if (origin && origin !== `http://${address}`) return reply.code(403).send({ error: 'Invalid Origin.' });
  const sessionCookie = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('wtfix_session='))?.slice('wtfix_session='.length);
  const hasSession = sessionCookie === sessionToken;
  if (request.url === '/api/bootstrap') {
    if (!hasSession && (!bootstrapAvailable || request.headers['x-wtfix-token'] !== token)) return reply.code(401).send({ error: 'Launch token unavailable.' });
    if (!hasSession) bootstrapAvailable = false;
    return;
  }
  if (request.url.startsWith('/api/') && !hasSession) return reply.code(401).send({ error: 'Open WTFix from its current launch URL.' });
});
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return payload;
});
app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : 'Request failed.';
  const code = error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : 400;
  reply.code(code).send({ error: error instanceof z.ZodError ? 'Invalid request fields.' : message });
});

const text = z.string().min(1).max(10000);
const short = z.string().min(1).max(500);
const uuid = z.string().uuid();
const envFact = z.object({ value: z.string().max(500).nullable(), source: z.enum(['collected', 'user', 'unknown']), capturedAt: z.string().optional() });
const parseId = (x: unknown) => uuid.parse(x);

app.post('/api/bootstrap', async (_request, reply) => {
  reply.header('Set-Cookie', `wtfix_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
  return { ok: true };
});
app.get('/api/health', async () => ({ ok: true, mode: 'local', ai: 'optional, no provider configured' }));
app.get('/api/recent', async () => store.recent());
app.get('/api/scan/proposal', async () => {
  const proposal = proposeJournalScan();
  proposals.set(proposal.digest, proposal);
  setTimeout(() => proposals.delete(proposal.digest), 120000).unref();
  return proposal;
});
app.post('/api/scan', async (request) => {
  const { digest, approved } = z.object({ digest: z.string().length(64), approved: z.literal(true) }).parse(request.body);
  const proposal = proposals.get(digest);
  if (!proposal) throw new Error('Scan proposal expired. Review it again.');
  proposals.delete(digest);
  return executeJournalScan(store, proposal);
});
app.post('/api/events/:id/disposition', async (request) => {
  const eventId = parseId((request.params as { id: string }).id);
  const { action, reason } = z.object({ action: z.enum(['NEW', 'DISMISSED', 'IGNORED']), reason: z.string().max(500).default('') }).parse(request.body);
  store.disposition(eventId, action, reason);
  return { ok: true };
});
app.post('/api/events/:id/ignore-matching', async (request) => store.addIgnoreRule(parseId((request.params as { id: string }).id)));
app.post('/api/ignore-rules/:id/disable', async (request) => { store.disableIgnoreRule(parseId((request.params as { id: string }).id)); return { ok: true }; });
app.get('/api/incidents', async () => store.listIncidents());
app.post('/api/incidents', async (request) => {
  const { title, symptom, eventIds } = z.object({ title: short, symptom: text, eventIds: z.array(uuid).max(50).default([]) }).parse(request.body);
  return { id: store.createIncident(title, symptom, eventIds) };
});
app.get('/api/incidents/:id', async (request) => store.getIncident(parseId((request.params as { id: string }).id)));
app.get('/api/incidents/:id/evidence/:evidenceId', async (request, reply) => {
  const { id, evidenceId } = request.params as { id: string; evidenceId: string };
  if (!store.ownsEvidence(parseId(id), parseId(evidenceId))) return reply.code(404).send({ error: 'Evidence not linked to incident.' });
  const e = store.getEvidence(evidenceId);
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  return e.bytes.toString('utf8');
});
app.get('/api/incidents/:id/evidence/:evidenceId/download', async (request, reply) => {
  const { id, evidenceId } = request.params as { id: string; evidenceId: string };
  if (!store.ownsEvidence(parseId(id), parseId(evidenceId))) return reply.code(404).send({ error: 'Evidence not linked to incident.' });
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Disposition', `attachment; filename="evidence-${evidenceId}.bin"`);
  return store.getEvidence(evidenceId).bytes;
});
app.post('/api/incidents/:id/evidence', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { base64, source, kind, attemptId } = z.object({ base64: z.string().max(14 * 1024 * 1024), source: short, kind: short.default('text/plain'), attemptId: uuid.optional() }).parse(request.body);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid base64 evidence.');
  return store.importEvidence(incidentId, Buffer.from(base64, 'base64'), source, kind, attemptId);
});
app.post('/api/incidents/:id/observations', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { evidenceId, start, end, statement } = z.object({ evidenceId: uuid, start: z.number().int().min(0), end: z.number().int().positive(), statement: text }).parse(request.body);
  return { id: store.addObservation(incidentId, evidenceId, start, end, statement) };
});
app.post('/api/incidents/:id/assertions', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { statement, scope } = z.object({ statement: text, scope: short }).parse(request.body);
  return { id: store.addAssertion(incidentId, statement, scope) };
});
app.post('/api/incidents/:id/observations/:observationId/retract', async (request) => {
  const { id, observationId } = request.params as { id: string; observationId: string };
  const { reason } = z.object({ reason: text }).parse(request.body);
  store.retractObservation(parseId(id), parseId(observationId), reason);
  return { ok: true };
});
app.post('/api/incidents/:id/inferences', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { statement, observationIds, limitations } = z.object({ statement: text, observationIds: z.array(uuid).min(1), limitations: text }).parse(request.body);
  return { id: store.addInference(incidentId, statement, observationIds, limitations) };
});
app.post('/api/incidents/:id/hypotheses', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { proposition, prediction, weakeningResult } = z.object({ proposition: text, prediction: text, weakeningResult: text }).parse(request.body);
  return { id: store.addHypothesis(incidentId, proposition, prediction, weakeningResult) };
});
app.post('/api/incidents/:id/hypotheses/:hypothesisId/assessment', async (request) => {
  const { id, hypothesisId } = request.params as { id: string; hypothesisId: string };
  const { status, reason, supportIds } = z.object({ status: z.enum(['UNTESTED', 'SUPPORTED', 'WEAKENED', 'REJECTED', 'CONFIRMED_WITHIN_SCOPE']), reason: text, supportIds: z.array(uuid).default([]) }).parse(request.body);
  store.assessHypothesis(parseId(id), parseId(hypothesisId), status as HypothesisStatus, reason, supportIds);
  return { ok: true };
});
app.post('/api/incidents/:id/attempts', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const body = z.object({ baselineId: uuid.nullable(), protocol: z.object({ workload: text, plannedMinutes: z.number().min(0).max(100000), relevant: z.array(short).max(100), target: short }), environment: z.record(z.string(), envFact), outcome: z.enum(['PENDING', 'TARGET_FAILURE_OBSERVED', 'OTHER_FAILURE_OBSERVED', 'TARGET_NOT_OBSERVED', 'INCONCLUSIVE']), exposureMinutes: z.number().min(0).max(100000), coverage: z.boolean() }).parse(request.body);
  return store.addAttempt(incidentId, body.baselineId, body.protocol, body.environment, body.outcome as AttemptOutcome, body.exposureMinutes, body.coverage);
});
app.post('/api/incidents/:id/resolve', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { outcome, rootCauseStatus, summary } = z.object({ outcome: z.enum(['ROOT_CAUSE_IDENTIFIED', 'WORKAROUND_FOUND', 'PROBLEM_DISAPPEARED', 'PRODUCT_REMOVED', 'USER_ABANDONED', 'OTHER']), rootCauseStatus: z.enum(['NOT_PROVEN', 'SUPPORTED', 'CONFIRMED_WITHIN_SCOPE']), summary: text }).parse(request.body);
  store.resolve(incidentId, outcome, rootCauseStatus, summary);
  return { ok: true };
});
app.post('/api/incidents/:id/reopen', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { reason } = z.object({ reason: text }).parse(request.body);
  store.reopen(incidentId, reason);
  return { ok: true };
});
app.post('/api/incidents/:id/purge', async (request) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const { confirmedTitle, reason } = z.object({ confirmedTitle: short, reason: text }).parse(request.body);
  return store.purgeIncident(incidentId, confirmedTitle, reason);
});
app.get('/api/incidents/:id/export', async (request, reply) => {
  const incidentId = parseId((request.params as { id: string }).id);
  const privateExport = (request.query as { private?: string }).private === 'true';
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  return renderExport(store, incidentId, privateExport);
});
app.get('/api/incidents/:id/recommendations', async (request) => {
  return store.recommendation(parseId((request.params as { id: string }).id));
});
app.get('/api/incidents/:id/recurrence', async (request) => {
  return store.recurrence(parseId((request.params as { id: string }).id));
});
app.get('/api/correlation', async () => {
  const { events } = store.recent();
  const list = (events as Record<string, unknown>[]).slice(0, 100);
  const suggestions = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const result = correlate({ id: String(a.id), time: a.event_time as string | null, bootId: a.boot_id as string | null, process: a.process as string | null, device: a.device as string | null, subsystem: a.subsystem as string | null }, { id: String(b.id), time: b.event_time as string | null, bootId: b.boot_id as string | null, process: b.process as string | null, device: b.device as string | null, subsystem: b.subsystem as string | null });
    if (result.related) suggestions.push({ eventIds: [a.id, b.id], ...result });
  }
  return suggestions.slice(0, 50);
});

const dist = resolve('dist');
if (!existsSync(dist)) throw new Error('Build the client first with npm run build.');
await app.register(fastifyStatic, { root: dist, prefix: '/' });
await app.listen({ host: '127.0.0.1', port: 0 });
address = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
console.log(`WTFix is running at http://${address}/#${token}`);
console.log('Keep this terminal open. Press Ctrl+C to stop WTFix.');
