import { createHash } from 'node:crypto';

export type Origin = 'rule' | 'user' | 'ai';
export type SignatureFamily = 'gpuvm' | 'bind' | 'access_violation' | 'generic_crash';
export type Match = 'STRONG_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH' | 'NO_MATCH' | 'INCOMPARABLE';
export type HypothesisStatus = 'UNTESTED' | 'SUPPORTED' | 'WEAKENED' | 'REJECTED' | 'CONFIRMED_WITHIN_SCOPE';
export type AttemptOutcome = 'PENDING' | 'TARGET_FAILURE_OBSERVED' | 'OTHER_FAILURE_OBSERVED' | 'TARGET_NOT_OBSERVED' | 'INCONCLUSIVE';
export type EnvFact = { value: string | null; source: 'collected' | 'user' | 'unknown'; capturedAt?: string };
export type Environment = Record<string, EnvFact>;
export type Signature = { family: SignatureFamily; version: 1; components: Record<string, string>; missing: string[]; digest: string; evidenceId: string };
export type ObservationCandidate = { predicate: string; statement: string; start: number; end: number; values: Record<string, string> };
export type Comparison = { result: Match; scope: 'INSTANCE_PATTERN' | 'FAMILY'; matched: string[]; conflicting: string[]; missing: string[]; explanation: string };
export type VariableDifference = { key: string; before: string | null; after: string | null; kind: 'MEANINGFUL' | 'UNKNOWN' | 'NUISANCE' };
export type AttemptClassification = 'REPRODUCTION_ATTEMPT' | 'CONTROLLED_TEST' | 'MULTI_VARIABLE_TEST' | 'UNCLASSIFIABLE';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (values: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));

export function extract(text: string, evidenceId: string): { observations: ObservationCandidate[]; signature: Signature | null } {
  const observations: ObservationCandidate[] = [];
  const add = (predicate: string, statement: string, match: RegExpMatchArray | null, values: Record<string, string>) => {
    if (match?.index === undefined) return;
    observations.push({ predicate, statement, start: match.index, end: match.index + match[0].length, values });
  };
  const gpu = text.match(/(?:AMDGPU|amdgpu)[^\n]{0,350}(?:GPUVM|page fault)|(?:GPUVM|page fault)[^\n]{0,350}(?:AMDGPU|amdgpu)/i);
  if (gpu) {
    const process = text.match(/(?:process|comm|exe|pid)[\s:=]+([\w.\-]+\.exe)/i) ?? text.match(/\b([\w.\-]+\.exe)\b/i);
    const fault = text.match(/\bPERMISSION_FAULTS\s*=\s*(\d+)\b/i);
    const thread = text.match(/\bvkd3d_queue\b/i);
    add('kernel_reported_gpuvm_fault', 'AMDGPU reported a GPUVM/page fault.', gpu, { driver: 'amdgpu', category: 'gpuvm' });
    if (process) add('process_named', `The record names ${process[1]}.`, process, { process: process[1] });
    if (fault) add('fault_field_reported', `The record reports PERMISSION_FAULTS=${fault[1]}.`, fault, { PERMISSION_FAULTS: fault[1] });
    if (thread) add('thread_named', 'The record names a vkd3d_queue thread.', thread, { thread: 'vkd3d_queue' });
    const components: Record<string, string> = { driver: 'amdgpu', category: 'gpuvm' };
    if (process) components.process = process[1].toLowerCase();
    if (fault) components.permissionFaults = fault[1];
    if (thread) components.thread = 'vkd3d_queue';
    return { observations, signature: makeSignature('gpuvm', components, ['process', 'permissionFaults'].filter(k => !components[k]), evidenceId) };
  }
  const bind = text.match(/\bEADDRINUSE\b/i);
  if (bind) {
    const port = text.match(/(?:port\s*|:)(\d{1,5})\b/i);
    add('bind_error_reported', 'The process reported EADDRINUSE.', bind, { code: 'EADDRINUSE' });
    if (port) add('port_named', `The record names port ${port[1]}.`, port, { port: port[1] });
    const components: Record<string, string> = { code: 'EADDRINUSE' };
    if (port && Number(port[1]) <= 65535) components.port = String(Number(port[1]));
    return { observations, signature: makeSignature('bind', components, components.port ? [] : ['port'], evidenceId) };
  }
  const listener = text.match(/\b(?:node|nodejs)\b[^\n]{0,250}\bTCP\b[^\n]{0,150}:(\d{1,5})\b[^\n]{0,100}\bLISTEN\b/i);
  if (listener && Number(listener[1]) <= 65535) {
    add('listener_reported', `A Node process was reported listening on TCP port ${listener[1]} at capture time.`, listener, { process: 'node', port: listener[1], protocol: 'TCP' });
    return { observations, signature: null };
  }
  const av = text.match(/\b0xc0000005\b/i);
  if (av) {
    const exe = text.match(/\b([\w.\-]+\.exe)\b/i);
    const mod = text.match(/\b([\w.\-]+\.dll)\b/i);
    add('access_violation_reported', 'The crash report records exception 0xc0000005.', av, { exception: '0xc0000005' });
    if (exe) add('process_named', `The report names ${exe[1]}.`, exe, { process: exe[1] });
    if (mod) add('module_named', `The report names ${mod[1]}.`, mod, { module: mod[1] });
    const components: Record<string, string> = { exception: '0xc0000005' };
    if (exe) components.process = exe[1].toLowerCase();
    if (mod) components.module = mod[1].toLowerCase();
    return { observations, signature: makeSignature('access_violation', components, ['process', 'module'].filter(k => !components[k]), evidenceId) };
  }
  const signal = text.match(/\b(?:signal\s+)?(SIGSEGV|SIGABRT|SIGBUS)\b/i);
  if (signal) {
    add('signal_reported', `The record reports ${signal[1].toUpperCase()}.`, signal, { signal: signal[1].toUpperCase() });
    return { observations, signature: makeSignature('generic_crash', { signal: signal[1].toUpperCase() }, ['process'], evidenceId) };
  }
  return { observations, signature: null };
}

