import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Store } from './store.js';

export type ScanProposal = { collector: 'journal-v1'; executable: string; args: string[]; purpose: string; impact: string; maxBytes: number; timeoutMs: number; digest: string };
const limit = 20 * 1024 * 1024;

export function proposeJournalScan(): ScanProposal {
  const executable = ['/usr/bin/journalctl', '/bin/journalctl'].find(existsSync) ?? '';
  if (!executable) throw new Error('systemd journalctl is unavailable. You can still import evidence.');
  const end = new Date(), start = new Date(end.getTime() - 86400000);
  const args = ['--since', start.toISOString(), '--until', end.toISOString(), '--output=json', '--no-pager', '--quiet'];
  const data = { collector: 'journal-v1' as const, executable, args, purpose: 'Inspect accessible system journal records from the past 24 hours for supported failures.', impact: 'Read-only diagnostic query; captured records are stored locally. No administrator privileges.', maxBytes: limit, timeoutMs: 15000 };
  return { ...data, digest: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

function value(x: unknown): string | null {
  if (typeof x === 'string') return x;
  if (Array.isArray(x) && x.every(part => typeof part === 'string')) return x.join(' ');
  return null;
}
function journalTime(x: unknown): string | null {
  try { return x == null ? null : new Date(Number(BigInt(String(x)) / 1000n)).toISOString(); } catch { return null; }
}

export function normaliseJournalRecord(record: Record<string, unknown>, rawLine: string) {
  const message = value(record.MESSAGE) ?? '';
  const combined = [message, value(record.COREDUMP_EXE), value(record._COMM)].filter(Boolean).join(' ');
  let kind: string | null = null;
  if (/\b(?:GPUVM|amdgpu.*page fault)\b/i.test(combined)) kind = 'GPU_FAULT';
  else if (/\b(?:ring timeout|GPU reset|VRAM lost)\b/i.test(combined)) kind = 'GPU_RESET_CONTEXT';
  else if (record.COREDUMP_PID || /\b(?:segfault|core dumped|dumped core)\b/i.test(combined)) kind = 'PROCESS_CRASH';
  else if (/\b(?:failed with result|entered failed state|unit .* failed)\b/i.test(combined)) kind = 'SERVICE_FAILURE';
  if (!kind) return null;
  const cursor = value(record.__CURSOR);
  const sourceKey = cursor ? `journal:${cursor}:${kind}` : `journal:sha256:${createHash('sha256').update(rawLine).digest('hex')}:${kind}`;
  const process = value(record.COREDUMP_EXE)?.split('/').at(-1) ?? value(record._COMM) ?? message.match(/\b([\w.\-]+\.exe)\b/i)?.[1] ?? null;
  const device = message.match(/\b(?:card\d+|renderD\d+|[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\b/i)?.[0] ?? null;
  return { sourceKey, kind, time: journalTime(record.__REALTIME_TIMESTAMP), bootId: value(record._BOOT_ID), process, device, subsystem: /amdgpu|gpuvm/i.test(message) ? 'amdgpu' : null, summary: message.slice(0, 240) || `${kind} reported by journal` };
}

export async function executeJournalScan(store: Store, proposal: ScanProposal) {
  const startedAt = new Date().toISOString();
  let timedOut = false, limited = false, stderr = '';
  const chunks: Buffer[] = [];
  let bytes = 0;
  const child = spawn(proposal.executable, proposal.args, { shell: false, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: 'cat' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, proposal.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    if (bytes + chunk.length > proposal.maxBytes) { limited = true; child.kill('SIGTERM'); return; }
    bytes += chunk.length; chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 4000); });
  let code: number | null = null, spawnFailed = false;
  try {
    code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } catch (error) {
    spawnFailed = true;
    stderr = (error instanceof Error ? error.message : 'Collector could not start.').slice(0, 4000);
  } finally { clearTimeout(timer); }
  const raw = Buffer.concat(chunks);
  const lines = raw.toString('utf8').split('\n');
  if (lines.at(-1) !== '') lines.pop();
  let considered = 0, added = 0, malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    considered++;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { malformed++; continue; }
    const event = normaliseJournalRecord(record, line);
    if (!event) continue;
    if (store.addDiscoveredEvent(event.sourceKey, event.kind, event.time, event.bootId, event.process, event.device, event.subsystem, event.summary, Buffer.from(line + '\n'))) added++;
  }
  const state = timedOut || limited || code !== 0 || malformed || spawnFailed ? raw.length ? 'PARTIAL' : 'FAILED' : 'COMPLETE';
  const coverage = { source: 'systemd journal', since: proposal.args[1], until: proposal.args[3], recordsRead: considered, eventsAdded: added, malformed, bytes, exitCode: code, timedOut, limited, spawnFailed, error: stderr || null, note: 'Only records visible to this user were read; completeness of OS logging is not guaranteed.' };
  // Persist only the exact source records classified as events; unrelated journal lines stay in memory.
  store.recordScan(startedAt, state, coverage, null);
  return { state, coverage };
}
