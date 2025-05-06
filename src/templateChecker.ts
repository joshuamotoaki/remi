/**
 * src/templateChecker.ts
 * This module checks that templates in Remi files can prerender to
 * static HTML at compile time and generates the HTML output.
 */

import { writeFileSync } from "fs";
import { join } from "path";

interface Variable {
  type: "client" | "server" | "public" | "sset" | "readable";
  value?: any;
  initialized: boolean;
}

interface CompileState {
  variables: Map<string, Variable>;
  errors: { lineNumber: number; message: string }[];
}

export function checkTemplates(code: string, filename: string): string {
  const state: CompileState = {
    variables: new Map(),
    errors: [],
  };

  parseVariables(code, state);
  const renderMatch = code.match(/<render>([\s\S]*?)<\/render>/);
  if (!renderMatch) return code; 

  const renderContent = renderMatch[1];
  checkRenderContent(renderContent, state, code);

  if (state.errors.length > 0) {
    const errorMessages = state.errors
      .map((err) => `Line ${err.lineNumber}: ${err.message}`)
      .join("\n");
    throw new Error(`Template checking failed:\n${errorMessages}`);
  }

  const html = generateHtml(renderContent, state);
  const outputPath = join("./out", filename.replace(".remi", ".html"));
  writeFileSync(outputPath, html);

  // Return original code for piping to next module
  return code;
}

function parseVariables(code: string, state: CompileState): void {
  // A single regex to match all variable types with optional initialization
  // Assumption is that labels are correct (a different layer will check this)
  const varRegex =
    /@(client|server|public|sset|readable)\s+(const|let|var)?\s+(\w+)(?:\s*=\s*([^;]+))?/g;

  let match;
  while ((match = varRegex.exec(code)) !== null) {
    const [_, varType, declType, name, value] = match;

    // Default to uninitialized
    let varData: Variable = {
      type: varType as any, 
      initialized: false,
    };

    if (value) {
      try {
        const evaluatedValue = eval(value);
        varData.value = evaluatedValue;
        varData.initialized = true;
      } catch (error) {
        // Keep as uninitialized if we can't evaluate
      }
    }

    state.variables.set(name, varData);
  }
}

function checkRenderContent(
  content: string,
  state: CompileState,
  fullCode: string
): void {
  const processedContent = evaluateConditionals(content, state, fullCode);
  checkTemplateExpressions(processedContent, state, fullCode);
}

function evaluateConditionals(
  content: string,
  state: CompileState,
  fullCode: string
): string {
  // Match ternary operators in JSX/render content
  const conditionalRegex = /\(([^?]+)\s*\?\s*([^:]+)\s*:\s*([^)]+)\)/g;
  let result = content;
  let match;

  // Create a regex that won't match inside already processed parts
  const regex = new RegExp(conditionalRegex);

  // Process from outside in - keep replacing until no more matches
  while ((match = regex.exec(result)) !== null) {
    const [fullMatch, condition, trueBranch, falseBranch] = match;
    const lineNumber = getLineNumber(fullCode, fullCode.indexOf(fullMatch));

    try {
      // Try to evaluate the condition at compile time
      const conditionVar = condition.trim();
      const conditionValue = evaluateExpression(conditionVar, state);

      if (typeof conditionValue === "boolean") {
        // Replace with the branch that will be executed
        result = result.replace(
          fullMatch,
          conditionValue ? trueBranch : falseBranch
        );

        // Reset regex to start from beginning since we modified content
        regex.lastIndex = 0;
      } else {
        // If we can't determine the condition value, check both branches
        checkRenderContent(trueBranch, state, fullCode);
        checkRenderContent(falseBranch, state, fullCode);

        // Move past this conditional
        regex.lastIndex = match.index + fullMatch.length;
      }
    } catch (error) {
      // If condition can't be evaluated, check both branches
      checkRenderContent(trueBranch, state, fullCode);
      checkRenderContent(falseBranch, state, fullCode);

      // Move past this conditional
      regex.lastIndex = match.index + fullMatch.length;
    }
  }

  return result;
}

function checkTemplateExpressions(
  content: string,
  state: CompileState,
  fullCode: string
): void {
  // Match all template expressions {expr} that are not in on: attributes
  const tagAttributeRegex = /on:[^=]+=\{[^}]+\}/g;

  // First, replace all on: attributes with placeholders to avoid checking them
  const placeholders = new Map();
  let placeholderContent = content.replace(tagAttributeRegex, (match) => {
    const placeholder = `__PLACEHOLDER_${placeholders.size}__`;
    placeholders.set(placeholder, match);
    return placeholder;
  });

  // Now check template expressions in the modified content
  const templateRegex = /{([^}]+)}/g;
  let match;

  while ((match = templateRegex.exec(placeholderContent)) !== null) {
    const [fullMatch, expr] = match;

    // Calculate the correct position in the original content
    let originalPosition = fullCode.indexOf(fullMatch);

    // If we can't find it directly (due to the placeholder replacements),
    // we'll use an approximate position for the line number
    if (originalPosition === -1) {
      originalPosition =
        fullCode.indexOf(content) + placeholderContent.indexOf(fullMatch);
    }

    const lineNumber = getLineNumber(fullCode, originalPosition);

    // Check for "until" syntax
    if (expr.includes(" until ")) {
      const [fallbackExpr, varName] = expr
        .split(" until ")
        .map((s) => s.trim());

      // Verify fallback expression is defined
      if (!isResolvableAtCompileTime(fallbackExpr, state)) {
        state.errors.push({
          lineNumber,
          message: `Fallback expression "${fallbackExpr}" cannot be resolved at compile time`,
        });
      }

      // Variable will be defined at runtime, so this is valid
      continue;
    }

    // If not using "until", expression must be defined at compile time
    if (!isResolvableAtCompileTime(expr, state)) {
      state.errors.push({
        lineNumber,
        message: `Template expression "${expr}" cannot be resolved at compile time`,
      });
    }
  }
}

