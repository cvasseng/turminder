/**
 * The empty-transcript greeting (§9): "Good morning, Alex".
 *
 * On its own so the band boundaries can be tested — `app.js` is one long
 * script with a socket in it, and the same argument that gave `preview.js` and
 * `connect.js` their own files applies to the one function here worth being
 * sure about.
 *
 * The clock is the *reader's*, deliberately: the identity file carries a
 * timezone (App. G.3) and the service uses it for everything scheduled, but
 * this line is about the person looking at the screen. Someone reading their
 * assistant from another continent should be told good evening when it is
 * their evening.
 *
 * Three bands, not four. "Good night" is a farewell in English, so the small
 * hours get "Good evening" rather than a goodbye from something that has just
 * been opened.
 */
function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good day';
  return 'Good evening';
}

/** The whole line, named or not — onboarding has no name to use yet. */
function greetingLine(hour, name) {
  const greeting = greetingFor(hour);
  return name ? `${greeting}, ${name}` : greeting;
}
