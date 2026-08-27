// The shape of a callable, read from the single source line the graph stores as
// its `signature`: how many parameters it takes, and whether it declares a
// result. Nothing more. That is enough to tell apart the contracts a name alone
// cannot — caddy holds 34 methods called `ServeHTTP`, in three different shapes,
// and a question about one of them is not a question about the others.
//
// Deliberately not a type comparison. The same type is spelled differently on
// either side of a package boundary (`http.ResponseWriter` in one file,
// `ResponseWriter` in the file that declares it), so comparing type text would
// refuse honest matches. Parameter count and "is there a result" are written the
// same way everywhere.

// The paren group that starts at `from`, and where it ends. Depth-aware, so a
// parameter that is itself a function type stays one parameter.
function group(line, from) {
  if (line[from] !== '(') return null;
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) return { inner: line.slice(from + 1, i), end: i };
    }
  }
  return null;
}

// Top-level commas only, for the same reason.
function countParams(inner) {
  const text = inner.trim();
  if (!text) return 0;
  let depth = 0;
  let n = 1;
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

export function sigShape(signature, name) {
  const line = typeof signature === 'string' ? signature.trim() : '';
  if (!line || !name) return null;
  // The name may appear more than once on the line — a Go receiver can be named
  // after its own method in principle, and a result type can repeat it. Take the
  // first occurrence that is immediately followed by a parameter list.
  for (let at = line.indexOf(name); at !== -1; at = line.indexOf(name, at + 1)) {
    const after = at + name.length;
    // A longer identifier that merely contains `name` is not this method.
    if (/[\w$]/.test(line[after] ?? '')) continue;
    if (/[\w$.]/.test(line[at - 1] ?? '')) continue;
    const params = group(line, after);
    if (!params) continue;
    // The text after the parameter list is not always just a result type.
    // A Go one-line method can carry a body ("Close() {}") or a trailing
    // "//" comment ("Reset() // resets internal state"), and both are
    // ordinary source, not something the parser stripped out first.
    // Strip the comment before cutting at the brace, not after: on
    // "Reset() // uses {}" cutting the brace first leaves "// uses ",
    // which is not empty and would wrongly read as a result.
    let rest = line
      .slice(params.end + 1)
      .replace(/\/\/.*$/, '');
    // A one-line interface leaves its OWN closing brace, or the next member's
    // leading ";", sitting right after this method's parameter list — that is
    // not a result type either. `type Closer interface { Close() }` has to cut
    // at the "}" so "Close" reads as no-result, and `type X interface { A();
    // B() }` has to cut at the ";" so "A" does the same. Both chars can only
    // mean this when they show up before this method's own "{" (its body, or
    // an anonymous-struct result) — so it is enough to stop at whichever of
    // "{", "}", ";" comes first; a "}" or ";" that shows up after a "{" is
    // already dropped by that cut.
    const stops = [rest.indexOf('{'), rest.indexOf('}'), rest.indexOf(';')].filter((i) => i !== -1);
    if (stops.length) rest = rest.slice(0, Math.min(...stops));
    rest = rest.trim();
    return { params: countParams(params.inner), hasResult: rest.length > 0 };
  }
  return null;
}
