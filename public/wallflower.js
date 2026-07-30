// Wallflower — scenes template (/scenes/[slug])
//
// One file. Previously three (leaderboard, playground, hide mode) which shared
// globals and depended on paste order in the page footer; a stale copy of any
// one of them failed silently. Nothing leaks now except the spot-modal seam.
//
// Two modes, one page. The mode follows the data rather than a button:
//   no live hide, and this is the scene you chose  → hide mode
//   anything else                                  → playground
//
// Where the data comes from
// ------------------------
// Webflow CMS, already in the DOM, no requests:
//   [data-scene-slug]    current scene slug
//   [data-crowd-height]  starting figure size, percent of scene height
//   [data-scene-img]     the scene image
//   [data-avatar-entry]  hidden Avatars list — slug, front, back, crop
//
// Memberstack, one read pass:
//   hides + spots → placed players, durations, counts, calls left
//   member JSON   → which avatar and which scene you chose
//
// Rules are derived, never stored. A hide is live until a spot references it;
// calls left is 3 minus your spots this hour; cooldown is your last miss plus
// ten minutes. Server-set createdAt carries all of it, so none is forgeable.

(function () {
  'use strict';

  var PAGE_SIZE = 100; // Memberstack caps `take` at 100
  var SPOTS_PER_HOUR = 3;
  var MISS_COOLDOWN_MS = 10 * 60 * 1000;
  var RELOCATE_WINDOW_MS = 24 * 60 * 60 * 1000;
  var SAMPLE_BOX = 24; // px square sampled behind the figure

  var sceneSlug = '';
  var crowdHeight = 12;
  var avatars = {}; // slug -> { front, back, crop }
  var sceneCounts = {};
  var selectedScene = null;
  var statusTimer = null;
  var sceneBitmap = null;
  var avatarTones = {};
  var currentAvatar = null;

  // Hide-mode state. The blend written here is the blend renderFigures reads
  // back off committed hides, so the keys are the stored contract.
  var blend = {
    facing: 'front',
    cutOff: 0,
    cutTop: 0,
    cutSide: 0,
    size: 1,
    mirror: false,
    tint: null, // sampled ambient, kept for the match meter only
  };

  // Percent of the scroller, not the viewport — which is why x/y are DECIMAL.
  var position = { x: 50, y: 60 };

  // -------------------------------------------------------------------------
  // DOM helpers
  //
  // Every lookup is by data attribute. Classes are presentation — if one gets
  // renamed in the Designer the styling changes, and the script should not.
  // -------------------------------------------------------------------------

  function one(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function all(selector, scope) {
    return [].slice.call((scope || document).querySelectorAll(selector));
  }

  function setText(selector, value, scope) {
    var node = one(selector, scope);
    if (node) node.textContent = value;
  }

  function textOf(selector) {
    var node = one(selector);
    return node ? node.textContent.trim() : '';
  }

  function ms() {
    return window.$memberstackDom || null;
  }

  // getCurrentMember() does not carry JSON — it has its own getter. Reading
  // `member.json` yields undefined and silently loses the chosen scene.
  async function memberJson(api) {
    try {
      var result = await api.getMemberJSON();
      return (result && result.data) || {};
    } catch (err) {
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  // Walks a whole table. `skip` advances by rows actually returned and the loop
  // ends on the first short page.
  //
  // Sorted ascending by creation deliberately: skip-based pagination reads a
  // moving target, and in a live game rows are inserted mid-walk. A descending
  // or default sort pushes existing rows onto later pages, so the walk both
  // repeats and misses records. Ascending pins the order — new rows land after
  // the point already read. A row created mid-pass is missed and picked up next
  // refresh, which is far better than double-counting.
  async function fetchAll(table, where) {
    var api = ms();
    var out = [];
    var seen = {};
    var skip = 0;
    var page = [];

    do {
      // No orderBy. It is not reliably supported by queryDataRecords and a
      // rejected sort came back as an empty page rather than an error — which
      // read as "no hides exist" while rows were sitting in the table.
      //
      // Sorting ascending by creation was there to stop skip-based pagination
      // reading a moving target: rows inserted mid-walk shift existing rows onto
      // later pages, so the walk repeats and misses records. Without the sort,
      // that protection comes from de-duplicating on id instead.
      var query = { take: PAGE_SIZE, skip: skip };
      if (where && Object.keys(where).length) query.where = where;

      var result = await api.queryDataRecords({ table: table, query: query });

      page = (result && result.data && result.data.records) || [];

      page.forEach(function (row) {
        if (seen[row.id]) return;
        seen[row.id] = true;
        out.push(row);
      });

      skip += page.length;
    } while (page.length === PAGE_SIZE);

    return out;
  }

  function parseBlendJson(raw) {
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch (err) {
      // A malformed blend costs that one figure its styling, not the whole page.
      return {};
    }
  }

  function formatDuration(msTotal) {
    var minutes = Math.floor(msTotal / 60000);
    return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
  }

  // Ranking and placement in one pass, so the board, the tab counts and the
  // figures can never disagree about who is still hidden.
  async function loadHides() {
    var results = await Promise.all([
      fetchAll('hides', {}),
      fetchAll('spots', { result: { equals: 'hit' } }),
    ]);

    var hides = results[0];
    var hits = results[1];

    var endedAt = {};
    hits.forEach(function (spot) {
      var ref = spot.data && spot.data.hide;
      var id = ref && (ref.id || ref);
      if (id) endedAt[id] = spot.createdAt;
    });

    var now = Date.now();

    return hides
      .map(function (hide) {
        var data = hide.data || {};
        var start = new Date(hide.createdAt).getTime();
        var end = endedAt[hide.id] ? new Date(endedAt[hide.id]).getTime() : now;

        return {
          hideId: hide.id,
          memberId: hide.createdByMemberId,
          createdAt: hide.createdAt,
          username: data.username,
          sceneId: data.scene_id,
          avatarId: data.avatar_id,
          x: typeof data.x === 'number' ? data.x : parseFloat(data.x) || 0,
          y: typeof data.y === 'number' ? data.y : parseFloat(data.y) || 0,
          facing: data.facing || 'front',
          blend: parseBlendJson(data.blend),
          durationMs: end - start,
          stillHidden: !endedAt[hide.id],
        };
      })
      .sort(function (a, b) {
        return b.durationMs - a.durationMs;
      });
  }

  function readAvatarLookup() {
    all('[data-avatar-entry]').forEach(function (entry) {
      var slugNode = one('[data-slug]', entry);
      if (!slugNode) return;

      var slug = slugNode.textContent.trim();
      if (!slug) return;

      avatars[slug] = {
        front: imageUrl(one('[data-front]', entry)),
        back: imageUrl(one('[data-back]', entry)),
        crop: imageUrl(one('[data-crop]', entry)),
      };
    });

    if (!Object.keys(avatars).length) {
      console.error('Wallflower: avatar lookup empty — check the hidden Avatars list renders');
    }
  }

  // Webflow lazy-loads CMS images and renders both src and srcset. In a hidden
  // subtree src can be empty, so fall back through every source the element
  // carries before giving up.
  function imageUrl(node) {
    if (!node) return null;

    var direct = node.getAttribute('src');
    if (direct) return direct;

    if (node.currentSrc) return node.currentSrc;

    var set = node.getAttribute('srcset');
    if (!set) return null;

    return set.split(',')[0].trim().split(/\s+/)[0] || null;
  }

  // -------------------------------------------------------------------------
  // Placed players
  //
  // Only real players are DOM nodes — the crowd is painted into the image. So
  // figures must not be click targets: a cursor change or a hover outline would
  // reveal every player at once. pointer-events: none on the figure, and the
  // scroller takes the click.
  // -------------------------------------------------------------------------

  function renderFigures(hides) {
    var scroller = one('[data-scroller]');
    var template = one('[data-figure-template]');
    if (!scroller || !template) return;

    all('[data-figure]:not([data-figure-template]):not([data-placing])', scroller).forEach(
      function (node) {
        node.remove();
      }
    );

    hides.forEach(function (hide) {
      if (hide.sceneId !== sceneSlug || !hide.stillHidden) return;

      var figure = template.cloneNode(true);
      figure.removeAttribute('data-figure-template');
      figure.removeAttribute('style');

      // The template is hidden by a class, not just the inline style it was
      // authored with, so clones must be shown explicitly.
      figure.style.display = 'block';
      figure.dataset.avatar = hide.avatarId || '';
      figure.dataset.hide = hide.hideId;

      // Percentages of the scroller, not the viewport — which is why the canvas
      // can be any size and why x/y are DECIMAL rather than integer.
      figure.style.left = hide.x + '%';
      figure.style.top = hide.y + '%';

      var image = one('[data-figure-img]', figure);
      if (image) applyBlend(figure, image, hide.blend);

      scroller.appendChild(figure);
    });
  }

  // -------------------------------------------------------------------------
  // Top bar
  // -------------------------------------------------------------------------

  function paintTabs() {
    all('[data-scene-tab]').forEach(function (tab) {
      var carrier = one('[data-slug]', tab);
      var slug = carrier ? carrier.textContent.trim() : '';

      // Webflow cannot compare a collection item to the current page, so the
      // active tab is settled here.
      tab.classList.toggle('is-active', slug === sceneSlug);

      var count = one('[data-tab-count]', tab);
      if (!count) return;

      count.textContent = sceneCounts[slug] || 0;

      // The count sets its own colour so it cannot inherit the active state's
      // paper text — on espresso it would be near invisible.
      count.classList.toggle('is-active-count', slug === sceneSlug);
    });
  }

  function paintHud(mySpots) {
    var recent = mySpots.filter(function (spot) {
      return Date.now() - new Date(spot.createdAt).getTime() < 60 * 60 * 1000;
    });

    var left = Math.max(0, SPOTS_PER_HOUR - recent.length);

    var lastMiss = mySpots
      .filter(function (spot) {
        return spot.data && spot.data.result === 'miss';
      })
      .map(function (spot) {
        return new Date(spot.createdAt).getTime();
      })
      .sort(function (a, b) {
        return b - a;
      })[0];

    var cooling = lastMiss && Date.now() - lastMiss < MISS_COOLDOWN_MS;

    if (cooling) {
      var mins = Math.ceil((MISS_COOLDOWN_MS - (Date.now() - lastMiss)) / 60000);
      setText('[data-calls-text]', 'locked out ' + mins + 'm');
    } else {
      setText('[data-calls-text]', left + (left === 1 ? ' call left' : ' calls left'));
    }

    var pill = one('[data-calls-left]');
    if (pill) pill.dataset.exhausted = left === 0 || cooling ? 'true' : 'false';

    return { left: left, cooling: cooling };
  }

  // The member's own crop comes from their `cropped-avatar-url` custom field,
  // which the avatar picker already wrote. The lookup is still needed for other
  // players and for full-body art.
  function paintFace(cropUrl, slug) {
    var url = cropUrl || (avatars[slug] && avatars[slug].crop);
    if (!url) return;

    ['[data-face]', '[data-status-face]'].forEach(function (selector) {
      var node = one(selector);
      if (node) node.style.backgroundImage = 'url("' + url + '")';
    });
  }

  // -------------------------------------------------------------------------
  // Status pill
  // -------------------------------------------------------------------------

  function setStatus(title, note) {
    var status = one('[data-status]');
    if (status) status.style.display = '';
    setText('[data-status-title]', title);
    setText('[data-status-timer]', note);
  }

  function setHint(text) {
    setText('[data-hint-text]', text);
  }

  // Ticks every 30s from a server-set timestamp, so neither a reload nor leaving
  // the tab open can inflate it.
  function runTimer(myHide) {
    clearInterval(statusTimer);

    function tick() {
      var elapsed = Date.now() - new Date(myHide.createdAt).getTime();
      setText('[data-status-timer]', formatDuration(elapsed) + ' unspotted');
    }

    setStatus('You are hidden in the ' + String(myHide.sceneId).replace(/-/g, ' '), '');
    tick();
    statusTimer = setInterval(tick, 30000);
  }

  // -------------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------------

  function paintBoard(ranked, memberId) {
    var list = one('[data-board-list]');
    var template = one('[data-board-row]');
    if (!list || !template) return;

    var blank = template.cloneNode(true);
    list.innerHTML = '';

    ranked.slice(0, 8).forEach(function (entry, index) {
      var row = blank.cloneNode(true);

      setText('[data-board-rank]', String(index + 1).padStart(2, '0'), row);
      setText('[data-board-name]', entry.username || 'someone', row);
      setText('[data-board-where]', String(entry.sceneId || '').replace(/-/g, ' '), row);
      setText('[data-board-time]', formatDuration(entry.durationMs), row);

      var face = one('[data-board-face]', row);
      var art = avatars[entry.avatarId];
      if (face && art && art.crop) face.style.backgroundImage = 'url("' + art.crop + '")';

      list.appendChild(row);
    });

    var mine = ranked.filter(function (entry) {
      return entry.memberId === memberId;
    })[0];

    var you = one('[data-board-you]');
    if (!you) return;

    if (!mine) {
      you.style.display = 'none';
      return;
    }

    you.style.display = '';

    setText('[data-you-rank]', String(ranked.indexOf(mine) + 1).padStart(2, '0'), you);
    setText('[data-you-name]', mine.username || 'you', you);
    setText(
      '[data-you-where]',
      String(mine.sceneId).replace(/-/g, ' ') + (mine.stillHidden ? ', still hidden' : ', found'),
      you
    );
    setText('[data-you-time]', formatDuration(mine.durationMs), you);

    var yourFace = one('[data-you-face]', you);
    var yourArt = avatars[mine.avatarId];
    if (yourFace && yourArt && yourArt.crop) {
      yourFace.style.backgroundImage = 'url("' + yourArt.crop + '")';
    }
  }

  // -------------------------------------------------------------------------
  // Scrollbar
  //
  // Custom because the canvas is the game surface and a native bar across the
  // bottom of a painted scene reads as a mistake.
  // -------------------------------------------------------------------------

  function wireScrollbar() {
    var canvas = one('[data-canvas]');
    var track = one('[data-scrollbar]');
    var thumb = one('[data-scrollbar-thumb]');
    if (!canvas || !track || !thumb) return;

    function paint() {
      var scrollable = canvas.scrollWidth - canvas.clientWidth;

      // Nothing to scroll: hide the control rather than show a full-width thumb
      // that cannot move.
      if (scrollable <= 0) {
        track.style.display = 'none';
        return;
      }

      track.style.display = '';
      var ratio = canvas.clientWidth / canvas.scrollWidth;
      thumb.style.width = ratio * 100 + '%';
      thumb.style.left = (canvas.scrollLeft / scrollable) * (100 - ratio * 100) + '%';
    }

    function dragTo(clientX) {
      var box = track.getBoundingClientRect();
      var at = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
      canvas.scrollLeft = at * (canvas.scrollWidth - canvas.clientWidth);
    }

    canvas.addEventListener('scroll', paint);
    window.addEventListener('resize', paint);

    track.addEventListener('pointerdown', function (event) {
      dragTo(event.clientX);
      try {
        track.setPointerCapture(event.pointerId);
      } catch (err) {}
    });

    track.addEventListener('pointermove', function (event) {
      if (track.hasPointerCapture && track.hasPointerCapture(event.pointerId)) dragTo(event.clientX);
    });

    paint();
  }

  // -------------------------------------------------------------------------
  // Spotting
  //
  // Every click opens the modal, including one that hit nothing — offering it
  // only over real players would reveal where they are. openSpotModal is the
  // seam for artboard 06, which is not built yet.
  // -------------------------------------------------------------------------

  function wireSpotting() {
    var scroller = one('[data-scroller]');
    if (!scroller) return;

    scroller.addEventListener('click', function (event) {
      if (one('[data-placing]')) return; // placing yourself, not hunting

      var box = scroller.getBoundingClientRect();
      var hit = null;

      all('[data-figure]:not([data-figure-template])', scroller).forEach(function (figure) {
        var f = figure.getBoundingClientRect();
        if (
          event.clientX >= f.left &&
          event.clientX <= f.right &&
          event.clientY >= f.top &&
          event.clientY <= f.bottom
        ) {
          hit = figure.dataset.hide;
        }
      });

      if (typeof window.openSpotModal === 'function') {
        window.openSpotModal({
          x: ((event.clientX - box.left) / box.width) * 100,
          y: ((event.clientY - box.top) / box.height) * 100,
          hideId: hit,
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Scene sampling
  // -------------------------------------------------------------------------

  function showBoard() {
    var board = one('[data-board]');
    var panel = one('[data-blend-panel]');
    if (board) board.classList.remove('is-gone');
    if (panel) panel.classList.remove('is-shown');
  }

  // crossOrigin must be set before src or it has no effect. A tainted bitmap
  // looks loaded but every sample throws, so readability is verified here rather
  // than discovered later as silently grey output.
  function loadScene() {
    var source = one('[data-scene-img]');
    if (!source) {
      console.error('Wallflower: no [data-scene-img] on the page');
      return Promise.resolve(null);
    }

    var url = imageUrl(source);
    if (!url) {
      console.error('Wallflower: scene image has no resolvable URL');
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);

        try {
          canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1);
        } catch (err) {
          console.error('Wallflower: scene bitmap tainted, colour matching disabled');
          resolve(null);
          return;
        }

        resolve(canvas);
      };

      img.onerror = function () {
        console.error('Wallflower: scene image failed CORS load —', url);
        resolve(null);
      };

      img.src = url;
    });
  }

  function toHex(rgb) {
    return (
      '#' +
      rgb
        .map(function (channel) {
          return Math.round(channel).toString(16).padStart(2, '0');
        })
        .join('')
    );
  }

  function hexToRgb(hex) {
    if (!hex) return null;
    var clean = hex.replace('#', '');
    if (clean.length !== 6) return null;
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }

  // Average colour and variance of the patch. Variance stands in for how busy
  // the spot is: a flat wall varies little and hides nobody, a cluttered stall
  // varies a lot and hides anyone.
  function samplePatch(xPercent, yPercent) {
    if (!sceneBitmap) return null;

    var half = Math.floor(SAMPLE_BOX / 2);
    var cx = Math.round((xPercent / 100) * sceneBitmap.width);
    var cy = Math.round((yPercent / 100) * sceneBitmap.height);
    var left = Math.min(Math.max(cx - half, 0), sceneBitmap.width - SAMPLE_BOX);
    var top = Math.min(Math.max(cy - half, 0), sceneBitmap.height - SAMPLE_BOX);

    var data;
    try {
      data = sceneBitmap
        .getContext('2d', { willReadFrequently: true })
        .getImageData(left, top, SAMPLE_BOX, SAMPLE_BOX).data;
    } catch (err) {
      if (!samplePatch.warned) {
        samplePatch.warned = true;
        console.error('Wallflower: cannot read scene pixels (canvas tainted) —', err.message);
      }
      return null;
    }

    var sum = [0, 0, 0];
    var pixels = data.length / 4;

    for (var i = 0; i < data.length; i += 4) {
      sum[0] += data[i];
      sum[1] += data[i + 1];
      sum[2] += data[i + 2];
    }

    var mean = [sum[0] / pixels, sum[1] / pixels, sum[2] / pixels];
    var spread = 0;

    for (var j = 0; j < data.length; j += 4) {
      spread +=
        Math.abs(data[j] - mean[0]) +
        Math.abs(data[j + 1] - mean[1]) +
        Math.abs(data[j + 2] - mean[2]);
    }

    return { mean: mean, hex: toHex(mean), variance: spread / pixels / 3 };
  }

  // Average colour of an avatar's own art, weighted by alpha so only the visible
  // silhouette counts. Cached per slug — the image does not change.
  function loadAvatarTone(slug) {
    if (!slug || avatarTones[slug] !== undefined) return Promise.resolve(avatarTones[slug]);

    var art = avatars[slug];
    if (!art || !art.front) {
      avatarTones[slug] = null;
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          var ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);

          var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          var wr = 0;
          var wg = 0;
          var wb = 0;
          var wa = 0;

          // Weighted, not gated: these are cut-outs with anti-aliased edges, and
          // a hard alpha cutoff counts a 60% edge pixel as fully present and a
          // 40% one as absent.
          for (var i = 0; i < data.length; i += 40) {
            var a = data[i + 3] / 255;
            if (!a) continue;
            wr += data[i] * a;
            wg += data[i + 1] * a;
            wb += data[i + 2] * a;
            wa += a;
          }

          avatarTones[slug] = wa ? [wr / wa, wg / wa, wb / wa] : null;
        } catch (err) {
          avatarTones[slug] = null;
        }
        resolve(avatarTones[slug]);
      };

      img.onerror = function () {
        avatarTones[slug] = null;
        resolve(null);
      };

      img.src = art.front;
    });
  }

  // -------------------------------------------------------------------------
  // Blend
  //
  // Contract for the stringified JSON in `hides.blend`. Memberstack has no JSON
  // field type, so it lives in TEXT. Both sides are in this file now, so the
  // shape cannot drift between reader and writer.
  //
  //   facing   'front' | 'back'   "Facing you" / "Turned away"
  //   cutOff   0-100              percent trimmed from the bottom
  //   size     multiplier         0.92 = 92% of this scene's crowd figure height,
  //                               not a percent of the scene — a figure is sized
  //                               against the painted crowd around it
  //   mirror   boolean
  //   cutTop   0-45              percent trimmed from the top
  //   cutSide  -30..30           signed: negative clips the right edge
  //   tint     '#rrggbb'          sampled ambient, kept for the match meter only
  //
  // Depth was built and abandoned. A foreground cutout redraws each object
  // complete, including the parts hidden behind crowd figures in the original,
  // so stacking it back buries people who were standing in front. Alignment
  // cannot fix it. Do not revisit.
  // -------------------------------------------------------------------------

  function applyBlend(figure, image, blend) {
    var facing = blend.facing === 'back' ? 'back' : 'front';
    var art = avatars[figure.dataset.avatar];
    if (art && art[facing]) image.setAttribute('src', art[facing]);

    var multiplier = typeof blend.size === 'number' ? blend.size : 1;
    figure.style.height = crowdHeight * multiplier + '%';

    // Lean was dropped. Rotating tipped the footprint and read as falling over;
    // skewing sheared the artwork. Neither looked like a person standing at an
    // angle, and a flat cut-out cannot really be leant without redrawing it.
    figure.style.transform = blend.mirror ? 'scaleX(-1)' : '';

    // Occlusion: standing behind something, trimmed from any edge. Capped so a
    // figure can be partly hidden but never erased — past roughly a quarter it
    // stops reading as "behind the hedge" and starts reading as "gone".
    var top = blend.cutTop || 0;
    var bottom = blend.cutOff || 0;
    var side = blend.cutSide || 0;
    var left = side > 0 ? side : 0;
    var right = side < 0 ? -side : 0;

    image.style.clipPath =
      top || bottom || side
        ? 'inset(' + top + '% ' + right + '% ' + bottom + '% ' + left + '%)'
        : '';

    // Tint pulls the figure toward whatever colour was sampled behind her.
    // `color` blend mode alone replaces hue and saturation outright, which
    // turns her flatly into that hue rather than making her belong — so it is
    // paired with desaturation and capped below full. Losing vividness is most
    // of what "blending in" is: an over-saturated figure reads as pasted on
    // even at exactly the right hue.
    // No filters and no overlays. Colour blending is gone: a flat wash over a
    // cut-out never read as belonging, and the overlay layers were the source of
    // the see-through figure.
    image.style.filter = '';
    image.style.mixBlendMode = 'normal';
    image.style.opacity = 1;

    var tint = one('[data-figure-tint]', figure);
    if (tint) tint.style.opacity = 0;

    var shade = one('[data-figure-shade]', figure);
    if (shade) shade.style.opacity = 0;
  }

  // The figure renders as its own art now, so its tone is simply its average
  // colour — no compositing model to approximate.

  // How hidden the figure actually is, from things that genuinely affect being
  // spotted:
  //   how close its rendered colour is to the patch behind it
  //   how busy that patch is — cover
  //   whether its face is showing
  //   whether it is scaled anywhere near the painted crowd
  //
  // Deliberately not scored on how far the sliders have been pushed. Tint now
  // always equals the sample, so comparing tint to the patch would return a
  // perfect match every time and tell the player nothing. Rewarding slider
  // movement would be worse — it would report "well hidden" for effort rather
  // than for result.
  //
  // It still cannot score proximity to other figures: the crowd is painted into
  // the image, so standing in a group is indistinguishable from standing alone.
  function scoreMatch(patch) {
    if (!patch) return 0;

    var busy = Math.min(patch.variance / 60, 1); // variance flattens well before 255
    var tone = avatarTones[currentAvatar];

    var closeness;
    if (tone) {
      var rendered = tone;
      var distance =
        Math.abs(rendered[0] - patch.mean[0]) +
        Math.abs(rendered[1] - patch.mean[1]) +
        Math.abs(rendered[2] - patch.mean[2]);
      closeness = 1 - Math.min(distance / 400, 1);
    } else {
      // Without the avatar's own tone there is nothing honest to compare, so
      // cover carries the score alone rather than inventing a colour term.
      closeness = busy;
    }

    // Occlusion — being physically behind something. The strongest hiding move
    // available, and the meter ignored it entirely until now. Each cut is capped
    // at its own slider maximum, so this is the fraction of the available
    // concealment actually used.
    var occluded = Math.min(
      (blend.cutOff || 0) / 25 + (blend.cutTop || 0) / 45 + Math.abs(blend.cutSide || 0) / 30,
      1
    );

    var facing = blend.facing === 'back' ? 1 : 0.75;

    // A figure far off the crowd's scale reads as wrong however well it matches.
    var offScale = Math.min(Math.abs((blend.size || 1) - 1) / 1.2, 1);
    var scale = 1 - offScale * 0.5;

    return Math.round(
      Math.max(
        0,
        Math.min((occluded * 0.35 + busy * 0.35 + closeness * 0.3) * facing * scale, 1)
      ) * 100
    );
  }

  function fillTrack(selector, ratio) {
    var track = one(selector);
    if (!track) return;

    var clamped = Math.min(Math.max(ratio, 0), 1);
    var fill = one('[data-fill]', track);
    var knob = one('[data-knob]', track);

    if (fill) fill.style.width = clamped * 100 + '%';
    if (knob) knob.style.left = clamped * 100 + '%';
  }

  function paintPreview() {
    var node = one('[data-placing]');
    if (!node) return;

    node.style.left = position.x + '%';
    node.style.top = position.y + '%';

    var image = one('[data-figure-img]', node);
    if (image) applyBlend(node, image, blend);

    // Sample behind the figure's middle, not at position.x/y — those are the
    // top-left corner, which reads the background above her head. That is why
    // the swatch showed pale sky while she stood on a green hedge.
    var sx = position.x;
    var sy = position.y;
    var scrollerBox = one('[data-scroller]');
    if (scrollerBox) {
      var sb = scrollerBox.getBoundingClientRect();
      var fb = node.getBoundingClientRect();
      if (fb.width && sb.width) {
        sx = ((fb.left + fb.width / 2 - sb.left) / sb.width) * 100;
        sy = ((fb.top + fb.height * 0.6 - sb.top) / sb.height) * 100;
      }
    }

    var patch = samplePatch(sx, sy);
    var score = scoreMatch(patch);

    setText('[data-meter-value]', score + '%');
    var meter = one('[data-meter-fill]');
    if (meter) meter.style.width = score + '%';

    if (patch) {
      // Always track the live sample. This used to assign only when tint was
      // unset, on the reasoning that a member might override it — but there is
      // no colour picker, so nothing ever did. The result was that the swatch
      // followed the drag while the tint and shade layers stayed frozen at
      // whatever colour was under the figure when it first appeared.
      //
      // Committed figures are unaffected: renderFigures reads tint from their
      // stored blend, which is correctly frozen at their own commit position.
      blend.tint = patch.hex;
    }

    setText('[data-value-cutoff]', Math.round(blend.cutOff) + '%');
    setText('[data-value-cuttop]', Math.round(blend.cutTop) + '%');
    setText('[data-value-cutside]', Math.round(Math.abs(blend.cutSide)) + '%');
    fillTrack('[data-track-cuttop]', blend.cutTop / 45);
    fillTrack('[data-track-cutside]', (blend.cutSide + 30) / 60);
    setText('[data-value-size]', blend.size.toFixed(2));

    fillTrack('[data-track-cutoff]', blend.cutOff / 25);
    fillTrack('[data-track-size]', (blend.size - 0.3) / 2.7);

    all('[data-facing-option]').forEach(function (option) {
      option.classList.toggle('is-selected', option.dataset.facingOption === blend.facing);
    });

    var toggle = one('[data-mirror]');
    if (toggle) toggle.classList.toggle('is-on', !!blend.mirror);
  }

  function wireDrag(node) {
    var scroller = one('[data-scroller]');
    if (!node || !scroller) return;

    var dragging = false;

    node.addEventListener('pointerdown', function (event) {
      dragging = true;
      event.preventDefault();
      try {
        node.setPointerCapture(event.pointerId);
      } catch (err) {}
    });

    // Movement is tracked on the window, not the figure: capture alone loses the
    // pointer when the cursor outruns a small element mid-drag.
    window.addEventListener('pointermove', function (event) {
      if (!dragging) return;

      var box = scroller.getBoundingClientRect();
      position.x = Math.min(Math.max(((event.clientX - box.left) / box.width) * 100, 0), 100);
      position.y = Math.min(Math.max(((event.clientY - box.top) / box.height) * 100, 0), 100);

      paintPreview();
    });

    window.addEventListener('pointerup', function () {
      dragging = false;
    });
  }

  function dragTrack(selector, apply) {
    var track = one(selector);
    if (!track) return;

    function to(clientX) {
      var box = track.getBoundingClientRect();
      apply(Math.min(Math.max((clientX - box.left) / box.width, 0), 1));
      paintPreview();
    }

    track.addEventListener('pointerdown', function (event) {
      to(event.clientX);
      try {
        track.setPointerCapture(event.pointerId);
      } catch (err) {}
    });

    track.addEventListener('pointermove', function (event) {
      if (track.hasPointerCapture && track.hasPointerCapture(event.pointerId)) to(event.clientX);
    });
  }

  function wireControls() {
    dragTrack('[data-track-cuttop]', function (r) {
      blend.cutTop = r * 45;
    });

    // Signed: left of centre clips from the left edge, right from the right, so
    // one slider covers being behind a pillar on either side.
    dragTrack('[data-track-cutside]', function (r) {
      blend.cutSide = -30 + r * 60;
    });

    dragTrack('[data-track-cutoff]', function (r) {
      blend.cutOff = r * 25;
    });
    dragTrack('[data-track-size]', function (r) {
      blend.size = 0.3 + r * 2.7;
    });

    all('[data-facing-option]').forEach(function (option) {
      option.addEventListener('click', function () {
        blend.facing = option.dataset.facingOption === 'back' ? 'back' : 'front';
        paintPreview();
      });
    });

    var mirror = one('[data-mirror]');
    if (mirror) {
      mirror.addEventListener('click', function () {
        blend.mirror = !blend.mirror;
        paintPreview();
      });
    }
  }

  async function canRelocate(api, memberId) {
    try {
      var rows = await fetchAll('hides', {});
      var mine = rows
        .filter(function (row) {
          return row.createdByMemberId === memberId;
        })
        .sort(function (a, b) {
          return new Date(b.createdAt) - new Date(a.createdAt);
        })[0];

      if (!mine) return { allowed: true };

      var elapsed = Date.now() - new Date(mine.createdAt).getTime();
      if (elapsed >= RELOCATE_WINDOW_MS) return { allowed: true };

      return { allowed: false, hours: Math.ceil((RELOCATE_WINDOW_MS - elapsed) / 3600000) };
    } catch (err) {
      // Better to let the write attempt and fail than lock someone out on a read
      // error.
      return { allowed: true };
    }
  }

  // createdAt and createdByMemberId are set server side, so the timer and the
  // ownership cannot be forged by writing to your own record.
  //
  // username is denormalised onto the row because custom fields are readable
  // only for the logged-in member — the board cannot read anyone else's profile.
  function wireCommit(avatarSlug) {
    var button = one('[data-commit]');
    if (!button) return;

    button.addEventListener('click', async function (event) {
      event.preventDefault();

      var api = ms();
      if (!api) return;

      // Visible feedback. The button previously changed a data attribute nothing
      // styled, so a click looked identical to nothing happening — including
      // when the write was failing.
      var label = button.textContent;
      button.dataset.busy = 'true';
      button.textContent = 'placing you…';
      button.style.pointerEvents = 'none';
      setText('[data-commit-note]', 'saving your spot');

      try {
        var member = await api.getCurrentMember();
        var data = member && member.data;
        if (!data) throw new Error('not logged in');

        var gate = await canRelocate(api, data.id);
        if (!gate.allowed) {
          setText('[data-commit-note]', 'you can move again in ' + gate.hours + 'h');
          return;
        }

        var payload = {
          avatar_id: avatarSlug || '',
          scene_id: sceneSlug,
          x: Number(position.x.toFixed(4)),
          y: Number(position.y.toFixed(4)),
          facing: blend.facing,
          blend: JSON.stringify(blend),
          username: (data.customFields || {})['user-name'] || 'someone',
        };

        console.log('Wallflower: creating hide', payload);

        var created = await api.createDataRecord({ table: 'hides', data: payload });

        // A resolved promise is not proof of a row. The table stayed empty
        // through several apparently successful commits, so the result is
        // checked rather than assumed.
        var id = created && created.data && created.data.id;
        if (!id) {
          throw new Error('write returned no record id: ' + JSON.stringify(created));
        }

        setText('[data-commit-note]', 'you are hidden');
        window.location.reload();
      } catch (err) {
        // The real message, not a generic one — a silent failure here is what
        // made this look like the button did nothing.
        setText('[data-commit-note]', 'could not place you: ' + (err.message || err));
        console.error('Wallflower: hide not created', err);
        button.textContent = label;
        button.style.pointerEvents = '';
      } finally {
        button.dataset.busy = 'false';
      }
    });
  }

  async function enterHideMode(avatarSlug) {
    var board = one('[data-board]');
    var panel = one('[data-blend-panel]');
    var template = one('[data-figure-template]');
    var scroller = one('[data-scroller]');

    if (board) board.classList.add('is-gone');
    if (panel) panel.classList.add('is-shown');

    setStatus('Not hidden yet', 'pick a spot, then blend');
    setHint('drag yourself anywhere in the scene');

    if (!template || !scroller) return;

    var placing = template.cloneNode(true);
    placing.removeAttribute('data-figure-template');
    placing.removeAttribute('style');
    placing.style.display = 'block';
    placing.setAttribute('data-placing', '');
    placing.classList.add('is-placing');
    placing.dataset.avatar = avatarSlug || '';

    // The figure class sets pointer-events: none so clicks reach the scroller.
    // Your own unplaced figure is the exception, set inline so it does not depend
    // on which single-class rule wins the cascade.
    placing.style.pointerEvents = 'auto';

    var image = one('[data-figure-img]', placing);
    var art = avatars[avatarSlug];

    if (image && art && art.front) {
      image.setAttribute('src', art.front);
    } else {
      console.error(
        'Wallflower: no full-body art for',
        avatarSlug,
        '— the figure will be an empty outline. Known avatars:',
        Object.keys(avatars)
      );
    }

    scroller.appendChild(placing);

    // Placing can be abandoned without committing, otherwise your own scene traps
    // you in the panel with no way to read the board.
    var back = one('[data-show-board]');
    if (back) {
      back.addEventListener('click', function () {
        showBoard();
        var current = one('[data-placing]');
        if (current) current.remove();
        setHint('click anyone you think is a player');
      });
    }

    currentAvatar = avatarSlug || null;
    await loadAvatarTone(currentAvatar);

    sceneBitmap = await loadScene();

    if (!sceneBitmap) {
      console.error(
        'Wallflower: no scene bitmap — match meter and sampled colour will not work'
      );
    }

    var box = placing.getBoundingClientRect();
    if (!box.width || !box.height) {
      console.error(
        'Wallflower: placing figure has no size',
        box,
        '— it exists but cannot be grabbed. Check the figure is visible and has art.'
      );
    }

    wireDrag(placing);
    wireControls();
    wireCommit(avatarSlug);
    paintPreview();
  }

  // -------------------------------------------------------------------------

  async function start() {
    sceneSlug = textOf('[data-scene-slug]');
    crowdHeight = parseFloat(textOf('[data-crowd-height]')) || 12;
    readAvatarLookup();

    wireScrollbar();
    wireSpotting();

    var api = ms();
    if (!api) return;

    try {
      var member = await api.getCurrentMember();
      var memberId = member && member.data ? member.data.id : null;
      var json = await memberJson(api);

      var fields = (member && member.data && member.data.customFields) || {};
      paintFace(fields['cropped-avatar-url'], json.avatar);

      var ranked = await loadHides();
      console.log('Wallflower: hides read', ranked.length);

      sceneCounts = {};
      ranked.forEach(function (entry) {
        if (!entry.stillHidden) return;
        sceneCounts[entry.sceneId] = (sceneCounts[entry.sceneId] || 0) + 1;
      });

      var spotRows = await fetchAll('spots', {});
      var mySpots = spotRows.filter(function (spot) {
        return spot.createdByMemberId === memberId;
      });

      var myHide = ranked.filter(function (entry) {
        return entry.memberId === memberId && entry.stillHidden;
      })[0];

      selectedScene = json.scene || null;

      // ?place=1 opens hide mode on any scene. The ownership rule is right for
      // players but leaves exactly one URL where placement works, derived from
      // state you cannot see — which makes it near-impossible to test against.
      var forced = new URLSearchParams(location.search).has('place');

      // Always logged. Every failure in this flow so far has been silent, and
      // guessing at them from the outside cost far more than one line of output.
      console.log('Wallflower', {
        scene: sceneSlug,
        chosen: selectedScene,
        avatar: json.avatar,
        crop: !!(member && member.data && (member.data.customFields || {})['cropped-avatar-url']),
        avatarsLoaded: Object.keys(avatars).length,
        hides: ranked.length,
        myHide: !!myHide,
        willPlace: forced || (!myHide && selectedScene === sceneSlug),
      });

      paintTabs();
      paintHud(mySpots);
      paintBoard(ranked, memberId);
      renderFigures(ranked);

      if (myHide) {
        runTimer(myHide);
        return;
      }

      // Hide mode belongs to the scene chosen at /pick-a-scene, not to whatever
      // scene you browse to. Without this gate a member could place a figure in
      // all five scenes and occupy the board five times over.
      if (forced || (selectedScene && selectedScene === sceneSlug)) {
        await enterHideMode(json.avatar);
      } else if (selectedScene) {
        setStatus(
          'You are hiding elsewhere',
          'your spot is in the ' + selectedScene.replace(/-/g, ' ')
        );
      } else {
        setStatus('No spot chosen yet', 'pick a scene first');
      }
    } catch (err) {
      // The scene still renders from the CMS. Only the live layer is missing.
      console.error('Wallflower: scene data unavailable', err);
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
