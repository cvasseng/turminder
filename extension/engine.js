/**
 * The matcher engine (§29.2) — the whole of extraction, and deliberately the
 * only part of the extension carrying logic worth testing.
 *
 * Two hosts run this file and neither of them is a bundler. In the browser it
 * is a classic script injected beside `content.js`, sharing one isolated-world
 * scope the way `ui/`'s scripts share the page's — a function declared here and
 * called there is the module system. In vitest it is read off disk as text and
 * evaluated (§29.6's sanctioned cross-boundary read), which is why nothing here
 * imports or exports.
 *
 * Two constraints follow from that, and neither is stylistic:
 *
 *  - **`var` and `function` only, never a top-level `const` or `let`.** Opening
 *    the popup twice injects this file twice into the same world; a `const`
 *    redeclaration throws, and the second capture would return nothing.
 *  - **The DOM surface is `querySelectorAll` / `textContent` / `getAttribute`
 *    and nothing else**, so a test can hand these functions a cheerio document
 *    and get the same answers a browser gives. Anything richer would put a
 *    browser back in the test loop, which is the one thing §29.2 avoids.
 */

/**
 * App. A capture caps, mirrored across the §29.6 boundary because the extension
 * imports nothing from the service. `test/capture-matchers.test.ts` asserts
 * these three still equal the server's — a mirror nobody checks is a fork.
 */
var CAPTURE_MAX_CHARS = 100000;
var CAPTURE_FIELD_MAX_CHARS = 4000;
var CAPTURE_NOTE_MAX_CHARS = 2000;

/**
 * Whitespace-normalized (§29.2). Runs of spaces collapse, but line structure
 * survives: an email body is paragraphs, and flattening it to one line costs
 * the model the only cue separating a signature from a sentence.
 */
function normalizeSpace(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * An element's text minus the code that happens to live inside it — F.5's rule
 * that a page's scripts are not its text.
 *
 * Cloning and removing would be the obvious way and needs a fourth DOM method,
 * so instead each script/style descendant's own text is cut out of the parent's
 * by first occurrence. `textContent` and `querySelectorAll` are both document
 * order, so first-occurrence is the right one; the pathological case is a
 * script whose exact text also appears as prose earlier on the page, which
 * costs that prose and nothing else.
 */
function textOf(el) {
  var text = el.textContent || '';
  var junk = el.querySelectorAll('script, style, noscript, template');
  for (var i = 0; i < junk.length; i += 1) {
    var inner = junk[i].textContent || '';
    if (!inner) continue;
    var at = text.indexOf(inner);
    if (at !== -1) text = text.slice(0, at) + text.slice(at + inner.length);
  }
  return normalizeSpace(text);
}

/**
 * One field spec (§29.2): `{selector, attr?, all?, join?}`. `attr` reads the
 * attribute rather than the text — the only way to get an address out of a
 * client that renders a display name over it.
 */
function fieldValue(root, spec) {
  var nodes = root.querySelectorAll(spec.selector);
  if (!nodes || !nodes.length) return '';
  if (!spec.all) return valueOfNode(nodes[0], spec);
  var parts = [];
  for (var i = 0; i < nodes.length; i += 1) {
    var value = valueOfNode(nodes[i], spec);
    if (value) parts.push(value);
  }
  return parts.join(typeof spec.join === 'string' ? spec.join : '\n\n');
}

function valueOfNode(node, spec) {
  return spec.attr ? normalizeSpace(node.getAttribute(spec.attr) || '') : textOf(node);
}

/**
 * Run one matcher against a document (§29.2). Returns its fields, or `null`
 * when the matcher does not **claim** the page — every name in `require` has to
 * extract something non-empty. A matcher that half-matches is a matcher that
 * would quietly send the wrong half, so it yields to the next one instead.
 */
function extract(root, matcher) {
  var fields = {};
  var specs = matcher.fields || {};
  var names = Object.keys(specs);
  for (var i = 0; i < names.length; i += 1) {
    var value = fieldValue(root, specs[names[i]]);
    if (value) fields[names[i]] = value;
  }
  var required = matcher.require || [];
  for (var r = 0; r < required.length; r += 1) {
    if (!fields[required[r]]) return null;
  }
  return fields;
}

/** `mail.google.com` matches itself and any subdomain of it (§29.2). */
function matchesDomain(matcher, hostname) {
  var host = String(hostname || '').toLowerCase();
  var domains = matcher.domains || [];
  for (var i = 0; i < domains.length; i += 1) {
    var domain = String(domains[i]).toLowerCase();
    if (host === domain || host.endsWith('.' + domain)) return true;
  }
  return false;
}

/**
 * The first matcher that both covers this host and claims the page. Array order
 * is `matchers/index.json`'s order, which is why that file is a list and not a
 * map (§29.2).
 */
function pickMatcher(root, matchers, hostname) {
  var list = matchers || [];
  for (var i = 0; i < list.length; i += 1) {
    if (!matchesDomain(list[i], hostname)) continue;
    var fields = extract(root, list[i]);
    if (fields) return { name: list[i].name, fields: fields };
  }
  return null;
}

/** Client-side truncation is UX; the server's cap is the contract (§29.3). */
function cut(text, max) {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The `page.captured` payload (§29.3), assembled but not sent — the popup shows
 * exactly this object and the worker posts exactly this object, so what the
 * person approves and what the model reads are the same bytes.
 *
 * `fullText` is passed in rather than read here because the fallback is
 * `document.body.innerText` (§29.2), and `innerText` is a rendered-layout
 * property that no test-side DOM has. The caller owns that one browser-ism so
 * the engine can stay pure.
 */
function buildCapture(input) {
  var claimed = pickMatcher(input.root, input.matchers, input.hostname);
  var content;
  var fields = {};
  if (claimed) {
    // The body field *is* the content; everything else the matcher named rides
    // alongside it as `fields` (§29.3).
    content = claimed.fields.body || '';
    var names = Object.keys(claimed.fields);
    for (var i = 0; i < names.length; i += 1) {
      if (names[i] === 'body') continue;
      fields[names[i]] = cut(claimed.fields[names[i]], CAPTURE_FIELD_MAX_CHARS);
    }
  } else {
    content = normalizeSpace(input.fullText);
  }
  var payload = {
    url: String(input.url || ''),
    title: normalizeSpace(input.title),
    domain: String(input.hostname || ''),
    matcher: claimed ? claimed.name : 'fulltext',
    content: cut(content, CAPTURE_MAX_CHARS),
    truncated: content.length > CAPTURE_MAX_CHARS,
  };
  if (Object.keys(fields).length) payload.fields = fields;
  return payload;
}
