// Wallflower — avatar and scene pickers
//
// Two picker screens plus the live "N hidden here" counts.
//
// These lists are Webflow CMS collections, not Memberstack Data Tables, so the
// `ms-code-*` / `data-ms-code` attribute system does not drive them — that system
// renders Memberstack records, and here Memberstack only supplies the member's
// own choice and the derived counts.
//
// Where the choice lives
// ----------------------
// The member record is the source of truth:
//   `cropped-avatar-url` custom field — the face crop, shown in the selection bar
//   member JSON `avatar`               — the avatar slug
//   member JSON `scene`                — the scene slug
//
// sessionStorage is a cache in front of it, not the store. It paints the UI on
// the same tick as the click so nothing waits on the network, then the write
// goes out behind it. On a fresh tab with an empty cache the member record fills
// it back in — the case that was broken when the choice lived only in
// sessionStorage.
//
// A choice is still not a hide. The `hides` row is created on the playground.

var STORE_KEY = 'wallflower:choice';
var WRITE_DELAY = 600;

// ---------------------------------------------------------------------------
// Local cache
// ---------------------------------------------------------------------------

function readChoice() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function writeChoice(patch) {
  var next = readChoice();
  Object.keys(patch).forEach(function (key) {
    next[key] = patch[key];
  });
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch (err) {
    // Private mode. The member record still holds the choice, so this only
    // costs a round trip on the next page.
  }
  return next;
}

function select(nodes, chosen) {
  nodes.forEach(function (node) {
    node.classList.toggle('is-selected', node === chosen);
  });
}

// Reads the CMS slug off a tile or row.
//
// The marker attribute and the slug binding ended up on the same attribute
// (`data-avatar-tile` / `data-scene-row`), which is fine — an attribute selector
// matches on presence, so it still works as a marker while carrying a value.
// Every candidate name is checked so it does not matter which one the binding
// landed on.
//
// The hidden `[data-slug]` element is the fallback for when no attribute
// is bound. It exists because CMS-bound attributes cannot be written through the
// Webflow API, only by hand in the Designer.
var SLUG_ATTRS = ['data-avatar', 'data-avatar-tile', 'data-scene', 'data-scene-row'];

function slugOf(node) {
  for (var i = 0; i < SLUG_ATTRS.length; i++) {
    var value = node.getAttribute(SLUG_ATTRS[i]);
    if (value) return value.trim();
  }

  var carrier = node.querySelector('[data-slug]');
  return carrier ? carrier.textContent.trim() || null : null;
}

// ---------------------------------------------------------------------------
// Member record
// ---------------------------------------------------------------------------

function ms() {
  return window.$memberstackDom || null;
}

async function getMember() {
  if (!ms()) return null;
  try {
    var result = await ms().getCurrentMember();
    return (result && result.data) || null;
  } catch (err) {
    return null;
  }
}

// Member JSON has its own getter. `getCurrentMember()` does not carry it, so
// reading `member.json` always yields undefined — and since updateMemberJSON
// replaces the whole object rather than merging, merging into that undefined
// wipes every key written by a previous screen.
async function getMemberJson() {
  if (!ms()) return {};
  try {
    var result = await ms().getMemberJSON();
    return (result && result.data) || {};
  } catch (err) {
    return {};
  }
}

// Clicking through the grid should not fire a write per tile. Memberstack allows
// 30 writes a minute per IP, and only the last choice matters.
//
// The debounce has to be flushable. A timer dies with the page, so a member who
// picks an avatar and presses continue inside the delay would have that choice
// dropped — it reaches sessionStorage and never reaches the member record.
var pendingWrite = null;
var pendingPatch = null;

function queueMemberWrite(patch) {
  // Merge rather than replace: an avatar queued behind a scene must not be lost
  // when the second call supersedes the first.
  pendingPatch = pendingPatch || {};
  Object.keys(patch).forEach(function (key) {
    pendingPatch[key] = patch[key];
  });

  clearTimeout(pendingWrite);
  pendingWrite = setTimeout(flushMemberWrite, WRITE_DELAY);
}

function flushMemberWrite() {
  clearTimeout(pendingWrite);
  pendingWrite = null;

  var patch = pendingPatch;
  pendingPatch = null;
  if (!patch) return Promise.resolve();

  return saveToMember(patch);
}

