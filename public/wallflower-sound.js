// Wallflower — sound
//
// Loads alongside wallflower.js on the scenes template. Separate file because
// the game script is closed: the only thing it does is dispatch three events,
// which this listens for.
//
// Two kinds of sound:
//
//   UI       synthesised here with the Web Audio API — a few oscillators and an
//            envelope each. No files to host, nothing to license, and they suit
//            flat vector art better than recorded samples would. Tunable by
//            changing two numbers rather than re-cutting audio.
//
//   Ambience one looping track per scene, from [data-scene-audio] in the CMS.
//            Birdsong and harbour water cannot be synthesised convincingly, so
//            these are real files. Silent until a URL is present.
//
// Preferences live in member JSON under `sound`, so they follow the member
// rather than the browser.
//
// Browsers block audio until the page is interacted with. Nothing plays before
// the first click, and the ambience starts on that click rather than on load —
// autoplay would be refused and leave the panel showing music as on while
// nothing was audible.

(function () {
  'use strict';

  var KEYS = ['music', 'choose', 'hide', 'hit', 'miss'];

  var prefs = { music: true, choose: true, hide: true, hit: true, miss: true };
  var ctx = null;
  var ambience = null;
  var started = false;

  function one(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function all(selector, scope) {
    return [].slice.call((scope || document).querySelectorAll(selector));
  }

  function ms() {
    return window.$memberstackDom || null;
  }

  // -------------------------------------------------------------------------
  // Synthesis
  //
  // Every sound is an oscillator through a gain envelope. Attack is kept very
  // short and release long enough to avoid a click — a hard cutoff on a sine
  // wave is itself an audible pop.
  // -------------------------------------------------------------------------

  function audio() {
    if (!ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }

    // Suspended until a gesture resumes it; harmless to call repeatedly.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(opts) {
    var c = audio();
    if (!c) return;

    var osc = c.createOscillator();
    var gain = c.createGain();

    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.from, c.currentTime);

    if (opts.to) {
      osc.frequency.exponentialRampToValueAtTime(opts.to, c.currentTime + opts.length);
    }

    var peak = opts.volume || 0.15;
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + opts.length);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(c.currentTime + (opts.delay || 0));
    osc.stop(c.currentTime + opts.length + (opts.delay || 0) + 0.02);
  }

  // A short filtered noise burst — the wooden part of a knock, which a pure
  // oscillator cannot give you.
  function knock(volume) {
    var c = audio();
    if (!c) return;

    var length = 0.06;
    var buffer = c.createBuffer(1, c.sampleRate * length, c.sampleRate);
    var data = buffer.getChannelData(0);

    for (var i = 0; i < data.length; i++) {
      // Decaying noise, steep enough to read as a tap rather than a hiss.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    }

    var source = c.createBufferSource();
    source.buffer = buffer;

    var filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 1.2;

    var gain = c.createGain();
    gain.gain.value = volume || 0.2;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    source.start();
  }

  var sounds = {
    // Picking an avatar or a scene: a soft round bubble-pop. It bends upward and
    // sits high, which is most of what reads as cute — the old wooden knock,
    // low and thudding, was the part that did not. Three quick ascending notes
    // give it a bounce; kept quiet so clicking through the grid patters lightly
    // rather than chirping.
    choose: function () {
      tone({ from: 560, to: 960, length: 0.1, volume: 0.07, type: 'sine' });
      tone({ from: 1180, length: 0.05, volume: 0.035, type: 'sine', delay: 0.05 });
      tone({ from: 1560, length: 0.05, volume: 0.03, type: 'sine', delay: 0.1 });
    },

    // Committing a hide: lower and longer, a settling rather than a tap.
    hide: function () {
      tone({ from: 260, to: 150, length: 0.34, volume: 0.14, type: 'sine' });
      tone({ from: 130, to: 96, length: 0.42, volume: 0.09, type: 'sine', delay: 0.04 });
    },

    // Finding someone: two rising notes. The only sound in the game that goes
    // up, so it reads as the good outcome without needing to be loud.
    hit: function () {
      tone({ from: 523, length: 0.16, volume: 0.13, type: 'triangle' });
      tone({ from: 784, length: 0.3, volume: 0.12, type: 'triangle', delay: 0.11 });
    },

    // Missing: flat and muted, deliberately not a buzzer. A wrong call is the
    // expected case in a scene full of painted people, so it should read as
    // "no", not as a penalty.
    miss: function () {
      tone({ from: 190, to: 150, length: 0.2, volume: 0.1, type: 'sine' });
    },
  };

  // Ambience volume, and how far it drops while a UI sound plays.
  var MUSIC_LEVEL = 0.28;
  var DUCK_LEVEL = 0.09;
  var duckTimer = null;

  // Drops the music under a UI sound, then brings it back.
  //
  // Without this the two compete: the ambience sits in the same low register as
  // the hide and miss tones, so a short cue at a comparable level reads as part
  // of the track rather than as a response to something the member did. Ducking
  // is what makes a UI sound land without needing to be loud.
  function duck() {
    if (!ambience || ambience.paused) return;

    ambience.volume = DUCK_LEVEL;
    clearTimeout(duckTimer);

    // Eased back rather than snapped, so the recovery is not itself a noise.
    duckTimer = setTimeout(function () {
      if (!ambience) return;

      var step = 0;
      var back = setInterval(function () {
        step++;
        if (!ambience || step >= 12) {
          if (ambience) ambience.volume = MUSIC_LEVEL;
          clearInterval(back);
          return;
        }
        ambience.volume = DUCK_LEVEL + (MUSIC_LEVEL - DUCK_LEVEL) * (step / 12);
      }, 40);
    }, 260);
  }

  function play(key) {
    // Nothing sounds until the button has been pressed — a UI sound firing
    // while the button shows muted would contradict what the member sees.
    if (!started || !prefs[key] || !sounds[key]) return;

    try {
      duck();
      sounds[key]();
    } catch (err) {
      // A sound failing must never interrupt the thing it was decorating.
    }
  }

  // -------------------------------------------------------------------------
  // Ambience
  //
  // Position is kept per scene in sessionStorage. Switching tabs is a full page
  // load, and every commit, call and dismissal reloads too — restarting the
  // track each time would mean hearing the same opening bars constantly. A
  // different scene is a different track, so it starts fresh on its own.
  // -------------------------------------------------------------------------

  function sceneSlug() {
    var node = one('[data-scene-slug]');
    return node ? node.textContent.trim() : '';
  }

  function ambienceUrl() {
    var node = one('[data-scene-audio]');
    if (!node) return null;

    var url = node.getAttribute('href') || node.textContent.trim();
    return url && url.indexOf('http') === 0 ? url : null;
  }

  function positionKey() {
    return 'wallflower:audio:' + sceneSlug();
  }

  function startAmbience() {
    var url = ambienceUrl();
    if (!url || ambience) return;

    ambience = new Audio(url);
    ambience.loop = true;
    ambience.volume = MUSIC_LEVEL; // under the UI sounds; a background, not a track

    try {
      var at = parseFloat(sessionStorage.getItem(positionKey()));
      if (at > 0) ambience.currentTime = at;
    } catch (err) {
      // Private browsing can refuse sessionStorage. Start from zero.
    }

    // Remember where it got to, so a reload resumes rather than restarts.
    setInterval(function () {
      if (!ambience || ambience.paused) return;
      try {
        sessionStorage.setItem(positionKey(), String(ambience.currentTime));
      } catch (err) {}
    }, 2000);

    if (prefs.music) {
      ambience.play().catch(function () {
        // Refused despite the session flag. Fall back to muted so the button
        // tells the truth rather than claiming sound is running.
        started = false;
        markEngaged(false);
        paintButton();
      });
    }
  }

  function applyMusicPref() {
    if (!ambience) {
      if (prefs.music) startAmbience();
      return;
    }

    if (prefs.music) ambience.play().catch(function () {});
    else ambience.pause();
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  async function loadPrefs() {
    var api = ms();
    if (!api) return;

    try {
      var result = await api.getMemberJSON();
      var saved = ((result && result.data) || {}).sound;
      if (!saved) return;

      KEYS.forEach(function (key) {
        if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
      });
    } catch (err) {
      // Defaults are all on; a failed read costs nothing.
    }
  }

  async function savePrefs() {
    var api = ms();
    if (!api) return;

    try {
      // Read, merge, write. updateMemberJSON replaces wholesale, so writing
      // only `sound` would drop the chosen avatar and scene.
      var current = await api.getMemberJSON();
      var next = (current && current.data) || {};
      next.sound = prefs;
      await api.updateMemberJSON({ json: next });
    } catch (err) {
      console.error('Wallflower: could not save sound preferences', err);
    }
  }

  function paintPrefs() {
    all('[data-sound-row]').forEach(function (row) {
      var toggle = one('[data-sound-toggle]', row);
      if (toggle) toggle.classList.toggle('is-off', !prefs[row.dataset.soundRow]);
    });

    var allOn = KEYS.every(function (key) {
      return prefs[key];
    });

    var control = one('[data-sound-all]');
    if (control) control.textContent = allOn ? 'mute all' : 'turn all on';
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wirePanel() {
    all('[data-sound-row]').forEach(function (row) {
      row.addEventListener('click', function () {
        var key = row.dataset.soundRow;
        prefs[key] = !prefs[key];
        paintPrefs();
        savePrefs();

        if (key === 'music') applyMusicPref();
        else play(key); // hear what you just turned on
      });
    });

    var muteAll = one('[data-sound-all]');
    if (muteAll) {
      muteAll.addEventListener('click', function () {
        var allOn = KEYS.every(function (key) {
          return prefs[key];
        });

        KEYS.forEach(function (key) {
          prefs[key] = !allOn;
        });

        paintPrefs();
        savePrefs();
        applyMusicPref();
      });
    }
  }

  function closeAccount() {
    var menu = one('[data-account-menu]');
    if (menu) menu.style.display = 'none';
  }

  function wireAccount() {
    var face = one('[data-face]');
    var menu = one('[data-account-menu]');
    if (!face || !menu) return;

    face.style.cursor = 'pointer';

    face.addEventListener('click', function (event) {
      event.stopPropagation();
      var open = menu.style.display === 'flex';
      menu.style.display = open ? 'none' : 'flex';

      var panel = one('[data-sound-panel]');
      if (panel) panel.style.display = 'none';

      var button = one('[data-mute]');
      if (button) button.classList.remove('is-open');
    });

    // Logging out should not leave the next member listening to this one's
    // scene, or resuming their position.
    var logout = one('[data-logout]');
    if (logout) {
      logout.addEventListener('click', function () {
        try {
          sessionStorage.removeItem(positionKey());
        } catch (err) {}
        if (ambience) ambience.pause();
      });
    }

    document.addEventListener('click', function () {
      closeAccount();
      var panel = one('[data-sound-panel]');
      if (panel) panel.style.display = 'none';
      var button = one('[data-mute]');
      if (button) button.classList.remove('is-open');
    });

    [menu, one('[data-sound-panel]')].forEach(function (node) {
      if (node) node.addEventListener('click', function (event) {
        event.stopPropagation();
      });
    });
  }

  async function fillAccount() {
    var api = ms();
    if (!api) return;

    try {
      var member = await api.getCurrentMember();
      var fields = (member && member.data && member.data.customFields) || {};
      var name = one('[data-account-name]');
      if (name) name.textContent = fields['user-name'] || 'you';

      // The status pill already works this out; reusing its text keeps the two
      // from disagreeing.
      var status = one('[data-status-title]');
      var state = one('[data-account-state]');
      if (status && state) state.textContent = status.textContent.toLowerCase();
    } catch (err) {}
  }

  // The game script dispatches these. Nothing else couples the two files.
  function wireEvents() {
    ['hide', 'hit', 'miss', 'choose'].forEach(function (key) {
      document.addEventListener('wallflower:' + key, function () {
        // A pick doubles as the gesture that turns sound on. The picker screens
        // have no ambient music and picking is the only interaction, so gating
        // the pop behind a separate sound-button press just meant the first few
        // picks were silent. `choose` is dispatched synchronously inside the
        // tile's click handler, so enabling audio here is still within a
        // gesture and the browser allows it. hit/miss/hide are not self-
        // enabling: they follow an async write, are off-gesture, and belong to
        // the scene where the sound button is the deliberate switch.
        if (key === 'choose' && !started) startSound();
        play(key);
      });
    });
  }

  // Browsers refuse audio until the page has been interacted with. That cannot
  // be bypassed — but rather than hiding it behind "click anywhere and music
  // appears", the sound button is the gesture. It shows muted until pressed,
  // and pressing it both grants permission and turns sound on. What the button
  // shows is then always the truth.
  //
  // Once sound has run, a session flag lets later pages start immediately:
  // every scene visit is a full page load, and asking for a click each time
  // would be worse than asking once.
  var ENGAGED = 'wallflower:audio-engaged';

  function markEngaged(on) {
    try {
      if (on) sessionStorage.setItem(ENGAGED, '1');
      else sessionStorage.removeItem(ENGAGED);
    } catch (err) {}
  }

  function wasEngaged() {
    try {
      return sessionStorage.getItem(ENGAGED) === '1';
    } catch (err) {
      return false;
    }
  }

  // Sound is off until the button says otherwise. `started` means audio is
  // actually permitted and running, not merely that preferences allow it.
  function paintButton() {
    var button = one('[data-mute]');
    if (button) button.classList.toggle('is-muted', !started);
  }

  function startSound() {
    started = true;
    markEngaged(true);
    audio();
    if (prefs.music) startAmbience();
    paintButton();
  }

  function stopSound() {
    started = false;
    markEngaged(false);
    if (ambience) ambience.pause();
    paintButton();
  }

  // On the picker pages the button is the whole control — one sound, no panel.
  // On a scene it opens the panel once sound is on, since there are four
  // things to control and a popover is the only way to reach them.
  function wireButton() {
    var button = one('[data-mute]');
    if (!button) return;

    var panel = one('[data-sound-panel]');

    button.addEventListener('click', function (event) {
      event.stopPropagation();

      if (!started) {
        startSound();
        return;
      }

      if (!panel) {
        // No panel here, so the button is a plain mute toggle.
        stopSound();
        return;
      }

      var open = panel.style.display === 'flex';
      panel.style.display = open ? 'none' : 'flex';
      button.classList.toggle('is-open', !open);
      closeAccount();
    });

    // Carried over from earlier in the session, so no click needed here.
    //
    // Only the ambience is resumed — it is an <audio> element, whose autoplay a
    // browser will allow once the site has media engagement. The AudioContext
    // used for the UI sounds is not created here: a fresh page load has had no
    // gesture yet, and creating it now only earns a console warning while the
    // context stays suspended. It is created lazily on the first UI sound, which
    // is always a click.
    if (wasEngaged() && prefs.music) {
      started = true;
      startAmbience();
    }

    paintButton();
  }

  async function start() {
    await loadPrefs();
    paintPrefs();
    wireButton();
    wirePanel();
    wireAccount();
    wireEvents();
    fillAccount();
  }

  document.addEventListener('DOMContentLoaded', start);
})();
