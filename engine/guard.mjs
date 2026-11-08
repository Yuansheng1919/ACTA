import { object } from './gates.mjs';
import { reject } from './fault.mjs';

export const guardVersion = 'guard-1';
export const schemaVersion = 1;

export function initial(spec) {
  return { location: spec.locations[0], phase: spec.phases[0] };
}

export function settle(state, candidates, spec, onApplied = () => {}) {
  if (!Array.isArray(candidates) || candidates.length > 16) reject(422, 'state.events');
  const next = { ...state };
  for (const [index,event] of candidates.entries()) {
    if (!object(event) || Object.keys(event).length !== 2 || typeof event.value !== 'string')
      reject(422, 'state.event_shape', { event_index:index });
    if (event.op === 'move' && spec.locations.includes(event.value)) next.location = event.value;
    else if (event.op === 'phase' && spec.phases.includes(event.value)) next.phase = event.value;
    else reject(422, 'state.invalid_transition', { event_index:index });
  }
  onApplied({phase_forward: candidates.some(event => event.op === 'phase') &&
    spec.phases.indexOf(next.phase) > spec.phases.indexOf(state.phase)});
  return next;
}