function makeSignature(family: SignatureFamily, components: Record<string, string>, missing: string[], evidenceId: string): Signature {
  return { family, version: 1, components, missing, evidenceId, digest: sha(`${family}:1:${stable(components)}`) };
}

export function compareSignatures(a: Signature | null, b: Signature | null, scope: 'INSTANCE_PATTERN' | 'FAMILY' = 'INSTANCE_PATTERN'): Comparison {
  if (!a || !b || a.version !== b.version) return { result: 'INCOMPARABLE', scope, matched: [], conflicting: [], missing: ['signature unavailable or version incompatible'], explanation: 'The records lack comparable supported signatures.' };
  if (a.family !== b.family) return { result: 'NO_MATCH', scope, matched: [], conflicting: ['failure family'], missing: [], explanation: `Different failure families: ${a.family} and ${b.family}.` };
  const required = scope === 'FAMILY' ? ({ gpuvm: ['driver', 'category'], bind: ['code'], access_violation: ['exception', 'module'], generic_crash: ['signal'] } as const)[a.family]
    : ({ gpuvm: ['driver', 'category', 'process', 'permissionFaults'], bind: ['code', 'port'], access_violation: ['exception', 'module', 'process'], generic_crash: ['signal', 'process'] } as const)[a.family];
  const matched: string[] = [], conflicting: string[] = [], missing: string[] = [];
  for (const key of required) {
    const left = a.components[key], right = b.components[key];
    if (!left || !right) missing.push(key);
    else if (left === right) matched.push(`${key}=${left}`);
    else conflicting.push(`${key}: ${left} / ${right}`);
  }
  let result: Match;
  if (conflicting.length) result = 'NO_MATCH';
  else if (!missing.length) result = 'STRONG_MATCH';
  else if (matched.length >= 2) result = 'PARTIAL_MATCH';
  else result = 'WEAK_MATCH';
  return { result, scope, matched, conflicting, missing, explanation: `${result.replaceAll('_', ' ').toLowerCase()} of ${scope === 'FAMILY' ? 'failure family' : 'reported failure pattern'}: ${matched.length ? `matched ${matched.join(', ')}` : 'no specific components matched'}${missing.length ? `; missing ${missing.join(', ')}` : ''}${conflicting.length ? `; conflicting ${conflicting.join(', ')}` : ''}. This does not establish a common cause.` };
}

