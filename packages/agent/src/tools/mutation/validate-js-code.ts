/**
 * Validates JavaScript function body code before wrapping with export default.
 * Returns validation result with actionable error messages for the agent.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateJsFunctionBody(code: string): ValidationResult {
  const trimmedCode = code.trim();

  // Check for common anti-pattern: defines a function but doesn't call it
  // Matches: function name(...), async function name(...)
  const definesFunctionRegex = /^\s*(async\s+)?function\s+(\w+)\s*\(/m;
  const match = trimmedCode.match(definesFunctionRegex);

  if (match) {
    const functionName = match[2];
    // Check if the function is actually called somewhere
    const callRegex = new RegExp(`\\b${functionName}\\s*\\(`);
    const returnCallRegex = new RegExp(`return\\s+(await\\s+)?${functionName}\\s*\\(`);

    if (!returnCallRegex.test(trimmedCode)) {
      return {
        valid: false,
        error: `Code defines function '${functionName}' but never returns its result. ` +
          `Either write the logic directly (not inside a nested function), ` +
          `or add 'return ${functionName}(ctx);' at the end.`,
      };
    }
  }

  // Check for arrow function definitions that aren't called
  const definesArrowRegex = /^\s*const\s+(\w+)\s*=\s*(async\s*)?\([^)]*\)\s*=>/m;
  const arrowMatch = trimmedCode.match(definesArrowRegex);

  if (arrowMatch) {
    const functionName = arrowMatch[1];
    const returnCallRegex = new RegExp(`return\\s+(await\\s+)?${functionName}\\s*\\(`);

    if (!returnCallRegex.test(trimmedCode)) {
      return {
        valid: false,
        error: `Code defines arrow function '${functionName}' but never returns its result. ` +
          `Either write the logic directly (not inside a nested function), ` +
          `or add 'return ${functionName}(ctx);' at the end.`,
      };
    }
  }

  // Check there's a return statement (code should produce output)
  if (!/\breturn\s/.test(trimmedCode)) {
    return {
      valid: false,
      error: `Code has no return statement. The function body must return a value. ` +
        `Add a return statement like 'return { result: ... };'`,
    };
  }

  // Check for accidentally including the export default wrapper
  if (/^\s*export\s+default\s+function/.test(trimmedCode)) {
    return {
      valid: false,
      error: `Do not include 'export default function(ctx) { ... }' - the tool adds this automatically. ` +
        `Provide only the function body.`,
    };
  }

  return { valid: true };
}
