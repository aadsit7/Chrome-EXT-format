'use strict';

/* Sales Quote Generator — "Speak to fill" (voice input)

   A microphone toggle that dictates the quote instead of typing it. Speech is
   transcribed with the browser's Web Speech API (runs in the side panel; uses
   the browser's standard microphone prompt — no new extension permissions).

   The flow is deliberately two-step so a misheard product name or number is
   never lost:
     1. LISTEN — a "Listening…" indicator and a live, updating transcript
        (interim + final) are shown while the recognizer runs; a Stop button
        ends it. The recognizer is continuous, returns interim results, and
        listens in en-US.
     2. CONFIRM — when the user stops (or speech ends) the words are NOT sent
        anywhere. Instead the final transcript is shown in an EDITABLE text box
        ("Here's what I heard — fix anything, then fill") with "Fill from this"
        and "Cancel". Only "Fill from this" hands the (possibly edited) text to
        the SAME advanced AI analysis used by "Analyze this page"
        (SQG_ANALYZE.fillFromText), whose structured result still flows through
        the review card. So the user gets two chances to catch a mistake:
        the transcript edit and the review-card preview. Nothing is written
        until Apply, and the pricing engine still computes every total.

   Relies on globals defined in app.js (state, render, flash, h, dsButton) and
   on SQG_ANALYZE.fillFromText (analyze.js). This file is loaded after
   analyze.js / sheets.js and before app.js; its functions only touch those
   globals when called (well after everything has initialised). */

