/**
 * Schema migrations for the stored state.
 *
 * Forward-only, one pure function per version bump, each taking the whole
 * record and returning the next one. Pure so they can be tested against a real
 * payload from the previous version rather than against a mock.
 *
 * Two cases matter more than the migrations themselves and are handled here
 * rather than at the call site:
 *
 *   A record with no schema at all is treated as version 1. It is either the
 *   first release or a hand-edited import, and refusing it would lock somebody
 *   out of their own file.
 *
 *   A record from a NEWER version than this build knows is refused, and the
 *   bytes are left exactly as they are. This is the case that actually loses
 *   data: an older build on a second device happily "migrating" a newer record
 *   downward would drop every field it does not recognise and then write the
 *   result back. Better to run with defaults and say the app needs updating.
 */

export const SCHEMA = 1;

/**
 * { fromVersion: (record) => record }
 *
 * Empty at version 1, and deliberately kept rather than deferred: the shape
 * being here from the start is what stops the first migration being written in
 * a hurry, inline, on the day it is needed.
 */
export const MIGRATIONS = {};

export function migrate(record) {
  if (!record || typeof record !== 'object') return { ok: true, record: null, from: null };

  const from = Number.isInteger(record.schema) ? record.schema : 1;

  if (from > SCHEMA) {
    return {
      ok: false,
      record: null,
      from,
      reason: `This device has version ${from} of your data and this copy of the app understands version ${SCHEMA}. `
        + 'Nothing has been changed. Update the app on this device, or open it somewhere already up to date.',
    };
  }

  let out = { ...record, schema: from };
  for (let v = from; v < SCHEMA; v += 1) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, record: null, from, reason: `No migration from version ${v}.` };
    out = step(out);
    out.schema = v + 1;
  }
  return { ok: true, record: out, from };
}
