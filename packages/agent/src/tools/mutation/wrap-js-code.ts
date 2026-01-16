/**
 * Wraps user-provided function body with the full export default function structure,
 * including injected helpers for workflow, node, and input.
 */
export function wrapJsFunctionBody(code: string): string {
  // Inject helpers that provide the documented API:
  // - input: alias for ctx (previous node output)
  // - workflow.getVariable(name): access workflow variables from ctx
  // - workflow.getSecret(name): access secrets from ctx (resolved at runtime)
  // - node.log(...args): logging for debugging
  const helpers = `  const input = ctx;
  const workflow = {
    getVariable: (name) => ctx[name],
    getSecret: (name) => ctx[name],
  };
  const node = {
    log: (...args) => console.log('[JS Node]', ...args),
  };
`;

  return `export default async function(ctx) {
${helpers}
${code}
}`;
}
