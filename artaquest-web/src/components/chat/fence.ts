/**
 * Code-fence helpers — plain functions, deliberately NOT in MessageBody.tsx.
 *
 * A file that exports both components and utilities breaks React Fast Refresh (and the lint rule
 * that guards it), so the one predicate the composer needs lives here on its own.
 */

/** Does this draft end inside an unclosed ``` fence? The composer asks so that pressing Enter while
 *  writing a code block adds a line instead of sending half a function. */
export function insideFence(text: string): boolean {
  return (text.match(/```/g) || []).length % 2 === 1;
}