const nuisance = new Set(['pid', 'timestamp', 'journalCursor']);
export function compareEnvironment(base: Environment, current: Environment, relevant: string[]): { differences: VariableDifference[]; classification: AttemptClassification; qaViolation: boolean } {
  const keys = new Set([...Object.keys(base), ...Object.keys(current), ...relevant]);
  const differences: VariableDifference[] = [];
  for (const key of keys) {
    const before = base[key]?.value ?? null, after = current[key]?.value ?? null;
    const kind = nuisance.has(key) ? 'NUISANCE' : before === null || after === null ? 'UNKNOWN' : 'MEANINGFUL';
    if (before !== after || (kind === 'UNKNOWN' && relevant.includes(key))) differences.push({ key, before, after, kind });
  }
  const meaningful = differences.filter(d => d.kind === 'MEANINGFUL').length;
  const unknown = relevant.some(key => base[key]?.value == null || current[key]?.value == null);
  const classification: AttemptClassification = meaningful > 1 ? 'MULTI_VARIABLE_TEST' : unknown ? 'UNCLASSIFIABLE' : meaningful === 1 ? 'CONTROLLED_TEST' : 'REPRODUCTION_ATTEMPT';
  return { differences, classification, qaViolation: meaningful > 1 };
}

export type EventLike = { id: string; time: string | null; bootId?: string | null; process?: string | null; device?: string | null; subsystem?: string | null };
export function correlate(a: EventLike, b: EventLike): { related: boolean; reasons: string[]; limitations: string[] } {
  const reasons: string[] = [], limitations: string[] = [];
  if (a.bootId && b.bootId && a.bootId !== b.bootId) return { related: false, reasons: [], limitations: ['Different boots'] };
  if (!a.time || !b.time) limitations.push('Event time missing');
  else {
    const delta = Math.abs(Date.parse(a.time) - Date.parse(b.time));
    if (!Number.isFinite(delta)) limitations.push('Event time invalid');
    else if (delta > 120000) return { related: false, reasons: [], limitations: ['More than 120 seconds apart'] };
    else reasons.push(`${Math.round(delta / 1000)} seconds apart`);
  }
  const nonTemporal = ['process', 'device', 'subsystem'] as const;
  const shared = nonTemporal.filter(k => a[k] && b[k] && a[k] === b[k]);
  for (const key of shared) reasons.push(`Shared ${key}: ${a[key]}`);
  if (!shared.length) limitations.push('No shared non-temporal signal');
  return { related: !!a.time && !!b.time && shared.length > 0, reasons, limitations };
}

export function classifyOutcome(outcome: AttemptOutcome, observedMinutes: number, plannedMinutes: number, coverage: boolean): AttemptOutcome {
  if (outcome === 'TARGET_NOT_OBSERVED' && (!coverage || observedMinutes < plannedMinutes)) return 'INCONCLUSIVE';
  return outcome;
}

export function redact(input: string): { text: string; categories: string[] } {
  const found = new Set<string>();
  let text = input;
  const rules: [string, RegExp, string][] = [
    ['private key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
    ['authorization header', /\bAuthorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]'],
    ['cookie', /\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]'],
    ['credential', /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED_CREDENTIAL]'],
    ['credential', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[psu]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_CREDENTIAL]'],
    ['connection string', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)\:\/\/[^\s]+/gi, '[REDACTED_CONNECTION_STRING]'],
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
    ['home path', /\/(?:home|Users)\/[^\s/]+/g, '[REDACTED_HOME]'],
    ['hostname', /\b(?:host(?:name)?|server)\s*[=:]\s*[A-Za-z0-9._-]+/gi, '[REDACTED_HOSTNAME]'],
    ['IPv6 address', /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{0,39}\b/gi, '[REDACTED_IP]'],
    ['IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]']
  ];
  for (const [category, pattern, replacement] of rules) text = text.replace(pattern, () => { found.add(category); return replacement; });
  return { text, categories: [...found] };
}

export function safeMarkdown(input: string): string {
  return input.replace(/[\x00-\x1f\x7f]/g, c => c === '\n' ? '\n' : ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()!|~]/g, '\\$&')
    .replace(/^(\s*)(#{1,6}|>|[-+]\s|\d+\.\s)/gm, '$1\\$2');
}
