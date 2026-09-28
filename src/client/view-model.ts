export type EventView = {
  id?: string;
  kind?: string | null;
  summary?: string | null;
  process?: string | null;
  subsystem?: string | null;
  device?: string | null;
  event_time?: string | null;
  disposition?: string | null;
  ignoredByRule?: boolean;
};

export function filterEvents<T extends EventView>(events: T[], query: string, kind: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return events.filter(event => {
    if (kind !== 'ALL' && event.kind !== kind) return false;
    if (!needle) return true;
    return [event.summary, event.process, event.subsystem, event.device, event.kind]
      .filter(Boolean)
      .some(value => String(value).toLocaleLowerCase().includes(needle));
  });
}

export function eventComponent(event: EventView): string {
  return event.process || event.device || 'kernel';
}

export function eventSource(event: EventView): string {
  return event.subsystem || 'system journal';
}

export function eventState(event: EventView): string {
  return event.disposition || 'NEW';
}

export function eventKindLabel(kind: string | null | undefined): string {
  return String(kind || 'EVENT').replaceAll('_', ' ');
}
