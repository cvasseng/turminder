/**
 * The popup (§29.1) — a preview and a note field, and no opinions of its own.
 *
 * The one rule this file must not break: **the preview renders the payload,
 * never the page.** Everything below writes through `textContent`, so a page
 * that hid text from its own rendered view — offscreen, white-on-white — hands
 * it to the person here, in the same colour as everything else, before they
 * approve it. Innocuous-looking `innerHTML` in this file would quietly undo
 * the entire trust model.
 *
 * The note lives in this document rather than the page's, which is what makes
 * it the one field the page cannot read, fabricate, or alter (App. B).
 */
var $ = function (id) {
  return document.getElementById(id);
};

var captured = null;

function setStatus(text, kind) {
  var el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function renderFields(fields) {
  var host = $('fields');
  host.textContent = '';
  Object.keys(fields || {}).forEach(function (key) {
    var row = document.createElement('div');
    var k = document.createElement('span');
    k.className = 'key';
    k.textContent = key + ':';
    var v = document.createElement('span');
    v.className = 'val';
    v.textContent = fields[key];
    row.appendChild(k);
    row.appendChild(v);
    host.appendChild(row);
  });
}

function render(payload) {
  captured = payload;

  var badge = $('badge');
  badge.textContent = payload.matcher === 'fulltext' ? 'full text' : payload.matcher;
  badge.className = 'badge' + (payload.matcher === 'fulltext' ? ' fulltext' : '');
  badge.title =
    payload.matcher === 'fulltext'
      ? 'No matcher claimed this page, so this is everything on it — read it before sending.'
      : 'Extracted by the ' + payload.matcher + ' matcher.';

  var meta = $('meta');
  meta.textContent = '';
  var title = document.createElement('div');
  title.className = 'title';
  title.textContent = payload.title || '(untitled)';
  var url = document.createElement('div');
  url.textContent = payload.url;
  meta.appendChild(title);
  meta.appendChild(url);

  renderFields(payload.fields);

  $('preview').textContent = payload.content || '(nothing extractable on this page)';

  var truncated = $('truncated');
  truncated.hidden = !payload.truncated;
  if (payload.truncated) {
    truncated.textContent =
      'Cut at ' +
      payload.content.length.toLocaleString() +
      ' characters — the rest is not being sent.';
  }

  $('send').disabled = false;
}

function capture() {
  chrome.runtime.sendMessage({ kind: 'capture' }, function (reply) {
    if (chrome.runtime.lastError || !reply) {
      $('preview').textContent = '';
      return setStatus(
        'The extension worker did not answer. Try reloading the extension.',
        'bad',
      );
    }
    if (reply.error) {
      $('preview').textContent = '';
      $('badge').textContent = 'no capture';
      return setStatus(reply.message, 'bad');
    }
    render(reply.payload);
  });
}

function send() {
  if (!captured) return;
  $('send').disabled = true;
  setStatus('Sending…');
  chrome.runtime.sendMessage(
    { kind: 'send', payload: captured, note: $('note').value },
    function (reply) {
      if (chrome.runtime.lastError || !reply) {
        // Nothing typed is lost to a blip (§29.1): the note and the payload are
        // still on screen, and Send goes live again.
        $('send').disabled = false;
        return setStatus('The extension worker did not answer. Nothing was sent.', 'bad');
      }
      if (reply.error) {
        $('send').disabled = false;
        return setStatus(reply.message, 'bad');
      }
      setStatus('Sent. The assistant will get back to you.', 'ok');
      setTimeout(function () {
        window.close();
      }, 900);
    },
  );
}

/**
 * Pairing gates capture (§29.5): with no token stored, the payload could go
 * nowhere, so reading the page would put bytes on screen only to dead-end at
 * Send. Show the way to the options page instead, and never inject.
 */
function gate() {
  chrome.storage.local.get(['token'], function (stored) {
    if (stored && stored.token) return capture();
    ['meta', 'fields', 'preview', 'truncated', 'note', 'capture-actions'].forEach(
      function (id) {
        $(id).hidden = true;
      },
    );
    document.querySelector('.note-label').hidden = true;
    $('badge').textContent = 'not linked';
    $('pair').hidden = false;
  });
}

$('send').addEventListener('click', send);
$('cancel').addEventListener('click', function () {
  window.close();
});
$('open-options').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
  window.close();
});
// Ctrl/Cmd+Enter from the note field, because the whole interaction is
// "read it, say what you want, send" and reaching for the mouse breaks that.
$('note').addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('send').disabled) send();
});

gate();
