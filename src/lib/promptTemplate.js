// Shared `$name` substitution for prompt templates. Used by production builders
// (so the lab can load the exact shipped text) and by the prompt lab's
// challenger editor. Longest names first; `$` inside values stays literal.

export function renderPromptTemplate(template, variables = {}) {
  let text = String(template ?? "");
  const names = Object.keys(variables).sort((a, b) => b.length - a.length);
  for (const name of names) {
    text = text.split(`$${name}`).join(String(variables[name] ?? ""));
  }
  return text;
}
