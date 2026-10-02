// Runs the REAL coverage_swarm_workflow.js with stubbed Workflow globals
// (agent, parallel, pipeline, phase, log, args), so the control flow is tested
// exactly as written, with no model calls.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../coverage_swarm_workflow.js', import.meta.url)), 'utf8')
  .replace('export const meta', 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function runWorkflow(args, respond) {
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return respond(opts.label, prompt, opts, calls);
  };
  // Same contract as the runtime: a thunk that throws resolves to null.
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  // Same contract as the runtime: each item runs through every stage; a stage that
  // throws drops that item to null and skips its remaining stages.
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let v = item;
    try {
      for (const s of stages) v = await s(v, item, i);
      return v;
    } catch { return null; }
  }));
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', SRC);
  const result = await fn(args, agent, parallel, pipeline, () => {}, (m) => logs.push(m));
  return { result, calls, logs };
}