// Check if expression is a literal or a known compile-time variable
function isResolvableAtCompileTime(expr: string, state: CompileState): boolean {
  try {
    const value = evaluateExpression(expr, state);
    return value !== undefined;
  } catch (error) {
    return false;
  }
}

// Try to evaluate simple literals directly
function evaluateExpression(expr: string, state: CompileState): any {
  try {
    // Yes, there may be security / performance implications here,
    // I'm sure someone could make an infinite loop with this.
    // However, this is a proof-of-concept and not production code.
    // In a real-world scenario, we would use a safer parser or evaluator.
    return eval(expr);
  } catch {
    // If not a literal, check if it's a variable name
    const variable = state.variables.get(expr.trim());
    if (variable && variable.initialized && variable.value !== undefined) {
      return variable.value;
    }
    throw new Error(`Cannot evaluate expression: ${expr}`);
  }
}

function generateHtml(renderContent: string, state: CompileState): string {
  let html = renderContent;

  // First, remove on:* attributes before any other processing
  html = html.replace(/\s+on:[^=]+=\{[^}]+\}/g, "");

  // Process ternary conditionals
  const conditionalRegex = /\(([^?]+)\s*\?\s*([^:]+)\s*:\s*([^)]+)\)/g;
  html = html.replace(
    conditionalRegex,
    (match, condition, trueBranch, falseBranch) => {
      try {
        const conditionValue = evaluateExpression(condition.trim(), state);
        return conditionValue ? trueBranch : falseBranch;
      } catch {
        // Default to true branch if can't evaluate
        return trueBranch;
      }
    }
  );

  // Replace template expressions with their values or fallback
  const templateRegex = /{([^}]+)}/g;
  html = html.replace(templateRegex, (match, expr) => {
    if (expr.includes(" until ")) {
      const [fallbackExpr, varName] = expr
        .split(" until ")
        .map((s: string) => s.trim());

      // Check if the variable exists and is initialized
      const variable = state.variables.get(varName.trim());
      if (variable && variable.initialized && variable.value !== undefined) {
        return variable.value;
      }

      try {
        return evaluateExpression(fallbackExpr, state) || "";
      } catch {
        return "";
      }
    }

    try {
      return evaluateExpression(expr, state) || "";
    } catch {
      return "";
    }
  });

  // Do another pass to remove any on:* attributes that might have been missed
  html = html.replace(/\s+on:[a-z0-9_-]+(=|\s*=\s*)([^>\s]*|"[^"]*"|'[^']*')/gi, "");

  html = `<div>${html}</div>`;
  return formatHtml(html);
}

function formatHtml(html: string): string {
  const indentSize = 2;
  let formattedHtml = "";
  let indentLevel = 0;
  
  // Simple tokenizer for HTML
  const tokens = html.match(/<[^>]+>|[^<>]+/g) || [];
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    if (token.startsWith("</")) {
      // Closing tag
      indentLevel--;
      formattedHtml += " ".repeat(indentLevel * indentSize) + token + "\n";
    } else if (token.startsWith("<")) {
      // Opening tag
      formattedHtml += " ".repeat(indentLevel * indentSize) + token + "\n";
      
      // Self-closing tags don't increase indent
      if (!token.endsWith("/>") && !token.startsWith("<!") && !token.startsWith("<?")) {
        indentLevel++;
        
        // Check for content between this tag and the next
        if (i < tokens.length - 1 && !tokens[i + 1].startsWith("<")) {
          const content = tokens[i + 1].trim();
          if (content) {
            formattedHtml += " ".repeat(indentLevel * indentSize) + content + "\n";
          }
          i++; // Skip the content token as we've already processed it
        }
      }
    } else {
      // Content (only reached for content not immediately after a tag)
      const content = token.trim();
      if (content) {
        formattedHtml += " ".repeat(indentLevel * indentSize) + content + "\n";
      }
    }
  }
  
  // Remove consecutive blank lines
  formattedHtml = formattedHtml.replace(/\n\s*\n+/g, "\n");
  
  // Clean up any trailing whitespace
  formattedHtml = formattedHtml.replace(/\s+$/gm, "");
  
  return formattedHtml;
}

function getLineNumber(text: string, position: number): number {
  return text.substring(0, position).split("\n").length;
}
