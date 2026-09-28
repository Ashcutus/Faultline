import { expect, it } from 'vitest';
import { normaliseJournalRecord } from './collector.js';

it('normalises a journal GPU fault with provenance and time without inferring cause', () => {
  const record = { __CURSOR: 's=1', __REALTIME_TIMESTAMP: '1790625600000000', _BOOT_ID: 'boot-1', MESSAGE: 'MetroExodus.exe AMDGPU GPUVM page fault PERMISSION_FAULTS=3', _COMM: 'MetroExodus.exe' };
  const event = normaliseJournalRecord(record, JSON.stringify(record));
  expect(event).toMatchObject({ kind: 'GPU_FAULT', bootId: 'boot-1', process: 'MetroExodus.exe', subsystem: 'amdgpu', sourceKey: 'journal:s=1:GPU_FAULT' });
  expect(event?.time).toMatch(/^2026-/);
  expect(event?.summary).toContain('PERMISSION_FAULTS=3');
});

it('handles repeated/binary/null fields and absent facilities without making up events', () => {
  const repeated = normaliseJournalRecord({ MESSAGE: ['AMDGPU', 'GPUVM page fault'], __CURSOR: 'c2' }, '{}');
  expect(repeated?.kind).toBe('GPU_FAULT');
  expect(repeated?.time).toBeNull();
  expect(normaliseJournalRecord({ MESSAGE: [0, 1, 2], __REALTIME_TIMESTAMP: null }, '{}')).toBeNull();
  expect(normaliseJournalRecord({ MESSAGE: null }, '{}')).toBeNull();
});

it('recognises coredump metadata without loading a core image', () => {
  const event = normaliseJournalRecord({ COREDUMP_PID: '123', COREDUMP_EXE: '/usr/bin/my-app', MESSAGE: 'Process dumped core' }, '{}');
  expect(event).toMatchObject({ kind: 'PROCESS_CRASH', process: 'my-app' });
});