// The custom field and the JSON are two independent writes and must not share a
// try block. Sharing one meant a failure on the custom field aborted the JSON
// write before it ran — so picking an avatar saved nothing, while picking a
// scene (which touches no custom field) saved fine.
async function saveToMember(patch) {
  var api = ms();
  if (!api) return;

  if (patch.avatarFace) {
    try {
      await api.updateMember({
        customFields: { 'cropped-avatar-url': patch.avatarFace },
      });
    } catch (err) {
      console.error('Wallflower: cropped-avatar-url write failed', err);
    }
  }

  try {
    // JSON is replaced wholesale, not merged, so read the real object first.
    var json = await getMemberJson();
    if (patch.avatar) json.avatar = patch.avatar;
    if (patch.scene) json.scene = patch.scene;

    await api.updateMemberJSON({ json: json });
  } catch (err) {
    console.error('Wallflower: member JSON write failed', err);
  }
}

// Fills the local cache from the member record, so a fresh tab recovers a choice
// made in a previous session.
async function hydrateFromMember() {
  var member = await getMember();
  if (!member) return readChoice();

  var fields = member.customFields || {};
  var json = await getMemberJson();
  var cached = readChoice();

  return writeChoice({
    avatar: cached.avatar || json.avatar || null,
    avatarFace: cached.avatarFace || fields['cropped-avatar-url'] || null,
    scene: cached.scene || json.scene || null,
  });
}

// ---------------------------------------------------------------------------
// Selection bar face
//
// A div with a background image, so it takes a url() rather than a src. The
// Selection bar is one component shared by both screens, which is why the scene
// screen has a face at all — it shows what was chosen in step 2.
// ---------------------------------------------------------------------------

function paintFace(url) {
  var face = document.querySelector('[data-face]');
  if (!face || !url) return;
  face.style.backgroundImage = 'url("' + url + '")';
}

// ---------------------------------------------------------------------------
// Avatar picker
//
// Each tile carries `data-avatar` (bound to the CMS slug in the Designer) and a
// hidden `[data-face-source]` image bound to the face crop. Reading the crop off
// the tile costs nothing — the browser already has it.
// ---------------------------------------------------------------------------

function initAvatarPicker(choice) {
  var tiles = [].slice.call(document.querySelectorAll('[data-avatar-tile]'));
  if (!tiles.length) return;

  function choose(tile, persist) {
    var slug = slugOf(tile);
    var crop = tile.querySelector('[data-face-source]');
    var cropUrl = crop ? crop.getAttribute('src') : null;

    select(tiles, tile);
    paintFace(cropUrl);

    var patch = { avatar: slug, avatarFace: cropUrl };
    writeChoice(patch);
    if (persist) queueMemberWrite(patch);
  }

  var previous = tiles.filter(function (tile) {
    return choice.avatar && slugOf(tile) === choice.avatar;
  })[0];

  tiles.forEach(function (tile) {
    tile.addEventListener('click', function () {
      choose(tile, true);
    });
  });

  // Restoring a saved choice must not write it back. Opening on the first tile
  // does count as a choice, since that is what the member leaves with if they
  // press continue without touching anything.
  if (previous) {
    choose(previous, false);
  } else {
    choose(tiles[0], true);
  }
}

// ---------------------------------------------------------------------------
// Scene picker
//
// The featured panel is its own collection list filtered to `featured = true`, so
// it renders before this runs. Clicking a row repaints it from that row — no
// fetch, because the list already holds every scene.
// ---------------------------------------------------------------------------

function initScenePicker(choice) {
  var rows = [].slice.call(document.querySelectorAll('[data-scene-row]'));
  if (!rows.length) return;

  var featured = {
    image: document.querySelector('[data-featured-img]'),
    title: document.querySelector('[data-featured-title]'),
    detail: document.querySelector('[data-featured-detail]'),
    count: document.querySelector('[data-featured-count]'),
  };

  function choose(row, persist) {
    var slug = slugOf(row);
    var thumb = row.querySelector('[data-row-thumb]');
    var name = row.querySelector('[data-row-name]');
    var blurb = row.querySelector('[data-row-blurb]');

    select(rows, row);
    selectedScene = slug;
    pointContinueAt(slug);

    // Row thumbnail and featured image are the same CMS asset, so the swap is
    // instant rather than a fresh download.
    if (featured.image && thumb) featured.image.setAttribute('src', thumb.getAttribute('src'));
    if (featured.title && name) featured.title.textContent = name.textContent;
    if (name) nameSelectedScene(name.textContent);
    if (featured.detail && blurb) featured.detail.textContent = blurb.textContent;
    if (featured.count) featured.count.textContent = countLabel(sceneCounts[slug]);

    writeChoice({ scene: slug });
    if (persist) queueMemberWrite({ scene: slug });
  }

  rows.forEach(function (row) {
    row.addEventListener('click', function () {
      choose(row, true);
    });
  });

  var previous = rows.filter(function (row) {
    return choice.scene && slugOf(row) === choice.scene;
  })[0];

  if (previous) {
    choose(previous, false);
    return;
  }

  // With no prior choice, leave the featured panel on whatever the CMS flagged
  // and only mark the matching row, rather than overwriting the panel.
  if (!featured.title) return;
  var opening = featured.title.textContent.trim();
  rows.forEach(function (row) {
    var name = row.querySelector('[data-row-name]');
    if (name && name.textContent.trim() === opening) {
      row.classList.add('is-selected');
      selectedScene = slugOf(row);
      pointContinueAt(selectedScene);
      nameSelectedScene(name.textContent);
    }
  });
}