window.SQG_VOICE = (function () {
  // Web Speech API (Chrome exposes it as webkitSpeechRecognition).
  var Rec = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);

  var recog = null;    // the active SpeechRecognition instance, or null
  var finalText = '';  // accumulated final transcript for the current session

  var SVG_MIC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
  var SVG_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>';

  function supported() { return !!Rec; }

  function setVoice(patch) {
    state.voice = Object.assign({ on: false, interim: '', finalText: '', error: '', heard: '' }, state.voice || {}, patch || {});
    render();
  }

  /* The combined transcript (final words + whatever's mid-utterance). */
  function transcript() {
    var interim = (state.voice && state.voice.interim) || '';
    return (finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
  }

  /* Stop listening. Instead of auto-sending, capture what was heard into
     state.voice.heard so the editable confirmation box is shown — the user
     confirms (and can correct) before anything reaches the AI. */
  function stop() {
    var wasOn = !!(state.voice && state.voice.on);
    var text = transcript();
    if (recog) { try { recog.onend = null; recog.onerror = null; recog.stop(); } catch (e) {} recog = null; }
    if (!wasOn) { setVoice({ on: false, interim: '' }); return; }
    if (!text) {
      // Never leave the button stuck in "listening"; nothing to confirm.
      setVoice({ on: false, interim: '', heard: '' });
      flash('Didn’t catch anything — tap the microphone and try again', 'warn');
      return;
    }
    setVoice({ on: false, interim: '', heard: text });
  }

  function start() {
    if (!supported()) { flash('Voice input isn’t supported in this browser', 'warn'); return; }
    if (recog) return; // already listening
    if (state.analyze) { state.analyze = null; } // clear any prior review card first
    finalText = '';
    try {
      recog = new Rec();
      recog.lang = 'en-US';
      recog.continuous = true;      // keep listening until the user taps stop
      recog.interimResults = true;  // show words as they're recognised

      recog.onresult = function (ev) {
        var interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var r = ev.results[i];
          var t = (r[0] && r[0].transcript) ? r[0].transcript : '';
          if (r.isFinal) finalText = (finalText + ' ' + t).replace(/\s+/g, ' ').trim();
          else interim += t;
        }
        setVoice({ on: true, interim: interim.replace(/\s+/g, ' ').trim(), finalText: finalText });
      };

      recog.onerror = function (ev) {
        var code = ev && ev.error;
        var msg = code === 'not-allowed' || code === 'service-not-allowed'
            ? 'Microphone blocked — allow mic access for the extension and try again'
          : code === 'no-speech' ? 'Didn’t hear anything — tap the microphone and try again'
          : code === 'audio-capture' ? 'No microphone found — check your mic and try again'
          : 'Voice input error — try again';
        recog = null;
        // Reset the button — never leave it stuck in "listening" — and clear any
        // half-heard confirmation box.
        setVoice({ on: false, interim: '', heard: '', error: msg });
        flash(msg, 'warn');
      };

      recog.onend = function () {
        // Fired when the service ends on its own (timeout / silence). If we were
        // still "on", finalise into the editable confirmation box (never auto-send).
        recog = null;
        if (state.voice && state.voice.on) stop();
      };

      setVoice({ on: true, interim: '', finalText: '', error: '', heard: '' });
      recog.start();
      flash('Listening… say the customer, contact, email, products and term', 'ok');
    } catch (e) {
      recog = null;
      setVoice({ on: false });
      flash('Couldn’t start the microphone — try again', 'warn');
    }
  }

  function toggle() {
    if (state.voice && state.voice.on) stop();
    else start();
  }

  /* Confirm step: hand the (possibly edited) transcript to the shared AI
     analysis. Clears the confirmation box first so the review card can take
     over. */
  function fillFromReview(text) {
    text = (text == null ? '' : String(text)).replace(/\s+/g, ' ').trim();
    setVoice({ on: false, interim: '', heard: '' });
    if (!text) { flash('Nothing to fill from — tap the microphone and try again', 'warn'); return; }
    if (window.SQG_ANALYZE && typeof window.SQG_ANALYZE.fillFromText === 'function') {
      window.SQG_ANALYZE.fillFromText(text, 'voice');
    } else {
      flash('Voice fill isn’t available right now', 'warn');
    }
  }

  function cancelReview() {
    setVoice({ on: false, interim: '', heard: '' });
  }

  /* The mic toggle button (rendered by analyze.js bar()). Hidden entirely when
     the browser has no Web Speech API, so there's never a dead control. */
  function button() {
    if (!supported()) return null;
    var on = !!(state.voice && state.voice.on);
    var btn = h('button', {
      class: 'sqg-mic-btn' + (on ? ' listening' : ''), type: 'button',
      title: on ? 'Stop listening and review what you said' : 'Speak to fill the quote form (uses your browser’s speech recognition)',
      'aria-pressed': on ? 'true' : 'false', onClick: toggle,
    });
    var ico = h('span', { class: 'sqg-mic-ico' });
    ico.innerHTML = on ? SVG_STOP : SVG_MIC;
    btn.append(ico, h('span', null, on ? 'Listening — tap to stop' : 'Speak to fill'));
    return btn;
  }

  /* A live strip shown under the buttons WHILE listening, echoing the words so
     the user can see they're being heard (interim + final). */
  function liveStrip() {
    if (!(state.voice && state.voice.on)) return null;
    var txt = transcript();
    return h('div', { class: 'sqg-voice-live' },
      h('span', { class: 'sqg-voice-dot' }),
      h('div', { class: 'sqg-voice-live-texts' },
        h('span', { class: 'sqg-voice-live-label' }, 'Listening…'),
        h('span', { class: 'sqg-voice-text' }, txt || 'Say the customer, contact, email, products and term.')
      ));
  }

  /* The editable confirmation box shown AFTER listening stops. The user can fix
     a misheard product name or number, then "Fill from this" sends it to the AI
     (which still previews the parsed result in the review card). "Cancel"
     discards it. Not shown while listening or when there's nothing heard. */
  function reviewBox() {
    var v = state.voice || {};
    if (v.on || !v.heard) return null;
    var ta = h('textarea', {
      class: 'sqg-voice-review-ta', dataK: 'sqg-voice-review', rows: 3,
      'aria-label': 'What we heard — edit before filling', spellcheck: 'true',
      value: v.heard,
      // Keep state in sync silently (no re-render) so edits survive an
      // incidental re-render (e.g. a toast clearing) via render()'s focus restore.
      onInput: function (e) { if (state.voice) state.voice.heard = e.target.value; },
    });
    return h('div', { class: 'sqg-voice-review' },
      h('span', { class: 'sqg-voice-review-title' }, 'Here’s what I heard — fix anything, then fill'),
      ta,
      h('p', { class: 'sqg-voice-review-note' },
        'Dictation uses your browser’s built-in speech recognition. Edit the text above if a product name or number was misheard, then fill.'),
      h('div', { class: 'sqg-voice-review-actions' },
        dsButton('Cancel', 'secondary', 'md', false, cancelReview),
        dsButton('Fill from this', 'primary', 'md', false, function () { fillFromReview(ta.value); })
      ));
  }

  return {
    button: button, liveStrip: liveStrip, reviewBox: reviewBox, toggle: toggle, supported: supported,
    _start: start, _stop: stop, _transcript: transcript, _fillFromReview: fillFromReview,
  };
})();
