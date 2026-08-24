/**
 * The background worker (§29.1) — the only part of the extension that talks to
 * a network, and the only part that holds the token.
 *
 * It exists as a separate context for two reasons the spec is explicit about:
 * a content script is CORS-bound and a worker holding a host permission is not,
 * and a popup dies the moment focus leaves it, taking an in-flight POST with
 * it. So the popup asks and this answers.
 *
 * Written against the `chrome.*` **callback** subset, which is the intersection
 * Chromium and Firefox both implement (§29.6). Promises would be pleasanter and
 * would only work in one of them.
 */

/** The service on this machine, until someone points it elsewhere (§29.5). */
var DEFAULT_GATEWAY = 'http://localhost:7787';

function readConfig(done) {
  chrome.storage.local.get(['gateway_url', 'token', 'device'], function (stored) {
    done({
      gatewayUrl: (stored && stored.gateway_url) || DEFAULT_GATEWAY,
      token: (stored && stored.token) || '',
      device: (stored && stored.device) || '',
    });
  });
}

/**
 * Matchers are data (§29.2): `index.json` names them in claim order and each
 * one is its own file, so adding a matcher is dropping a file and adding a
 * name — no code changes, which is what makes shipping none of them today
 * cost nothing tomorrow.
 *
 * A matcher that fails to load is skipped rather than fatal. The fallback is
 * always there, and a broken JSON file should cost the page its matcher, not
 * the capture.
 */
function loadMatchers(done) {
  fetch(chrome.runtime.getURL('matchers/index.json'))
    .then(function (res) {
      return res.json();
    })
    .then(function (names) {
      var pending = (names || []).map(function (name) {
        return fetch(chrome.runtime.getURL('matchers/' + name + '.json'))
          .then(function (res) {
            return res.json();
          })
          .catch(function () {
            return null;
          });
      });
      return Promise.all(pending);
    })
    .then(function (loaded) {
      done(
        loaded.filter(function (m) {
          return m && m.name;
        }),
      );
    })
    .catch(function () {
      done([]);
    });
}

/**
 * Inject and extract. Two steps on purpose: the files define the engine in the
 * tab's isolated world, and the second call reaches back into that world for
 * the answer. One call with both files would have to trust that the result of
 * a multi-file injection is the last file's completion value, which is a detail
 * neither browser documents as a promise.
 */
function capture(done) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) {
      return done({ error: 'no_tab', message: 'No active tab to capture.' });
    }
    loadMatchers(function (matchers) {
      var target = { tabId: tab.id };
      chrome.scripting.executeScript(
        { target: target, files: ['engine.js', 'content.js'] },
        function () {
          if (chrome.runtime.lastError) {
            // Usually browser-internal pages, the store, or PDF viewers, which
            // refuse injection no matter what is granted — but not only those,
            // so the browser's own reason rides along rather than being
            // replaced by a guess. (A guess here once mislabelled a Firefox
            // clone error as a page refusal.)
            return done({
              error: 'cannot_capture',
              message:
                'This page could not be captured (' +
                chrome.runtime.lastError.message +
                '). Browser pages and the add-on store never allow it.',
            });
          }
          chrome.scripting.executeScript(
            {
              target: target,
              func: function (list) {
                return globalThis.__turminderCapture(list);
              },
              args: [matchers],
            },
            function (results) {
              if (chrome.runtime.lastError || !results || !results[0]) {
                return done({
                  error: 'cannot_capture',
                  message: 'Nothing came back from that page.',
                });
              }
              done({ payload: results[0].result });
            },
          );
        },
      );
    });
  });
}

/**
 * Post the capture as an event (App. E). The payload is the object the popup
 * displayed, plus the note typed in the popup's own document — the page never
 * saw either, which is what lets the server treat one as an instruction and the
 * other as data (App. B).
 */
function send(message, done) {
  readConfig(function (config) {
    if (!config.token) {
      return done({
        error: 'not_configured',
        message:
          'No device token yet — open the extension options and paste your connect link.',
      });
    }
    var payload = message.payload;
    var note = (message.note || '').trim();
    if (note) payload = Object.assign({}, payload, { note: note });

    fetch(config.gatewayUrl + '/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + config.token,
      },
      body: JSON.stringify({ type: 'page.captured', payload: payload }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (res.status === 401) {
              return done({
                error: 'unauthorized',
                message:
                  'The assistant refused this device token. It may have been revoked — pair again in options.',
              });
            }
            if (!res.ok) {
              return done({
                error: body.error || 'http_error',
                message: body.message || 'The assistant answered ' + res.status + '.',
              });
            }
            done({ event_id: body.event_id });
          });
      })
      .catch(function () {
        // Almost always the host permission, so lead with that rather than with
        // the browser's own opaque "Failed to fetch".
        done({
          error: 'unreachable',
          message:
            'Could not reach ' +
            config.gatewayUrl +
            ' — check it is running, and that you granted access to it in options.',
        });
      });
  });
}

/**
 * First run opens pairing (§29.5): the extension is useless until it holds a
 * token, so asking for one up front beats a first click that dead-ends. Gated
 * on the stored token, not the install reason, so an already-paired install
 * (an update, or Firefox re-adding a temporary add-on at start) stays quiet.
 */
chrome.runtime.onInstalled.addListener(function () {
  readConfig(function (config) {
    if (!config.token) chrome.runtime.openOptionsPage();
  });
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (message && message.kind === 'capture') {
    capture(sendResponse);
    return true;
  }
  if (message && message.kind === 'send') {
    send(message, sendResponse);
    return true;
  }
  return false;
});