// ---------------------------------------------------------------------------
// Hidden counts
//
// "38 hidden here" is derived, never stored: a hide is live until a spot
// references it. Same rule the leaderboard uses, so the two cannot disagree.
// One read of each table, counted in memory — never per row.
// ---------------------------------------------------------------------------

var sceneCounts = {};

// Which scene is currently chosen. Held here rather than read back off a state
// class, so the count repaint never has to query the DOM by class name.
var selectedScene = null;

// The continue button is a static link in the Selection bar component, so it has
// to follow the selection. Without this it always points at whichever scene was
// hardcoded on the instance, and picking a different one silently sends the
// member to the wrong playground.
function pointContinueAt(slug) {
  var button = document.querySelector('[data-continue]');
  if (!button || !slug) return;
  button.setAttribute('href', '/scenes/' + slug);
}

// The selection bar names the chosen scene: "You start in the market square".
// Every scene is titled "The ...", so dropping the capital reads correctly mid
// sentence without keeping a second, hand-written name per scene.
function nameSelectedScene(name) {
  var title = document.querySelector('[data-selected-title]');
  if (!title || !name) return;

  var trimmed = name.trim();
  var lowered = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  title.textContent = 'You start in ' + lowered;
}

function countLabel(n) {
  if (!n) return 'nobody hiding here yet';
  return n + ' hidden here';
}

async function loadSceneCounts() {
  var api = ms();
  if (!api) return;

  try {
    var results = await Promise.all([
      api.queryDataRecords({ table: 'hides', query: { take: 100 } }),
      api.queryDataRecords({
        table: 'spots',
        query: { where: { result: { equals: 'hit' } }, take: 100 },
      }),
    ]);

    var hides = (results[0].data && results[0].data.records) || [];
    var hits = (results[1].data && results[1].data.records) || [];

    var ended = {};
    hits.forEach(function (spot) {
      var ref = spot.data && spot.data.hide;
      var id = ref && (ref.id || ref);
      if (id) ended[id] = true;
    });

    sceneCounts = {};
    hides.forEach(function (hide) {
      if (ended[hide.id]) return;
      var scene = hide.data && hide.data.scene_id;
      if (!scene) return;
      sceneCounts[scene] = (sceneCounts[scene] || 0) + 1;
    });

    paintCounts();
  } catch (err) {
    // Counts are decoration. If Memberstack is unreachable the designed
    // placeholder stays on screen rather than the row collapsing.
    console.error('Wallflower: scene counts unavailable', err);
  }
}

function paintCounts() {
  document.querySelectorAll('[data-scene-row]').forEach(function (row) {
    var node = row.querySelector('[data-row-count]');
    if (node) node.textContent = countLabel(sceneCounts[slugOf(row)]);
  });

  var featuredCount = document.querySelector('[data-featured-count]');
  if (selectedScene && featuredCount) {
    featuredCount.textContent = countLabel(sceneCounts[selectedScene]);
  }
}

// ---------------------------------------------------------------------------

// Anything queued must survive leaving the page. `pagehide` covers back/forward
// and tab close; the continue button is handled separately because a promise is
// not guaranteed to settle during unload.
function guardNavigation() {
  window.addEventListener('pagehide', function () {
    flushMemberWrite();
  });

  var button = document.querySelector('[data-continue]');
  if (!button) return;

  button.addEventListener('click', function (event) {
    if (!pendingPatch) return;

    var href = button.getAttribute('href');
    if (!href) return;

    event.preventDefault();
    flushMemberWrite().then(function () {
      window.location.href = href;
    });
  });
}

async function start() {
  // Paint from cache first so a same-tab navigation has no flash of empty state,
  // then reconcile against the member record.
  var cached = readChoice();
  paintFace(cached.avatarFace);

  var choice = await hydrateFromMember();
  paintFace(choice.avatarFace);

  initAvatarPicker(choice);
  initScenePicker(choice);
  guardNavigation();
  loadSceneCounts();
}

document.addEventListener('DOMContentLoaded', start);
