'use strict';

/* Sales Quote Generator — "Speak to fill" (voice input)

   A microphone toggle that dictates the quote instead of typing it. Speech is
   transcribed with the browser's Web Speech API (runs in the side panel; uses
   the browser's standard microphone prompt — no new extension permissions), and
   the finished transcript is handed to the SAME advanced AI analysis used by
   "Analyze this page": SQG_ANALYZE.fillFromText() POSTs the words to the Apps
   Script, which returns structured fields (customer, contact, email, products,
   term, currency, addresses, …). Those are shown in the existing review card so
   the user previews everything before a single field is filled — nothing is
   written until Apply, and the pricing engine still computes every total.

   Relies on globals defined in app.js (state, render, flash, h) and on
   SQG_ANALYZE.fillFromText (analyze.js). This file is loaded after analyze.js /
   sheets.js and before app.js; its functions only touch those globals when
   called (well after everything has initialised). */

window.SQG_VOICE = (function () {
  // Web Speech API (Chrome exposes it as webkitSpeechRecognition).
  var Rec = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);

  var recog = null;    // the active SpeechRecognition instance, or null
  var finalText = '';  // accumulated final transcript for the current session

  var SVG_MIC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
  var SVG_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>';

  function supported() { return !!Rec; }

  function setVoice(patch) {
    state.voice = Object.assign({ on: false, interim: '', finalText: '', error: '' }, state.voice || {}, patch || {});
    render();
  }

  /* The combined transcript (final words + whatever's mid-utterance). */
  function transcript() {
    var interim = (state.voice && state.voice.interim) || '';
    return (finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
  }

  /* Stop listening. When sendIt is true and we heard something, hand the words
     to the shared AI analysis; otherwise just close down quietly. */
  function stop(sendIt) {
    var wasOn = !!(state.voice && state.voice.on);
    var text = transcript();
    if (recog) { try { recog.onend = null; recog.onerror = null; recog.stop(); } catch (e) {} recog = null; }
    setVoice({ on: false, interim: '' });
    if (!sendIt || !wasOn) return;
    if (!text) { flash('Didn’t catch anything — tap the microphone and try again', 'warn'); return; }
    if (window.SQG_ANALYZE && typeof window.SQG_ANALYZE.fillFromText === 'function') {
      window.SQG_ANALYZE.fillFromText(text, 'voice');
    } else {
      flash('Voice fill isn’t available right now', 'warn');
    }
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
        setVoice({ on: false, interim: '', error: msg });
        flash(msg, 'warn');
      };

      recog.onend = function () {
        // Fired when the service ends on its own (timeout / silence). If we were
        // still "on", finalise and send what we heard.
        recog = null;
        if (state.voice && state.voice.on) stop(true);
      };

      setVoice({ on: true, interim: '', finalText: '', error: '' });
      recog.start();
      flash('Listening… say the customer, contact, email, products and term', 'ok');
    } catch (e) {
      recog = null;
      setVoice({ on: false });
      flash('Couldn’t start the microphone — try again', 'warn');
    }
  }

  function toggle() {
    if (state.voice && state.voice.on) stop(true);
    else start();
  }

  /* The mic toggle button (rendered by analyze.js bar()). Hidden entirely when
     the browser has no Web Speech API, so there's never a dead control. */
  function button() {
    if (!supported()) return null;
    var on = !!(state.voice && state.voice.on);
    var btn = h('button', {
      class: 'sqg-mic-btn' + (on ? ' listening' : ''), type: 'button',
      title: on ? 'Stop and fill the form from what you said' : 'Speak to fill the quote form',
      'aria-pressed': on ? 'true' : 'false', onClick: toggle,
    });
    var ico = h('span', { class: 'sqg-mic-ico' });
    ico.innerHTML = on ? SVG_STOP : SVG_MIC;
    btn.append(ico, h('span', null, on ? 'Listening — tap to fill' : 'Speak to fill'));
    return btn;
  }

  /* A live strip shown under the buttons while listening, echoing the words so
     the user can see they're being heard. */
  function liveStrip() {
    if (!(state.voice && state.voice.on)) return null;
    var txt = transcript();
    return h('div', { class: 'sqg-voice-live' },
      h('span', { class: 'sqg-voice-dot' }),
      h('span', { class: 'sqg-voice-text' }, txt || 'Listening…'));
  }

  return {
    button: button, liveStrip: liveStrip, toggle: toggle, supported: supported,
    _start: start, _stop: stop, _transcript: transcript,
  };
})();
