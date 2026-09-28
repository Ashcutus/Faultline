import { describe, expect, it } from 'vitest';
import { eventComponent, eventKindLabel, eventSource, eventState, filterEvents } from './view-model.js';

const events = [
  { id: '1', kind: 'GPU_FAULT', summary: 'AMDGPU GPUVM page fault', process: 'MetroExodus.exe', subsystem: 'amdgpu', disposition: 'NEW' },
  { id: '2', kind: 'PROCESS_CRASH', summary: 'Hyprland segfault', process: null, subsystem: null, device: 'card0', disposition: 'DISMISSED' },
];

describe('Recent Problems view model', () => {
  it('filters by visible diagnostic text and kind without changing source rows', () => {
    expect(filterEvents(events, 'metro', 'ALL').map(event => event.id)).toEqual(['1']);
    expect(filterEvents(events, '', 'PROCESS_CRASH').map(event => event.id)).toEqual(['2']);
    expect(filterEvents(events, 'missing', 'ALL')).toEqual([]);
  });

  it('uses only available event fields for compact row metadata', () => {
    expect(eventComponent(events[0])).toBe('MetroExodus.exe');
    expect(eventComponent(events[1])).toBe('card0');
    expect(eventSource(events[0])).toBe('amdgpu');
    expect(eventSource(events[1])).toBe('system journal');
    expect(eventState(events[0])).toBe('NEW');
    expect(eventKindLabel('GPU_FAULT')).toBe('GPU FAULT');
  });
});
