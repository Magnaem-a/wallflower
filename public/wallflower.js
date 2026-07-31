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

  // Shared with the spot modal so it can refuse a call before it is made.
  var callsState = { left: SPOTS_PER_HOUR, cooling: false, mins: 0 };

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

  // Ownership of a row. `createdByMemberId` is what the admin API returns, but
  // the client-side query has been seen to expose it under other names — and a
  // silent mismatch means your own hide is counted and ranked but never
  // recognised as yours, so hide mode reopens and the gate lets you commit again.
  function ownerOf(row) {
    var data = row.data || {};

    // Both tables now carry an explicit MEMBER_REFERENCE field. The creator is
    // tracked server-side too, but queryDataRecords does not return it to the
    // browser — so ownership had to be denormalised. A real member reference is
    // the right way to do that, rather than smuggling an id through a text field.
    var ref = data.member;
    var fromRef = ref && (ref.id || ref.memberId || (typeof ref === 'string' ? ref : null));

    return (
      fromRef ||
      row.createdByMemberId ||
      row.memberId ||
      row.createdBy ||
      data.member_id ||
      data.memberId ||
      null
    );
  }

  var ownerLogged = false;

  function logRowShape(row) {
    if (ownerLogged || !row) return;
    ownerLogged = true;

    if (!ownerOf(row)) {
      console.warn(
        'Wallflower: hide row has no resolvable owner — rows written before this ' +
          'build cannot be attributed and will not count as yours. Delete them.'
      );
    }
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

    logRowShape(hides[0]);

    var endedAt = {};
    var endedBy = {};

    hits.forEach(function (spot) {
      var ref = spot.data && spot.data.hide;
      var id = ref && (ref.id || ref);
      if (!id) return;
      endedAt[id] = spot.createdAt;
      endedBy[id] = spot.data && spot.data.username;
    });

    var now = Date.now();

    return hides
      .map(function (hide) {
        var data = hide.data || {};
        var start = new Date(hide.createdAt).getTime();
        var end = endedAt[hide.id] ? new Date(endedAt[hide.id]).getTime() : now;

        return {
          hideId: hide.id,
          memberId: ownerOf(hide),
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
          endedAt: endedAt[hide.id] || null,
          foundBy: endedBy[hide.id] || null,
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
  //   tint     '#rrggbb'          sampled from the patch behind the figure
  //   strength 0-1
  //   shade    -1..1              signed: positive darkens, negative lifts
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

    // No rotation. Rotating tipped the footprint and read as falling over, and
    // nothing in these flat illustrations sits off-vertical.
    figure.style.transform = blend.mirror ? 'scaleX(-1)' : '';

    // Occlusion — being physically behind something, trimmed from any edge.
    // Capped per slider so a figure can be partly hidden but never erased.
    var top = blend.cutTop || 0;
    var bottom = blend.cutOff || 0;
    var side = blend.cutSide || 0;
    var left = side > 0 ? side : 0;
    var right = side < 0 ? -side : 0;

    image.style.clipPath =
      top || bottom || side
        ? 'inset(' + top + '% ' + right + '% ' + bottom + '% ' + left + '%)'
        : '';

    // No filters and no overlays. Colour blending was cut: a flat wash over a
    // cut-out never read as belonging, and the overlay layers were what let the
    // scene show through the figure.
    image.style.filter = '';
    image.style.mixBlendMode = 'normal';
    image.style.opacity = 1;

    var tint = one('[data-figure-tint]', figure);
    if (tint) tint.style.opacity = 0;

    var shade = one('[data-figure-shade]', figure);
    if (shade) shade.style.opacity = 0;
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

    callsState = {
      left: left,
      cooling: !!cooling,
      mins: cooling ? Math.ceil((MISS_COOLDOWN_MS - (Date.now() - lastMiss)) / 60000) : 0,
    };

    return callsState;
  }

  // The member's own crop comes from their `cropped-avatar-url` custom field,
  // which the avatar picker already wrote. Going through the CMS lookup for your
  // own face added a dependency for no gain — the URL is on the member record.
  // The lookup is still needed for other players and for full-body art.
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

      openSpotModal({
        x: ((event.clientX - box.left) / box.width) * 100,
        y: ((event.clientY - box.top) / box.height) * 100,
        hideId: hit,
      });
    });

    var cancel = one('[data-spot-cancel]');
    if (cancel) {
      cancel.addEventListener('click', function (event) {
        event.preventDefault();
        closeSpotModal();
      });
    }

    var dim = one('[data-spot-dim]');
    if (dim) dim.addEventListener('click', closeSpotModal);

    var confirmButton = one('[data-spot-confirm]');
    if (confirmButton) confirmButton.addEventListener('click', submitSpot);
  }

  // Cuts a small square out of the composite around the click.
  //
  // Cropping the whole composite via background-position meant a full-size
  // toDataURL on every open — a large string built each time, and one that
  // throws outright if anything drawn into the canvas tainted it. Drawing just
  // the region needed is cheaper and the failure is contained.
  var CROP_SOURCE = 165; // scene pixels shown, matching Paper's 900% zoom

  function paintCrop(crop, target) {
    var source = compositeBitmap || sceneBitmap;

    if (!source) {
      // No readable pixels at all. Better an empty crop than a broken modal.
      crop.style.backgroundImage = '';
      return;
    }

    var half = CROP_SOURCE / 2;
    var cx = (target.x / 100) * source.width;
    var cy = (target.y / 100) * source.height;

    var sx = Math.max(0, Math.min(cx - half, source.width - CROP_SOURCE));
    var sy = Math.max(0, Math.min(cy - half, source.height - CROP_SOURCE));

    try {
      var out = document.createElement('canvas');
      out.width = CROP_SOURCE;
      out.height = CROP_SOURCE;
      out
        .getContext('2d')
        .drawImage(source, sx, sy, CROP_SOURCE, CROP_SOURCE, 0, 0, CROP_SOURCE, CROP_SOURCE);

      crop.style.backgroundImage = 'url("' + out.toDataURL() + '")';
      crop.style.backgroundSize = 'cover';
      crop.style.backgroundPosition = '50% 50%';
    } catch (err) {
      // A tainted canvas throws here rather than at draw time. Say so once, and
      // leave the crop empty rather than letting it take the modal down.
      if (!paintCrop.warned) {
        paintCrop.warned = true;
        console.error('Wallflower: crop unavailable (canvas tainted) —', err.message);
      }
      crop.style.backgroundImage = '';
    }
  }

  // What was clicked, held between opening the modal and confirming it.
  var pendingSpot = null;
  var lastRanked = [];

  function closeSpotModal() {
    pendingSpot = null;
    var dim = one('[data-spot-dim]');
    var modal = one('[data-spot-modal]');
    if (dim) dim.style.display = 'none';
    if (modal) modal.style.display = 'none';
  }

  // Opens for every click, including one that hit nothing. Offering it only over
  // real players would show exactly where they are.
  function openSpotModal(target) {
    var modal = one('[data-spot-modal]');
    var dim = one('[data-spot-dim]');
    if (!modal || !dim) return;

    // Out of calls, or still cooling off. Said here rather than after committing,
    // so nobody spends a call they do not have and is refused afterwards.
    var canCall = !callsState.cooling && callsState.left > 0;

    if (callsState.cooling) {
      setText('[data-spot-title]', 'Still cooling off');
      setText('[data-spot-note]', 'A wrong call locks you out for ten minutes. Wait it out.');
    } else if (!canCall) {
      setText('[data-spot-title]', 'No calls left this hour');
      setText('[data-spot-note]', 'You get three an hour. The next comes back within the hour.');
    } else {
      setText('[data-spot-title]', 'Call this one out?');
      setText(
        '[data-spot-note]',
        'Most figures here are painted, not players. A wrong call spends one of your three and ' +
          'locks you out of calling for ten minutes.'
      );
    }

    var confirmButton = one('[data-spot-confirm]');
    if (confirmButton) confirmButton.style.display = canCall ? '' : 'none';

    pendingSpot = canCall ? target : null;

    // A zoomed crop of exactly where the click landed, so the decision is about
    // the figure that was picked rather than the whole scene.
    var crop = one('[data-spot-crop]');
    if (crop) {
      crop.classList.remove('is-hit', 'is-miss');
      paintCrop(crop, target);
    }

    setText(
      '[data-spot-where]',
      Math.round(target.x) + '% across, ' + Math.round(target.y) + '% down'
    );
    paintPips();

    dim.style.display = 'block';
    modal.style.display = 'flex';
  }

  function paintPips() {
    all('[data-spot-pip]').forEach(function (pip, index) {
      pip.classList.toggle('is-spent', index >= callsState.left);
    });

    if (callsState.cooling) {
      setText('[data-spot-calls]', 'locked out for ' + callsState.mins + ' more minutes');
    } else {
      setText(
        '[data-spot-calls]',
        callsState.left + (callsState.left === 1 ? ' call' : ' calls') + ' left this hour'
      );
    }
  }

  // The outcome, shown in the same modal rather than a second one. Reloading
  // straight after the write made a hit and a miss look identical — the page
  // simply refreshed — which gave a player no acknowledgement either way.
  //
  // A miss gets as much care as a hit. It costs a call and ten minutes, so it
  // has to read as a fair result of a reasonable guess, not a telling-off: the
  // scene is mostly painted people, and mistaking one is the expected case.
  function showOutcome(hideId) {
    var found = lastRanked.filter(function (entry) {
      return entry.hideId === hideId;
    })[0];

    var crop = one('[data-spot-crop]');
    var confirmButton = one('[data-spot-confirm]');
    var cancelText = one('[data-spot-cancel] div');

    if (confirmButton) confirmButton.style.display = 'none';
    if (cancelText) cancelText.textContent = 'Back to the scene';

    if (found) {
      // Show who it was, not the patch of scene — the reward for a hit is
      // finding out who you caught.
      var art = avatars[found.avatarId];
      if (crop) {
        crop.classList.remove('is-miss');
        crop.classList.add('is-hit');
        if (art && art.crop) {
          crop.style.backgroundImage = 'url("' + art.crop + '")';
          crop.style.backgroundSize = 'cover';
          crop.style.backgroundPosition = '50% 50%';
        }
      }

      setText('[data-spot-title]', 'Found them');
      setText('[data-spot-where]', found.username || 'someone');
      setText(
        '[data-spot-note]',
        (found.username || 'They') +
          ' had been hidden for ' +
          formatDuration(found.durationMs) +
          '. That hide is over, and their time is locked in on the board.'
      );
      setText('[data-spot-calls]', 'your calls are untouched');
      all('[data-spot-pip]').forEach(function (pip) {
        pip.classList.remove('is-spent');
      });
    } else {
      if (crop) {
        crop.classList.remove('is-hit');
        crop.classList.add('is-miss');
      }

      setText('[data-spot-title]', 'Painted, not a player');
      setText('[data-spot-where]', 'part of the scene');
      setText(
        '[data-spot-note]',
        'That one was always part of the picture. Most of them are — nobody gets ' +
          'this right often. You can call again in ten minutes.'
      );

      var left = Math.max(0, callsState.left - 1);
      setText('[data-spot-calls]', 'locked out for ten minutes');
      all('[data-spot-pip]').forEach(function (pip, index) {
        pip.classList.toggle('is-spent', index >= left);
      });
    }

    // Dismissing reloads, so the board, the counts and the cooldown all come
    // back from the record rather than being patched in place.
    var cancel = one('[data-spot-cancel]');
    var dim = one('[data-spot-dim]');
    if (cancel) cancel.addEventListener('click', reload);
    if (dim) dim.addEventListener('click', reload);
  }

  function reload() {
    window.location.reload();
  }

  // Writes the spot. The result is decided here, not by the player: hit if the
  // click landed on a live hide, miss otherwise. createdAt and the member id are
  // server side, so neither the outcome nor the cooldown can be forged.
  async function submitSpot(event) {
    event.preventDefault();

    var api = ms();
    if (!api || !pendingSpot) return;

    var target = pendingSpot;
    pendingSpot = null;

    var confirmButton = one('[data-spot-confirm]');
    if (confirmButton) confirmButton.style.pointerEvents = 'none';
    setText('[data-spot-calls]', 'calling it\u2026');

    try {
      var member = await api.getCurrentMember();
      var data = member && member.data;
      if (!data) throw new Error('not logged in');

      var payload = {
        scene_id: sceneSlug,
        x: Number(target.x.toFixed(4)),
        y: Number(target.y.toFixed(4)),
        result: target.hideId ? 'hit' : 'miss',
        username: (data.customFields || {})['user-name'] || 'someone',
        member: data.id,
      };

      // The reference is what ends a hide — a hide counts as live until a spot
      // points at it.
      if (target.hideId) payload.hide = target.hideId;

      var created = await api.createDataRecord({ table: 'spots', data: payload });
      if (!created || !created.data || !created.data.id) {
        throw new Error('write returned no record id');
      }

      showOutcome(target.hideId);
    } catch (err) {
      setText('[data-spot-calls]', 'could not call it: ' + (err.message || err));
      console.error('Wallflower: spot not created', err);
      if (confirmButton) confirmButton.style.pointerEvents = '';
    }
  }

  // -------------------------------------------------------------------------
  // Being found
  //
  // The other half of artboard 06. A seeker gets an outcome the moment they
  // call it; the person found gets nothing until they come back, and the end of
  // a hide is the moment the whole game is about.
  //
  // Which hide has been seen is kept in member JSON, so dismissing survives a
  // reload without needing a field on the table.
  // -------------------------------------------------------------------------

  function timeAgo(ms) {
    var mins = Math.floor(ms / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + ' minutes ago';

    var hours = Math.round(mins / 60);
    if (hours < 24) return hours === 1 ? 'about an hour ago' : hours + ' hours ago';

    var days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : days + ' days ago';
  }

  async function checkFound(api, memberId, ranked, json) {
    // The most recent hide of yours that a spot ended.
    var ended = ranked
      .filter(function (entry) {
        return entry.memberId === memberId && !entry.stillHidden;
      })
      .sort(function (a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
      })[0];

    if (!ended || json.seenFound === ended.hideId) return;

    var badge = one('[data-spotted-badge]');
    if (badge) {
      badge.style.display = 'flex';
      badge.addEventListener('click', function () {
        openFound(ended, ranked, api, json);
      });
    }

    openFound(ended, ranked, api, json);
  }

  function openFound(ended, ranked, api, json) {
    var modal = one('[data-found-modal]');
    var dim = one('[data-spot-dim]');
    if (!modal || !dim) return;

    // Who called it. The spot carries the seeker's username, denormalised for
    // exactly this — one member cannot read another's profile.
    var seeker = ended.foundBy || 'someone';

    setText('[data-found-title]', seeker + ' found you');
    setText(
      '[data-found-where]',
      'in the ' +
        String(ended.sceneId).replace(/-/g, ' ') +
        ', ' +
        timeAgo(Date.now() - new Date(ended.endedAt || ended.createdAt).getTime())
    );
    setText('[data-found-time]', formatDuration(ended.durationMs));

    // Where that run landed, rather than a bare number.
    var place =
      ranked
        .slice()
        .sort(function (a, b) {
          return b.durationMs - a.durationMs;
        })
        .indexOf(ended) + 1;

    setText(
      '[data-found-note]',
      place && place <= 8
        ? 'Long enough for ' + place + ordinal(place) + ' place. Your time is locked in on the board.'
        : 'Your time is locked in on the board.'
    );

    var crop = one('[data-found-crop]');
    var art = avatars[ended.foundByAvatar];
    if (crop && art && art.crop) crop.style.backgroundImage = 'url("' + art.crop + '")';

    dim.style.display = 'block';
    modal.style.display = 'flex';

    function dismiss(goHide) {
      dim.style.display = 'none';
      modal.style.display = 'none';

      // Marked as seen so it does not reopen on every visit. The badge stays
      // lit until a new hide is placed.
      saveSeen(api, json, ended.hideId);
      if (goHide) window.location.reload();
    }

    var again = one('[data-found-again]');
    if (again) {
      again.addEventListener('click', function (event) {
        event.preventDefault();
        dismiss(true);
      });
    }

    var later = one('[data-found-dismiss]');
    if (later) {
      later.addEventListener('click', function (event) {
        event.preventDefault();
        dismiss(false);
      });
    }
  }

  function ordinal(n) {
    if (n === 1) return 'st';
    if (n === 2) return 'nd';
    if (n === 3) return 'rd';
    return 'th';
  }

  async function saveSeen(api, json, hideId) {
    try {
      var current = await api.getMemberJSON();
      var next = (current && current.data) || {};
      next.seenFound = hideId;
      await api.updateMemberJSON({ json: next });
    } catch (err) {
      console.error('Wallflower: could not mark the find as seen', err);
    }
  }

  // -------------------------------------------------------------------------
  // Hide mode
  // -------------------------------------------------------------------------

  var blend = {
    facing: 'front',
    cutOff: 0,
    cutTop: 0,
    cutSide: 0,
    size: 1,
    mirror: false,
    tint: null, // sampled ambient, used by the match meter only
  };

  var position = { x: 50, y: 60 };
  var currentAvatar = null;
  var sceneBitmap = null;

  function showBoard() {
    var board = one('[data-board]');
    var panel = one('[data-blend-panel]');
    if (board) board.classList.remove('is-gone');
    if (panel) panel.classList.remove('is-shown');
  }

  // The scene is drawn once into an offscreen canvas so the meter reads pixels
  // without touching the DOM. crossOrigin must be set before src or the canvas
  // taints and getImageData throws — which is why this loads its own copy rather
  // than reusing the img already on the page.
  function loadScene() {
    var source = one('[data-scene-img]');
    if (!source) {
      console.error('Wallflower: no [data-scene-img] on the page');
      return Promise.resolve(null);
    }

    // Resolve through src, currentSrc and srcset. Webflow lazy-loads CMS images
    // and renders a srcset, so the src attribute alone can be empty — reading it
    // directly was almost certainly why the bitmap never loaded.
    var url = imageUrl(source);
    if (!url) {
      console.error('Wallflower: scene image has no resolvable URL');
      return Promise.resolve(null);
    }

    function attempt(useCors) {
      return new Promise(function (resolve) {
        var img = new Image();

        // crossOrigin has to be set before src or it has no effect. With it, a
        // server that omits CORS headers fails the load outright; without it the
        // image loads but taints the canvas. Try clean first, then fall back so
        // at least the failure mode is a readable error rather than nothing.
        if (useCors) img.crossOrigin = 'anonymous';

        img.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
          resolve(canvas);
        };

        img.onerror = function () {
          resolve(null);
        };

        img.src = url;
      });
    }

    return attempt(true).then(function (canvas) {
      if (!canvas) {
        console.error('Wallflower: scene image failed CORS load —', url);
        return null;
      }

      // Verify pixels are actually readable; a tainted bitmap looks loaded but
      // every sample throws, and the effects then run on grey fallbacks.
      try {
        canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1);
      } catch (err) {
        console.error('Wallflower: scene bitmap tainted, disabling colour effects');
        return null;
      }

      return canvas;
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

  // Average colour plus variance of the patch. Variance stands in for how busy
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
      data = sceneBitmap.getContext('2d', { willReadFrequently: true }).getImageData(left, top, SAMPLE_BOX, SAMPLE_BOX).data;
    } catch (err) {
      // A tainted canvas means the scene image loaded without CORS headers. The
      // meter and the sampled colour both die here, so say so once.
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

  // Average colour of an avatar's own art, ignoring transparent pixels. Cached
  // per slug — the image does not change, only what sits behind it.
  var avatarTones = {};

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

          // Weighted by alpha, not gated on it. These are cut-outs, so most of
          // the box is transparent and the edges are anti-aliased. A hard cutoff
          // counts a 60%-opaque edge pixel as fully present and a 40% one as
          // absent, which drags the mean toward whatever the PNG carries in its
          // fringe. Weighting means only what is actually visible contributes.
          //
          // Stepped rather than exhaustive: an average colour does not need
          // every pixel.
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

  // --- compositing model -----------------------------------------------------
  //
  // Mirrors what the CSS actually does, in order:
  //   1. filter: saturate()          on the image
  //   2. mix-blend-mode: color       tint layer, at opacity
  //   3. normal-mode wash            shade layer, at opacity
  //
  // Steps 1 and 3 are channel arithmetic. Step 2 is a non-separable blend from
  // the compositing spec — it takes hue and saturation
  // from the source and keeps the backdrop's luminosity — so a channel lerp
  // toward the tint drifts, most visibly at high strength where the backdrop
  // has already been desaturated.
  //
  // Note the two luma formulas differ and are not interchangeable: the saturate
  // filter uses Rec.709 coefficients, the blend spec's Lum() uses its own.









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
  // A canvas holding the scene with every placed figure drawn into it.
  //
  // The spot modal crops from this, not from the bare scene. Cropping the scene
  // meant clicking a real player produced empty ground while clicking a painted
  // one produced a figure — which told a seeker exactly what they had found
  // before they committed a call. The whole modal depends on both looking
  // equally plausible.
  var compositeBitmap = null;
  var avatarImages = {};

  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (avatarImages[url] !== undefined) return Promise.resolve(avatarImages[url]);

    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        avatarImages[url] = img;
        resolve(img);
      };
      img.onerror = function () {
        avatarImages[url] = null;
        resolve(null);
      };
      img.src = url;
    });
  }

  async function buildComposite(hides) {
    if (!sceneBitmap) return null;

    var W = sceneBitmap.width;
    var H = sceneBitmap.height;

    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;

    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sceneBitmap, 0, 0);

    var here = hides.filter(function (hide) {
      return hide.sceneId === sceneSlug && hide.stillHidden;
    });

    for (var i = 0; i < here.length; i++) {
      var hide = here[i];
      var art = avatars[hide.avatarId];
      if (!art) continue;

      var facing = hide.blend && hide.blend.facing === 'back' ? 'back' : 'front';
      var img = await loadImage(art[facing]);
      if (!img || !img.naturalHeight) continue;

      var size = typeof hide.blend.size === 'number' ? hide.blend.size : 1;
      var h = (crowdHeight * size * H) / 100;
      var w = h * (img.naturalWidth / img.naturalHeight);
      var x = (hide.x / 100) * W;
      var y = (hide.y / 100) * H;

      // Same trims the DOM figure gets, so the composite matches what is on
      // screen rather than an idealised version of it.
      var top = ((hide.blend.cutTop || 0) / 100) * img.naturalHeight;
      var bottom = ((hide.blend.cutOff || 0) / 100) * img.naturalHeight;
      var side = hide.blend.cutSide || 0;
      var left = side > 0 ? (side / 100) * img.naturalWidth : 0;
      var right = side < 0 ? (-side / 100) * img.naturalWidth : 0;

      var sx = left;
      var sy = top;
      var sw = Math.max(1, img.naturalWidth - left - right);
      var sh = Math.max(1, img.naturalHeight - top - bottom);

      var dx = x + (left / img.naturalWidth) * w;
      var dy = y + (top / img.naturalHeight) * h;
      var dw = (sw / img.naturalWidth) * w;
      var dh = (sh / img.naturalHeight) * h;

      ctx.save();
      if (hide.blend.mirror) {
        ctx.translate(dx + dw / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(dx + dw / 2), 0);
      }
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
    }

    return canvas;
  }

  // The figure's box in scroller percentages, so pixel work can be done against
  // the same coordinate space the placement uses.
  function figureBox(node) {
    var scroller = one('[data-scroller]');
    if (!scroller || !node) return null;

    var sb = scroller.getBoundingClientRect();
    var fb = node.getBoundingClientRect();
    if (!sb.width || !sb.height || !fb.width) return null;

    return {
      x: ((fb.left - sb.left) / sb.width) * 100,
      y: ((fb.top - sb.top) / sb.height) * 100,
      w: (fb.width / sb.width) * 100,
      h: (fb.height / sb.height) * 100,
    };
  }

  // Local contrast of a strip of scene, 0..1. Standard deviation of luminance:
  // flat paint scores near zero, an object edge scores high. This is how the
  // script tells whether something is actually there.
  function regionContrast(xPct, yPct, wPct, hPct) {
    if (!sceneBitmap) return 0;

    var W = sceneBitmap.width;
    var H = sceneBitmap.height;

    var x = Math.max(0, Math.min(Math.round((xPct / 100) * W), W - 2));
    var y = Math.max(0, Math.min(Math.round((yPct / 100) * H), H - 2));
    var w = Math.max(2, Math.min(Math.round((wPct / 100) * W), W - x));
    var h = Math.max(2, Math.min(Math.round((hPct / 100) * H), H - y));

    var data;
    try {
      data = sceneBitmap
        .getContext('2d', { willReadFrequently: true })
        .getImageData(x, y, w, h).data;
    } catch (err) {
      return 0;
    }

    var sum = 0;
    var sumSq = 0;
    var n = 0;

    for (var i = 0; i < data.length; i += 4) {
      var l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l;
      sumSq += l * l;
      n++;
    }

    if (!n) return 0;

    var mean = sum / n;
    var sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));

    // 45 is about where scene contrast stops meaning anything more.
    return Math.min(sd / 45, 1);
  }

  // Whether the cuts are standing on anything.
  //
  // A cut claims "something is in front of me here". Previously that was taken
  // on trust, so dragging the side slider in open ground scored as hiding behind
  // a pillar that did not exist. Now the strip of scene at each cut boundary is
  // measured: an object edge there is high contrast, flat ground is not.
  //
  // Returns 1 when no cuts are set — there is nothing being claimed, so nothing
  // to disprove.
  function occlusionSupport(box) {
    if (!box) return 1;

    var strips = [];
    var band = Math.max(box.h * 0.04, 0.6);

    if (blend.cutOff) {
      strips.push(
        regionContrast(box.x, box.y + box.h * (1 - blend.cutOff / 100) - band / 2, box.w, band)
      );
    }

    if (blend.cutTop) {
      strips.push(
        regionContrast(box.x, box.y + box.h * (blend.cutTop / 100) - band / 2, box.w, band)
      );
    }

    if (blend.cutSide) {
      var vBand = Math.max(box.w * 0.08, 0.4);
      var edge =
        blend.cutSide > 0
          ? box.x + box.w * (blend.cutSide / 100)
          : box.x + box.w * (1 + blend.cutSide / 100);
      strips.push(regionContrast(edge - vBand / 2, box.y, vBand, box.h));
    }

    if (!strips.length) return 1;

    var total = strips.reduce(function (a, b) {
      return a + b;
    }, 0);

    // Never fully zero: a cut against flat ground still conceals something, it
    // just should not score like standing behind a wall.
    return 0.25 + 0.75 * (total / strips.length);
  }

  // Crowd proximity, by counting skin-tone pixels around the figure.
  //
  // Variance could not tell a group of people from a stack of crates — both read
  // as busy — and for these avatars those are opposites: the art does not match
  // the painted crowd, so standing among people highlights the mismatch.
  //
  // These scenes are flat vector with a tight palette, so skin sits in a narrow,
  // recognisable range while wood, stone and foliage sit well outside it.
  // Counting it is enough to answer "am I standing in a group", which no amount
  // of contrast maths could.
  //
  // Known limits: very warm wood tones can read as skin, and it cannot tell a
  // painted person from a painted portrait. Both would show up as a spot scoring
  // crowded when it plainly is not.
  function isSkinTone(r, g, b) {
    if (r < 80 || r > 255) return false;
    if (r <= g || g <= b) return false; // skin runs warm: red > green > blue

    var spread = r - b;
    if (spread < 15 || spread > 130) return false;

    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    if (max - min < 12) return false; // near-grey is not skin

    return true;
  }

  // 0 = nobody nearby, 1 = standing in a group. Sampled from a band around the
  // figure rather than behind it — who is beside you is what gives you away.
  function crowdNearby(box) {
    if (!sceneBitmap || !box) return 0;

    var W = sceneBitmap.width;
    var H = sceneBitmap.height;
    var pad = box.w * 1.6; // roughly a figure's width of neighbourhood each side

    var x = Math.max(0, Math.round(((box.x - pad) / 100) * W));
    var y = Math.max(0, Math.round((box.y / 100) * H));
    var w = Math.min(Math.round(((box.w + pad * 2) / 100) * W), W - x);
    var h = Math.min(Math.round((box.h / 100) * H), H - y);

    if (w < 4 || h < 4) return 0;

    var data;
    try {
      data = sceneBitmap
        .getContext('2d', { willReadFrequently: true })
        .getImageData(x, y, w, h).data;
    } catch (err) {
      return 0;
    }

    var skin = 0;
    var seen = 0;

    // Stepped: proportion does not need every pixel.
    for (var i = 0; i < data.length; i += 16) {
      if (data[i + 3] < 128) continue;
      seen++;
      if (isSkinTone(data[i], data[i + 1], data[i + 2])) skin++;
    }

    if (!seen) return 0;

    // A lone figure's own face and hands are a few percent of the band, so the
    // floor is set above that. Around 12% is a real group.
    var ratio = skin / seen;
    return Math.min(Math.max((ratio - 0.03) / 0.09, 0), 1);
  }

  // How hidden the figure looks, from the two things a member actually controls
  // here: what is in front of them, and what is behind them.
  //
  // Patch variance was weighted as "cover" and has been dropped. It cannot tell
  // a crowd from a stack of crates — both read as busy — and for these avatars
  // those are opposites. The art does not match the painted crowd, so standing
  // among people highlights the mismatch; an open patch beside an object reads
  // far more naturally. Scoring variance rewarded the worst spots.
  //
  // It still cannot verify that anything is actually there to hide behind: the
  // side cut credits you for a pillar whether or not one exists. That is a
  // limit of scoring from pixels, and worth knowing before trusting the number.
  function scoreMatch(patch, box) {
    if (!patch) return 0;

    // Occlusion — how much of you is behind something. Each cut measured against
    // its own slider maximum.
    var claimed = Math.min(
      (blend.cutOff || 0) / 25 + (blend.cutTop || 0) / 45 + Math.abs(blend.cutSide || 0) / 30,
      1
    );

    // Scaled by whether the scene actually supports the claim.
    var occluded = claimed * occlusionSupport(box);

    // Colour — your avatar's own average tone against the surface behind it.
    // Fixed for a given avatar and spot, which is the point: it is a reason to
    // stand somewhere rather than a slider to push.
    var tone = avatarTones[currentAvatar];
    var closeness = 0.5;

    if (tone) {
      var distance =
        Math.abs(tone[0] - patch.mean[0]) +
        Math.abs(tone[1] - patch.mean[1]) +
        Math.abs(tone[2] - patch.mean[2]);
      closeness = 1 - Math.min(distance / 400, 1);
    }

    var facing = blend.facing === 'back' ? 1 : 0.75;

    // A figure far off the crowd's scale reads as wrong however well it matches.
    var offScale = Math.min(Math.abs((blend.size || 1) - 1) / 1.2, 1);
    var scale = 1 - offScale * 0.5;

    // Standing in a group costs up to 40%. Not fatal — a crowd is still cover of
    // a sort — but it should never be the best spot on the board.
    var exposure = 1 - crowdNearby(box) * 0.4;

    return Math.round(
      Math.max(0, Math.min((occluded * 0.55 + closeness * 0.45) * facing * scale * exposure, 1)) *
        100
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
    // top-left corner, which reads the background above her head.
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
    if (patch) blend.tint = patch.hex;

    var score = scoreMatch(patch, figureBox(node));
    setText('[data-meter-value]', score + '%');
    var meter = one('[data-meter-fill]');
    if (meter) meter.style.width = score + '%';

    setText('[data-value-cutoff]', Math.round(blend.cutOff) + '%');
    setText('[data-value-cuttop]', Math.round(blend.cutTop) + '%');
    setText('[data-value-cutside]', Math.round(Math.abs(blend.cutSide)) + '%');
    setText('[data-value-size]', blend.size.toFixed(2));

    fillTrack('[data-track-cutoff]', blend.cutOff / 25);
    fillTrack('[data-track-cuttop]', blend.cutTop / 45);
    fillTrack('[data-track-cutside]', (blend.cutSide + 30) / 60);
    fillTrack('[data-track-size]', (blend.size - 0.3) / 2.7);

    all('[data-facing-option]').forEach(function (option) {
      // is-facing, not is-selected — two globals of the same name with different
      // intents meant the later one silently redefined the earlier.
      option.classList.toggle('is-facing', option.dataset.facingOption === blend.facing);
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
    dragTrack('[data-track-cutoff]', function (r) {
      blend.cutOff = r * 25;
    });
    dragTrack('[data-track-cuttop]', function (r) {
      blend.cutTop = r * 45;
    });

    // Signed: left of centre clips the left edge, right clips the right, so one
    // slider covers being behind a pillar on either side.
    dragTrack('[data-track-cutside]', function (r) {
      blend.cutSide = -30 + r * 60;
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

  // One live hide per member, ever. Two separate rules:
  //   already hidden anywhere  -> refuse outright
  //   last hide ended under 24h -> refuse until the window passes
  //
  // Fails closed. This used to allow the write when the read threw, on the
  // reasoning that a read error should not lock anyone out — but the read is the
  // only thing standing between a member and a second figure, so an error has to
  // mean "no", not "go ahead".
  async function canRelocate(api, memberId) {
    var rows;
    var hits;

    try {
      var results = await Promise.all([
        fetchAll('hides', {}),
        fetchAll('spots', { result: { equals: 'hit' } }),
      ]);
      rows = results[0];
      hits = results[1];
    } catch (err) {
      return { allowed: false, reason: 'could not check your hides, try again' };
    }

    var ended = {};
    hits.forEach(function (spot) {
      var ref = spot.data && spot.data.hide;
      var id = ref && (ref.id || ref);
      if (id) ended[id] = true;
    });

    var mine = rows
      .filter(function (row) {
        return ownerOf(row) === memberId;
      })
      .sort(function (a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    var live = mine.filter(function (row) {
      return !ended[row.id];
    })[0];

    if (live) {
      var where = String((live.data && live.data.scene_id) || 'a scene').replace(/-/g, ' ');
      return { allowed: false, reason: 'you are already hidden in the ' + where };
    }

    if (!mine.length) return { allowed: true };

    var elapsed = Date.now() - new Date(mine[0].createdAt).getTime();
    if (elapsed >= RELOCATE_WINDOW_MS) return { allowed: true };

    return {
      allowed: false,
      reason: 'you can move again in ' + Math.ceil((RELOCATE_WINDOW_MS - elapsed) / 3600000) + 'h',
    };
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
      button.textContent = 'placing you\u2026';
      button.style.pointerEvents = 'none';
      setText('[data-commit-note]', 'saving your spot');

      try {
        var member = await api.getCurrentMember();
        var data = member && member.data;
        if (!data) throw new Error('not logged in');

        var gate = await canRelocate(api, data.id);
        if (!gate.allowed) {
          setText('[data-commit-note]', gate.reason);
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
          member: data.id,
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

  // Skeletons. Anything carrying [data-skeleton] gets a cover from the moment
  // the script runs until the data it waits for has actually painted — not a
  // fixed timer, which lifts too early on a slow read and too late on a fast
  // one.
  //
  // The cover sits on the game shell rather than on each piece, so the scene and
  // the figures appear together. Revealing the scene first and populating the
  // figures a moment later showed exactly where the players were.
  //
  // The sweep itself is CSS, in the page head — Webflow's style tool cannot hold
  // keyframes.
  function showSkeletons() {
    all('[data-skeleton]').forEach(function (node) {
      var cover = document.createElement('div');
      cover.className = 'skeleton_cover';
      cover.setAttribute('data-skeleton-cover', '');
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      node.appendChild(cover);
    });
  }

  function hideSkeletons() {
    all('[data-skeleton-cover]').forEach(function (cover) {
      cover.remove();
    });
  }

  async function start() {
    showSkeletons();

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
      lastRanked = ranked;
      console.log('Wallflower: hides read', ranked.length);

      sceneCounts = {};
      ranked.forEach(function (entry) {
        if (!entry.stillHidden) return;
        sceneCounts[entry.sceneId] = (sceneCounts[entry.sceneId] || 0) + 1;
      });

      var spotRows = await fetchAll('spots', {});
      var mySpots = spotRows.filter(function (spot) {
        return ownerOf(spot) === memberId;
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

      // The composite needs the scene pixels, which hide mode loads. Outside hide
      // mode it is loaded here so the spot modal has something to crop from.
      if (!sceneBitmap) sceneBitmap = await loadScene();
      compositeBitmap = await buildComposite(ranked);

      paintTabs();
      paintHud(mySpots);
      paintBoard(ranked, memberId);
      renderFigures(ranked);
      hideSkeletons();

      await checkFound(api, memberId, ranked, json);

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
      // The scene still renders from the CMS. Only the live layer is missing —
      // and a skeleton left up over it would read as a permanent loading state.
      hideSkeletons();
      console.error('Wallflower: scene data unavailable', err);
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
