/**
 * Generic explicit-transition state machine helpers.
 *
 * A machine is a table of `from -> allowed next states`. Terminal states have
 * no outgoing transitions. Every transition attempt returns a result object
 * rather than throwing so callers can record the outcome as an audit event.
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export type TransitionResult<S extends string> =
  | { ok: true; state: S }
  | { ok: false; error: string };

export function isTransitionAllowed<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export function transition<S extends string>(
  table: TransitionTable<S>,
  machineName: string,
  from: S,
  to: S,
): TransitionResult<S> {
  if (isTransitionAllowed(table, from, to)) {
    return { ok: true, state: to };
  }
  return {
    ok: false,
    error: `${machineName}: illegal transition from "${from}" to "${to}"`,
  };
}

export function terminalStates<S extends string>(table: TransitionTable<S>): readonly S[] {
  return (Object.keys(table) as S[]).filter((s) => table[s].length === 0);
}
