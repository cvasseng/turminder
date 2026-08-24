/**
 * The injected half (§29.1): read the page once, hand back the payload.
 *
 * Injected beside `engine.js`, so `buildCapture` is already a global in this
 * isolated world — the `ui/` arrangement, where a function declared in one
 * no-build script and called from another is the module system.
 *
 * Nothing here sends anything. The return value goes to the popup for a human
 * to read, and only a Send click turns it into an event; that gap is the whole
 * point of conscious capture.
 */
function capturePage(matchers) {
  return buildCapture({
    root: document,
    matchers: matchers,
    url: location.href,
    title: document.title,
    hostname: location.hostname,
    // The one browser-ism the engine refuses to own (§29.2): `innerText` is
    // what a person would have selected with the mouse, which is what the
    // fallback is trying to be.
    fullText: document.body ? document.body.innerText : '',
  });
}

/**
 * The worker calls this through `globalThis` rather than injecting a function
 * that names `capturePage` directly: a serialized `func` closes over nothing,
 * so a bare identifier would only resolve by luck of load order.
 */
globalThis.__turminderCapture = capturePage;

// Firefox structured-clones each injected file's completion value back to the
// worker and fails the whole injection when it cannot — and the assignment
// above evaluates to a function, which cannot. Chrome silently drops it, which
// is why only Firefox ever saw this. End on a clonable value.
void 0;
