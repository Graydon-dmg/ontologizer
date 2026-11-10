// @ts-check
// <onto-sky>: the 3D "Floor and Sky" view. Reads the shared layout (never writes it).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { registerView } from '../../shared/view.js';
import { boundsOf, toWorld, treeDistance, arcPoints, truncate, placeLabels, citedSets, centroid, allOffscreen } from './math.js';
import { descendants, neighborhood, ringsFrom, labelVisible } from './graphmath.js';
import { heightsFor, easeToward, arcLift, HEIGHT_MODES } from './heights.js';

const WORLD = 600;
const MIN_RADIUS = 3;
const IDLE_MS = 5000;
const BOUNDS_LERP = 0.1;
const RADIUS_REFRESH_MS = 500;
// Contract: apex height = 40 * treeDistance, in world units (the floor is WORLD = 600 across).
const ARC_HEIGHT_SCALE = 1;
const TREE_LINK_Y = 0.3; // parent links lie just above the floor
const ARC_POINTS = 24; // segments, so 25 points
const TILT_FROM = (60 / 180) * Math.PI; // turning Height on with the camera less than 60 degrees from straight down lowers it
const TILT_TO = (68 / 180) * Math.PI; // to 68 degrees from vertical: heights read clearly, the floor still shows
const DASH_UNIT = 1.5; // tokens' dash lengths are px; world units are about this much bigger
const CLICK_SLOP = 5;
const LABEL_EVERY = 6; // frames between label placements
const GHOST_CHARS = 30; // lens analogs are cut to this many characters until hovered
// Height modes: the highest node rises this far above the floor (the floor is WORLD across).
const HEIGHT_MAX = WORLD * 0.3;
const HEIGHT_RECALC_MS = 250; // at most this often while a build streams in
const HEIGHT_TAU = 180; // ms, the rise / fall time constant
const HEIGHT_CAMERA = 0.3; // the orbit target rises this share of HEIGHT_MAX while height is on
const STEM_OPACITY = 0.35;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Scene colours per theme. Page colours (bg, fg, panel, muted) come from tokens.THEME.
const SCENE = {
  dark: { floor: 0x151922, grid: [0x2a3040, 0x1e2330], tree: 0x5a6478, src: 0xa9b1c2, shadow: '#000', additive: true },
  light: { floor: 0xeceff5, grid: [0xc3cad8, 0xdadfe8], tree: 0x8e98ab, src: 0x667085, shadow: '#fff', additive: false },
};

/** The page theme: the <html data-theme> attribute wins, otherwise the OS preference. */
function currentTheme() {
  const t = globalThis.document && document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return globalThis.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Parse 'hsl(210 68% 58%)' into [h, s, l]. */
function parseHsl(css) {
  const m = /hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(css);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 60];
}

class OntoSky extends (globalThis.HTMLElement || Object) {
  constructor() {
    super();
    /** @type {Map<string, any>} per node: mesh, label, px, w (layout world pos), vis, ring, ghost, badge, spawnAt, base, lastOp */
    this.nodes = new Map();
    /** @type {Map<string, { line: any, edge: any, animate: boolean, start: number|null, h: number, last: number[], lastOp: number }>} */
    this.arcs = new Map();
    /** @type {Map<string, { mesh: any, nodeId: string }>} */
    this.halos = new Map();
    this.hoveredId = null;
    this.selectedId = null;
    /** @type {string[]|null} */
    this.citeIds = null;
    this.citeKey = 0;
    this.citePending = false;
    /** @type {{ nodes: Set<string>, edges: Set<string> }|null} */
    this.cited = null;
    /** @type {Map<string, any>} */
    this.citeHalos = new Map();
    /** @type {Set<string>|null} */
    this.ghostSet = null;
    this.collapsed = new Set();
    this.hiddenByCollapse = new Set();
    this.bright = null;
    this.rings = new Map();
    this.cacheKey = '';
    this.glide = null;
    this.pendingMove = null;
    this.down = null;
    this.focusId = '';
    this.lensId = null;
    this.filter = null;
    this.highlighted = [];
    this.hlKey = 0;
    this.raf = 0;
    this.idleTimer = 0;
    this.mounted = false;
    /** Height mode (setHeight): 'off' is the flat floor. */
    this.heightMode = 'off';
    /** @type {Map<string, number>|null} target heights in [0, 1] for the current mode */
    this.heightTargets = null;
    this.heightDirty = true;
    this.heightAt = 0;
    this.heightKey = '';
    /** 0 = flat, 1 = a height mode is fully on (eases between, so Off ends exactly flat). */
    this.liftMix = 0;
    this.lastFrame = 0;
  }

  /** @param {HTMLElement} el @param {any} ctx */
  mount(el, ctx) {
    this.host = el;
    this.ctx = ctx;
    const tk = ctx.tokens;
    this.tk = tk;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    // Pinned over the host: the host may also hold the <onto-sky> element itself at full size.
    renderer.domElement.style.cssText = 'display:block;position:absolute;inset:0;';
    el.appendChild(renderer.domElement);
    const labelRenderer = new CSS2DRenderer();
    const ld = labelRenderer.domElement;
    ld.style.position = 'absolute';
    ld.style.inset = '0';
    ld.style.pointerEvents = 'none';
    el.appendChild(ld);
    this.renderer = renderer;
    this.labelRenderer = labelRenderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(); // set by applyTheme()
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    camera.position.set(WORLD * 0.55, WORLD * 0.75, WORLD * 0.95);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 600, 200);
    scene.add(sun);

    // Floor: a disc plus a faint grid (the grid is rebuilt per theme by applyTheme()).
    const floorGeo = new THREE.CircleGeometry(WORLD * 0.8, 64);
    const floorMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.5;
    scene.add(floor);
    this.grid = null;
    this.floorGeo = floorGeo;
    this.floorMat = floorMat;

    this.sphereGeo = new THREE.SphereGeometry(1, 24, 16);
    this.haloGeo = new THREE.RingGeometry(1.3, 1.7, 48);
    // Dotted "no sources" ring in a node's unit-sphere space (lies on the floor at the sphere's foot).
    const ringPts = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * 1.5, -1, Math.sin(a) * 1.5));
    }
    this.srcGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    this.srcMat = new THREE.LineDashedMaterial({ dashSize: 0.08, gapSize: 0.12 });
    this.srcRing = new THREE.LineLoop(this.srcGeo, this.srcMat);
    this.srcRing.computeLineDistances();
    this.raycaster = new THREE.Raycaster();

    // Structure on the floor: one segment per visible parent link, refilled each frame.
    this.treeCap = 0;
    this.treeGeo = new THREE.BufferGeometry();
    this.treeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 });
    this.treeLines = new THREE.LineSegments(this.treeGeo, this.treeMat);
    this.treeLines.frustumCulled = false;
    scene.add(this.treeLines);
    // Stems: a thin line from each lifted node down to its place on the floor (height modes only).
    this.stemCap = 0;
    this.stemGeo = new THREE.BufferGeometry();
    this.stemMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    this.stemLines = new THREE.LineSegments(this.stemGeo, this.stemMat);
    this.stemLines.frustumCulled = false;
    this.stemLines.visible = false;
    scene.add(this.stemLines);

    // Theme: follow <html data-theme> (the shell's System / Light / Dark toggle), else the OS.
    this.applyTheme();
    this.onTheme = () => this.applyTheme();
    document.addEventListener('onto-theme', this.onTheme);
    this.mql = globalThis.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
    if (this.mql) this.mql.addEventListener('change', this.onTheme);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.maxPolarAngle = Math.PI * 0.49;
    this.onStart = () => {
      controls.autoRotate = false;
      clearTimeout(this.idleTimer);
    };
    this.onEnd = () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { controls.autoRotate = true; }, IDLE_MS);
    };
    controls.addEventListener('start', this.onStart);
    controls.addEventListener('end', this.onEnd);
    this.controls = controls;

    this.resize = () => {
      const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(el);
    this.resize();

    this.startDist = camera.position.distanceTo(controls.target);
    const snap = ctx.snapshot();
    this.collapsed = new Set((snap.view && snap.view.collapsed) || []);
    for (const j of Object.values(snap.jobs || {})) {
      if (j.nodeId && (j.state === 'queued' || j.state === 'running')) this.addHalo(j.id, j.nodeId);
    }
    this.focusId = (snap.view && snap.view.focus) || snap.root || '';
    this.bounds = boundsOf(ctx.layout.positions());
    this.radiiAt = 0;
    for (const id of Object.keys(snap.nodes)) this.ensureNode(id);
    this.tick = () => { this.dirty = true; };
    ctx.layout.on('tick', this.tick);
    this.dirty = true;

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);

    const dom = renderer.domElement;
    this.onDown = (ev) => { this.down = { x: ev.clientX, y: ev.clientY }; };
    this.onUp = (ev) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) >= CLICK_SLOP) return;
      const nodeId = this.pick(ev.clientX, ev.clientY);
      // Same shape as the 2D view: screen x, y for a node; a background click is { nodeId: null }.
      this.selectedId = nodeId;
      ctx.emit('select', nodeId ? { nodeId, x: ev.clientX, y: ev.clientY } : { nodeId: null });
    };
    this.onMove = (ev) => { this.pendingMove = { x: ev.clientX, y: ev.clientY }; };
    this.onLeave = () => { this.pendingMove = null; this.setHover(null); };
    this.onDbl = (ev) => {
      const nodeId = this.pick(ev.clientX, ev.clientY);
      if (nodeId) ctx.emit('focus', { nodeId });
    };
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerleave', this.onLeave);
    dom.addEventListener('dblclick', this.onDbl);
    this.mounted = true;
  }

  /** Recolour the scene and labels for the current page theme. Safe to call any time after mount. */
  applyTheme() {
    const name = currentTheme();
    this.theme = name;
    const page = this.tk.THEME[name], sc = SCENE[name];
    this.scene.background.set(page.bg);
    this.floorMat.color.setHex(sc.floor);
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    this.grid = new THREE.GridHelper(WORLD * 1.6, 32, sc.grid[0], sc.grid[1]);
    this.grid.position.y = -0.4;
    this.scene.add(this.grid);
    this.treeMat.color.setHex(sc.tree);
    this.stemMat.color.setHex(sc.tree);
    this.srcMat.color.setHex(sc.src);
    // Labels, ghost labels and badges read these variables, so one write restyles them all.
    const ls = this.labelRenderer.domElement.style;
    ls.setProperty('--sky-fg', page.fg);
    ls.setProperty('--sky-panel', page.panel);
    ls.setProperty('--sky-muted', page.muted);
    ls.setProperty('--sky-shadow', sc.shadow);
    // Nodes without a category (roots) use the page foreground.
    for (const st of this.nodes.values()) if (st.neutral) st.mesh.material.color.set(page.fg);
    for (const h of this.halos.values()) this.styleHalo(h.mesh.material);
  }

  /** Halos glow additively on dark; on light, additive blending vanishes, so blend normally. */
  styleHalo(mat) {
    const additive = SCENE[this.theme || 'dark'].additive;
    mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.color.setHex(additive ? 0x7fb2ff : 0x3b78d8);
    mat.needsUpdate = true;
  }

  /** Choose which wanted node labels have room on screen (see placeLabels in math.js). */
  declutter(snap, focus) {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const v = new THREE.Vector3();
    const camPos = this.camera.position;
    const prev = this.labelRoom || new Set();
    const cands = [];
    /** Screen point of a point `k` sphere radii above (or below, k < 0) a node's centre. */
    const screen = (st, k) => {
      v.set(st.mesh.position.x, st.mesh.position.y + k * (st.r || 1), st.mesh.position.z);
      v.project(this.camera);
      return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, behind: v.z > 1 };
    };
    for (const [id, st] of this.nodes) {
      const ghost = !!(st.ghost && this.ghostSet && this.ghostSet.has(id));
      if (!st.vis || (!st.wantLabel && !ghost)) continue;
      const n = snap.nodes[id];
      const dist = st.mesh.position.distanceTo(camPos);
      // One combined box per node: the name above the sphere and its lens analog below it,
      // so the pair is placed (or skipped) together. Sizes are estimated (no DOM measuring).
      const top = st.wantLabel ? screen(st, 1.6) : null; // 12px label
      const bot = ghost ? screen(st, -1.3) : null;       // 11px italic analog
      if ((top && top.behind) || (bot && bot.behind)) continue;
      const lw = top ? (st.label.element.textContent || '').length * 7 + 8 : 0;
      const short = ghost ? st.ghost.element.querySelector('.short') : null;
      const gw = short ? (short.textContent || '').length * 6.4 + 8 : 0;
      const t = top ? top.y - 8 : /** @type {{y:number}} */ (bot).y - 8;
      const b = bot ? bot.y + 8 : /** @type {{y:number}} */ (top).y + 8;
      const x = (top || /** @type {{x:number}} */ (bot)).x;
      const tier = id === this.hoveredId || id === focus || (this.cited && this.cited.nodes.has(id)) ? 0
        : n.depth <= 1 ? 1
        : (this.ghostSet && this.ghostSet.has(id)) || (this.bright && this.bright.has(id)) ? 2 : 3;
      // Fallback when the pair has no room: the name alone (the analog waits for hover or room).
      const alt = top && bot ? { x: top.x, y: top.y, w: lw, h: 16 } : undefined;
      cands.push({ id, x, y: (t + b) / 2, w: Math.max(lw, gw), h: b - t, tier, dist, was: prev.has(id), alt });
    }
    this.labelNameOnly = new Set();
    this.labelRoom = placeLabels(cands, { altPlaced: this.labelNameOnly });
  }

  /** Topmost visible node under a screen point, or null. @param {number} cx @param {number} cy */
  pick(cx, cy) {
    const dom = this.renderer.domElement;
    const r = dom.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [];
    for (const st of this.nodes.values()) if (st.vis) meshes.push(st.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.id : null;
  }

  /** @param {string|null} id */
  setHover(id) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.ctx.emit('hover', { nodeId: id });
  }

  /** Create the cross-link arc for an edge if it is not drawn yet. */
  ensureArc(edge, animate) {
    if (this.arcs.has(edge.id)) return;
    const st = this.tk.edgeStyle(edge.type);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ARC_POINTS + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const color = new THREE.Color(st.color);
    const mat = st.dash
      ? new THREE.LineDashedMaterial({ color, transparent: true, dashSize: st.dash[0] * DASH_UNIT, gapSize: st.dash[1] * DASH_UNIT })
      : new THREE.LineBasicMaterial({ color, transparent: true });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.visible = false;
    const h = 40 * treeDistance(edge.from, edge.to, this.ctx.snapshot()) * ARC_HEIGHT_SCALE;
    this.scene.add(line);
    this.arcs.set(edge.id, { line, edge, animate, start: null, h, last: [NaN], lastOp: -1 });
  }

  /** Halo ring on a node while one of its jobs runs. */
  addHalo(jobId, nodeId) {
    if (this.halos.has(jobId)) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7fb2ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.haloGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    this.scene.add(mesh);
    this.styleHalo(mat);
    this.halos.set(jobId, { mesh, nodeId });
  }

  removeHalo(jobId) {
    const h = this.halos.get(jobId);
    if (!h) return;
    this.scene.remove(h.mesh);
    h.mesh.material.dispose();
    this.halos.delete(jobId);
  }

  /** Restyle a node's sphere from its current snapshot data (status, article, sources). */
  restyle(id) {
    const st = this.nodes.get(id);
    const n = this.ctx.snapshot().nodes[id];
    if (!st || !n) return;
    st.base = n.status === 'pending' ? 0.45 : 1;
    const mat = st.mesh.material;
    if (st.citedOn) { mat.emissive.copy(mat.color); mat.emissiveIntensity = 0.9; } // chat citation glow
    else if (n.article) { mat.emissive.copy(mat.color); mat.emissiveIntensity = 0.6; }
    else { mat.emissive.setRGB(0, 0, 0); mat.emissiveIntensity = 1; }
    const noSources = !(n.sources && n.sources.length) && n.origin !== 'seed';
    if (noSources && !st.ring) { st.ring = this.srcRing.clone(); st.mesh.add(st.ring); }
    else if (!noSources && st.ring) { st.mesh.remove(st.ring); st.ring = null; }
    if (st.label.element.textContent !== n.label) st.label.element.textContent = n.label;
  }

  /** Rebuild every ghost label for the current lens (none when no lens is set).
   * Each ghost has a short form (analog cut to GHOST_CHARS, no warning mark) and a full form
   * (whole analog plus where it breaks) that frame() swaps in while the node is hovered. */
  refreshGhosts() {
    for (const st of this.nodes.values()) {
      if (st.ghost) { st.mesh.remove(st.ghost); st.ghost.element.remove(); st.ghost = null; }
    }
    if (!this.lensId) return;
    const lens = this.ctx.snapshot().lenses[this.lensId];
    if (!lens) return;
    for (const [id, a] of Object.entries(lens.analogs || {})) {
      const st = this.nodes.get(id);
      if (!st || !a) continue;
      const div = document.createElement('div');
      div.style.cssText = 'color:var(--sky-fg);font:italic 11px system-ui,sans-serif;' +
        'text-shadow:0 0 3px var(--sky-shadow);pointer-events:none;opacity:0.7;';
      const short = document.createElement('span');
      short.className = 'short';
      short.textContent = truncate(a.label, GHOST_CHARS);
      short.style.whiteSpace = 'nowrap';
      const full = document.createElement('div');
      full.className = 'full';
      full.hidden = true;
      full.style.cssText = 'font:italic 12px system-ui,sans-serif;max-width:260px;white-space:normal;padding:4px 7px;' +
        'background:var(--sky-panel);border:1px solid var(--sky-muted);border-radius:6px;text-shadow:none;';
      const head = document.createElement('div');
      head.textContent = a.label;
      full.append(head);
      if (a.breaks) {
        const br = document.createElement('div');
        br.style.cssText = 'font-style:normal;font-size:11px;margin-top:3px;color:var(--sky-muted);';
        br.textContent = `Breaks: ${a.breaks}`;
        full.append(br);
      }
      div.append(short, full);
      const g = new CSS2DObject(div);
      g.position.set(0, -1.3, 0);
      g.visible = false;
      st.mesh.add(g);
      st.ghost = g;
    }
  }

  /** Add or remove "+N" badges to match the collapsed set. */
  refreshBadges() {
    const snap = this.ctx.snapshot();
    for (const [id, st] of this.nodes) {
      const on = this.collapsed.has(id);
      if (on && !st.badge) {
        const div = document.createElement('div');
        div.style.cssText = 'color:var(--sky-fg);background:var(--sky-panel);' +
          'font:600 11px system-ui,sans-serif;padding:1px 5px;border-radius:8px;border:1px solid var(--sky-muted);pointer-events:none;';
        const b = new CSS2DObject(div);
        b.position.set(1.2, 1.1, 0);
        st.mesh.add(b);
        st.badge = b;
      } else if (!on && st.badge) {
        st.mesh.remove(st.badge);
        st.badge.element.remove();
        st.badge = null;
      }
      if (st.badge) st.badge.element.textContent = `+${descendants(id, snap)}`;
    }
  }

  /** Create sphere + label for a node if it is in the ontology and not yet drawn. */
  ensureNode(id) {
    if (this.nodes.has(id)) return;
    const ont = this.ctx.snapshot();
    const node = ont.nodes[id];
    if (!node) return;
    const tk = this.tk;
    const cat = ont.categories.find((c) => c.id === node.category);
    const color = new THREE.Color();
    if (cat) {
      const [h, s, l] = parseHsl(tk.categoryColor(cat.index, cat.family));
      color.setHSL(h / 360, s / 100, Math.min(100, l + tk.depthLightness(node.depth)) / 100);
    } else {
      color.set(tk.THEME[this.theme || 'dark'].fg);
    }
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, transparent: true });
    const mesh = new THREE.Mesh(this.sphereGeo, mat);
    mesh.userData.id = id;
    mesh.visible = false;
    this.scene.add(mesh);

    const div = document.createElement('div');
    div.textContent = node.label;
    div.style.cssText = 'color:var(--sky-fg);font:12px system-ui,sans-serif;white-space:nowrap;' +
      'text-shadow:0 0 3px var(--sky-shadow),0 1px 2px var(--sky-shadow);pointer-events:none;';
    const label = new CSS2DObject(div);
    label.visible = false;
    mesh.add(label);
    // lift: the drawn height above the floor (eases toward the mode's target); a new node starts at its parent's.
    const par = node.parent ? this.nodes.get(node.parent) : null;
    this.nodes.set(id, { mesh, label, w: null, vis: false, base: 1, lastOp: -1, spawnAt: 0, neutral: !cat, lift: par ? par.lift : 0 });
    this.heightDirty = true;
    this.restyle(id);
    this.radiiAt = 0; // descendants changed
  }

  frame() {
    const ctx = this.ctx, tk = this.tk;
    const snap = ctx.snapshot();
    // Pick up nodes that were skipped or arrived without an event.
    for (const id of Object.keys(snap.nodes)) if (!this.nodes.has(id)) this.ensureNode(id);

    const positions = ctx.layout.positions();
    const target = boundsOf(positions);
    const b = this.bounds;
    const k = BOUNDS_LERP;
    b.minX += (target.minX - b.minX) * k;
    b.minY += (target.minY - b.minY) * k;
    b.maxX += (target.maxX - b.maxX) * k;
    b.maxY += (target.maxY - b.maxY) * k;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const scale = span > 0 ? WORLD / span : 1;

    const now = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    // Height targets: recomputed when the mode or the map changed, at most every HEIGHT_RECALC_MS.
    const hkey = `${this.heightMode}|${this.nodes.size}|${snap.edges.length}`;
    if ((this.heightDirty || hkey !== this.heightKey) && now - this.heightAt > HEIGHT_RECALC_MS) {
      this.heightDirty = false;
      this.heightKey = hkey;
      this.heightAt = now;
      this.heightTargets = heightsFor(this.heightMode, snap);
    }
    const heightOn = this.heightMode !== 'off';
    this.liftMix = easeToward(this.liftMix, heightOn ? 1 : 0, dt, HEIGHT_TAU, 0.002);
    for (const [id, st] of this.nodes) {
      const want = heightOn && this.heightTargets ? (this.heightTargets.get(id) || 0) * HEIGHT_MAX : 0;
      if (st.lift !== want) st.lift = easeToward(st.lift || 0, want, dt, HEIGHT_TAU);
    }
    if (now - this.radiiAt > RADIUS_REFRESH_MS) {
      this.radiiAt = now;
      for (const [id, st] of this.nodes) {
        const n = snap.nodes[id];
        if (!n) continue;
        st.px = tk.nodeRadius(descendants(id, snap));
      }
    }

    for (const edge of snap.edges) if (!this.arcs.has(edge.id)) this.ensureArc(edge, false);

    // Derived caches, rebuilt only when the node count, focus or highlight changes.
    // The ontology may be empty at mount (no root yet): fall back to the root once it exists.
    const focus = this.focusId || snap.root || '';
    const key = `${this.nodes.size}|${snap.edges.length}|${focus}|${this.hlKey}|${this.selectedId}|${this.citeKey}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      // Chat citations: recomputed as nodes and links arrive, so they survive incoming events.
      this.cited = citedSets(this.citeIds, snap);
      this.syncCiteHalos();
      this.rings = ringsFrom(focus, snap);
      // Lens analogs shown by default: categories, plus the focus's and selection's neighbourhoods.
      this.ghostSet = new Set(neighborhood(focus, snap));
      if (this.selectedId) for (const x of neighborhood(this.selectedId, snap)) this.ghostSet.add(x);
      for (const [id, n] of Object.entries(snap.nodes)) if (n.depth === 1) this.ghostSet.add(id);
      this.bright = null;
      if (this.highlighted.length) {
        this.bright = new Set();
        for (const id of this.highlighted) for (const x of neighborhood(id, snap)) this.bright.add(x);
      }
      this.hiddenByCollapse.clear();
      if (this.collapsed.size) {
        for (const id of this.nodes.keys()) {
          let cur = snap.nodes[id] && snap.nodes[id].parent;
          const seen = new Set();
          while (cur && !seen.has(cur)) {
            if (this.collapsed.has(cur)) { this.hiddenByCollapse.add(id); break; }
            seen.add(cur);
            cur = snap.nodes[cur] ? snap.nodes[cur].parent : null;
          }
        }
      }
      this.refreshBadges();
    }

    const f = this.filter;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const zoomK = dist > 0 ? this.startDist / dist : 1;
    const dim = tk.MOTION.hoverDim;

    // Pass 1: layout world positions.
    for (const [id, st] of this.nodes) {
      const p = positions.get(id);
      st.w = p && snap.nodes[id] ? toWorld(p, b, WORLD) : null;
    }
    // Pass 2: drawn position (spawn glide), visibility, opacity, labels.
    for (const [id, st] of this.nodes) {
      const n = snap.nodes[id];
      let vis = !!(st.w && n);
      if (vis && id !== snap.root) {
        if (this.hiddenByCollapse.has(id)) vis = false;
        else if (f && f.categories && !f.categories.includes(n.category)) vis = false;
        else if (f && f.maxDepth != null && n.depth > f.maxDepth) vis = false;
      }
      st.vis = vis;
      st.mesh.visible = vis;
      if (!vis) continue;
      const r = Math.max(MIN_RADIUS, (st.px ?? tk.nodeRadius(0)) * scale);
      let [x, , z] = st.w;
      if (st.spawnAt) {
        const t = (now - st.spawnAt) / tk.MOTION.spawnMs;
        const pw = n.parent && this.nodes.get(n.parent) ? this.nodes.get(n.parent).w : null;
        if (t >= 1 || !pw) st.spawnAt = 0;
        else {
          const e = easeOutCubic(Math.max(0, t));
          x = pw[0] + (x - pw[0]) * e;
          z = pw[2] + (z - pw[2]) * e;
        }
      }
      st.mesh.position.set(x, r + st.lift, z);
      st.mesh.scale.setScalar(r);
      st.r = r;
      const isCited = !!(this.cited && this.cited.nodes.has(id));
      if (isCited !== !!st.citedOn) { st.citedOn = isCited; this.restyle(id); }
      // Cite wins on its nodes: a cited node is never dimmed, even by a search highlight.
      // Elsewhere an active search highlight decides; with no search, a citation dims the rest.
      const dimmed = !isCited && (this.bright ? !this.bright.has(id) : !!this.cited);
      const op = dimmed ? Math.min(st.base, dim) : st.base;
      if (op !== st.lastOp) {
        st.lastOp = op;
        st.mesh.material.opacity = op;
        const lop = dimmed ? dim : 1;
        st.label.element.style.opacity = String(lop);
        if (st.ghost) st.ghost.element.style.opacity = String(0.7 * lop);
        if (st.badge) st.badge.element.style.opacity = String(lop);
      }
      // Label is a child of the mesh, so its offset is in unit-sphere space.
      st.label.position.set(0, 1.6, 0);
      st.wantLabel = isCited || labelVisible(n, {
        k: zoomK, focus, hovered: this.hoveredId, rings: this.rings, rule: tk.LABEL_RULE,
      });
      // Declutter: the hovered and focused labels always show; others only if placeLabels gave them room.
      st.label.visible = st.wantLabel &&
        (isCited || id === this.hoveredId || id === focus || !this.labelRoom || this.labelRoom.has(id));
      if (st.ghost) {
        const hovered = id === this.hoveredId;
        // Shown by default only when placeLabels gave the node's combined box room.
        st.ghost.visible = hovered || (!!(this.ghostSet && this.ghostSet.has(id)) &&
          (id === focus || !this.labelRoom || (this.labelRoom.has(id) && !(this.labelNameOnly && this.labelNameOnly.has(id)))));
        const el = st.ghost.element;
        if (el.dataset.open !== String(hovered)) {
          el.dataset.open = String(hovered);
          /** @type {HTMLElement} */ (el.querySelector('.short')).hidden = hovered;
          /** @type {HTMLElement} */ (el.querySelector('.full')).hidden = !hovered;
          el.style.opacity = hovered ? '1' : String(0.7 * (dimmed ? tk.MOTION.hoverDim : 1));
          st.ghost.renderOrder = hovered ? 1 : 0;
        }
      }
      if (st.badge) st.badge.visible = true;
    }
    for (const st of this.nodes.values()) {
      if (st.vis) continue;
      st.label.visible = false;
      if (st.ghost) st.ghost.visible = false;
      if (st.badge) st.badge.visible = false;
    }

    // Parent links on the floor, between drawn positions (so they follow the spawn glide).
    if (!this.treeCap || this.nodes.size > this.treeCap) {
      this.treeCap = Math.max(64, this.nodes.size * 2);
      this.treeGeo.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(this.treeCap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    }
    const tp = this.treeGeo.attributes.position;
    let seg = 0;
    for (const [id, st] of this.nodes) {
      if (!st.vis) continue;
      const n = snap.nodes[id];
      const par = n && n.parent ? this.nodes.get(n.parent) : null;
      if (!par || !par.vis) continue;
      const a = par.mesh.position, c = st.mesh.position;
      // Flat: just above the floor. Lifted: between the sphere centres (liftMix eases between the two).
      const m = this.liftMix;
      tp.setXYZ(seg * 2, a.x, TREE_LINK_Y + par.lift + (a.y - par.lift) * m, a.z);
      tp.setXYZ(seg * 2 + 1, c.x, TREE_LINK_Y + st.lift + (c.y - st.lift) * m, c.z);
      seg++;
    }
    tp.needsUpdate = true;
    this.treeGeo.setDrawRange(0, seg * 2);
    this.treeMat.opacity = this.bright || this.cited ? 0.55 * dim : 0.55;

    // Stems: from each lifted node's foot straight down to its place on the floor.
    this.stemLines.visible = this.liftMix > 0;
    if (this.stemLines.visible) {
      if (!this.stemCap || this.nodes.size > this.stemCap) {
        this.stemCap = Math.max(64, this.nodes.size * 2);
        this.stemGeo.setAttribute('position',
          new THREE.BufferAttribute(new Float32Array(this.stemCap * 6), 3).setUsage(THREE.DynamicDrawUsage));
      }
      const sp = this.stemGeo.attributes.position;
      let ns = 0;
      for (const st of this.nodes.values()) {
        if (!st.vis || st.lift < 0.5) continue;
        const p = st.mesh.position;
        sp.setXYZ(ns * 2, p.x, 0, p.z);
        sp.setXYZ(ns * 2 + 1, p.x, st.lift, p.z);
        ns++;
      }
      sp.needsUpdate = true;
      this.stemGeo.setDrawRange(0, ns * 2);
      this.stemMat.opacity = STEM_OPACITY * this.liftMix * (this.bright || this.cited ? dim : 1);
    }

    // Arcs: endpoints at sphere centers; rewrite points in place only when an end moved.
    for (const arc of this.arcs.values()) {
      const a = this.nodes.get(arc.edge.from), c = this.nodes.get(arc.edge.to);
      const show = !!(a && c && a.vis && c.vis);
      arc.line.visible = show;
      if (!show) continue;
      const pa = a.mesh.position, pc = c.mesh.position;
      // With height on, an arc between ends at very different heights still crests above both.
      const ah = this.liftMix > 0 ? arcLift(arc.h, pa.y, pc.y) : arc.h;
      if (arc.last[0] !== pa.x || arc.last[1] !== pa.y || arc.last[2] !== pa.z || arc.last[3] !== pc.x || arc.last[4] !== pc.y || arc.last[5] !== pc.z || arc.last[6] !== ah) {
        arc.last = [pa.x, pa.y, pa.z, pc.x, pc.y, pc.z, ah];
        const pts = arcPoints([pa.x, pa.y, pa.z], [pc.x, pc.y, pc.z], ah, ARC_POINTS);
        const attr = arc.line.geometry.attributes.position;
        for (let i = 0; i < pts.length; i++) attr.setXYZ(i, pts[i][0], pts[i][1], pts[i][2]);
        attr.needsUpdate = true;
        if (arc.line.material.isLineDashedMaterial) arc.line.computeLineDistances();
      }
      let count = ARC_POINTS + 1;
      if (arc.animate) {
        if (arc.start === null) arc.start = now;
        const t = (now - arc.start) / tk.MOTION.spawnMs;
        if (t >= 1) arc.animate = false;
        else count = Math.max(2, Math.ceil((ARC_POINTS + 1) * easeOutCubic(Math.max(0, t))));
      }
      arc.line.geometry.setDrawRange(0, count);
      const citedArc = !!(this.cited && this.cited.edges.has(arc.edge.id));
      const op = citedArc ? 1
        : this.bright ? (this.bright.has(arc.edge.from) && this.bright.has(arc.edge.to) ? 0.85 : dim)
        : this.cited ? dim : 0.85;
      if (op !== arc.lastOp) { arc.lastOp = op; arc.line.material.opacity = op; }
    }

    // Halos pulse around their node.
    const pulse = 0.5 + 0.5 * Math.sin(now / 250);
    for (const h of this.halos.values()) {
      const st = this.nodes.get(h.nodeId);
      h.mesh.visible = !!(st && st.vis);
      if (!h.mesh.visible) continue;
      h.mesh.position.set(st.mesh.position.x, 0.6 + st.lift, st.mesh.position.z);
      h.mesh.scale.setScalar(st.r * (1 + 0.3 * pulse));
      h.mesh.material.opacity = 0.25 + 0.5 * (1 - pulse);
    }

    // Cited nodes: a steady glow ring, breathing slowly (job halos pulse faster).
    const breathe = 0.5 + 0.5 * Math.sin(now / 700);
    for (const [nid, mesh] of this.citeHalos) {
      const st = this.nodes.get(nid);
      mesh.visible = !!(st && st.vis);
      if (!mesh.visible) continue;
      mesh.position.set(st.mesh.position.x, 0.7 + st.lift, st.mesh.position.z);
      mesh.scale.setScalar(st.r * (1.15 + 0.1 * breathe));
      mesh.material.opacity = 0.55 + 0.3 * breathe;
    }

    // Once per cite() call: if every cited node is off-screen, ease the camera to their centroid.
    if (this.citePending && this.cited) {
      const pts = [], ndc = [];
      for (const nid of this.cited.nodes) {
        const st = this.nodes.get(nid);
        if (!st || !st.vis) continue;
        pts.push(/** @type {[number, number, number]} */ ([st.mesh.position.x, st.mesh.position.y, st.mesh.position.z]));
        const q = st.mesh.position.clone().project(this.camera);
        ndc.push({ x: q.x, y: q.y, z: q.z });
      }
      if (pts.length) {
        this.citePending = false;
        const c = centroid(pts);
        if (c && allOffscreen(ndc)) {
          this.glide = { id: null, point: new THREE.Vector3(c[0], c[1], c[2]), from: this.controls.target.clone(), start: now };
        }
      }
    }

    // Camera glide toward the focus node (or a cited centroid), keeping the view angle (camera moves by the target's offset).
    if (this.glide) {
      const g = this.glide;
      const st = g.id ? this.nodes.get(g.id) : null;
      const dest = g.point || (st && st.vis ? st.mesh.position : null);
      if (!dest) this.glide = null;
      else {
        const t = Math.min(1, (now - g.start) / tk.MOTION.focusMs);
        const next = g.from.clone().lerp(dest, easeInOut(t));
        const delta = next.clone().sub(this.controls.target);
        this.camera.position.add(delta);
        this.controls.target.copy(next);
        if (t >= 1) this.glide = null;
      }
    }

    if (this.needTilt) {
      this.needTilt = false;
      const off = this.camera.position.clone().sub(this.controls.target);
      const r = off.length();
      const polar = Math.acos(Math.min(1, Math.max(-1, off.y / (r || 1))));
      if (r > 0 && polar < TILT_FROM) {
        const h = Math.hypot(off.x, off.z);
        const az = h > 1e-6 ? Math.atan2(off.z, off.x) : Math.PI / 2;
        const to = new THREE.Vector3(Math.cos(az) * Math.sin(TILT_TO), Math.cos(TILT_TO), Math.sin(az) * Math.sin(TILT_TO)).multiplyScalar(r);
        this.tilt = { from: off, to, start: now };
      }
    }
    // Tilt toward a side view (setHeight), keeping the distance to the target.
    if (this.tilt) {
      const k = Math.min(1, (now - this.tilt.start) / tk.MOTION.focusMs);
      const dir = this.tilt.from.clone().lerp(this.tilt.to, easeInOut(k)).setLength(this.tilt.to.length());
      this.camera.position.copy(this.controls.target).add(dir);
      this.camera.lookAt(this.controls.target);
      if (k >= 1) this.tilt = null;
    }

    // At most one raycast per animation frame for hover.
    if (this.pendingMove) {
      const m = this.pendingMove;
      this.pendingMove = null;
      this.setHover(this.pick(m.x, m.y));
    }

    // Re-place labels every few frames (and at once when hover or focus changes), not every frame.
    this.frameNo = (this.frameNo || 0) + 1;
    const lkey = `${this.hoveredId}|${focus}|${this.selectedId}`;
    if (this.frameNo % LABEL_EVERY === 0 || lkey !== this.labelKey) {
      this.labelKey = lkey;
      this.declutter(snap, focus);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** @param {{ t: string }} event */
  apply(event) {
    const e = /** @type {any} */ (event);
    switch (event.t) {
      case 'node.added': {
        this.ensureNode(e.node.id);
        const st = this.nodes.get(e.node.id);
        if (st && this.mounted) st.spawnAt = performance.now();
        if (this.lensId) this.refreshGhosts();
        break;
      }
      case 'node.updated':
        this.restyle(e.id);
        this.heightDirty = true; // an article or sources change coverage
        break;
      case 'edge.added':
        this.ensureArc(e.edge, true);
        this.heightDirty = true;
        break;
      case 'job.queued':
      case 'job.started':
        if (e.job && e.job.nodeId) this.addHalo(e.job.id, e.job.nodeId);
        break;
      case 'job.done':
      case 'job.failed':
        if (e.job) this.removeHalo(e.job.id);
        break;
      case 'lens.added':
        if (e.lens && e.lens.id === this.lensId) this.refreshGhosts();
        break;
      case 'lens.analog':
        if (e.lensId === this.lensId) this.refreshGhosts();
        break;
      case 'view.changed':
        if (e.patch && Array.isArray(e.patch.collapsed)) {
          this.collapsed = new Set(e.patch.collapsed);
          this.cacheKey = ''; // rebuild hidden set and badges
        }
        if (e.patch && e.patch.focus) this.setFocus(e.patch.focus);
        break;
      default:
        break;
    }
  }

  /** @param {string} id */
  setFocus(id) {
    const st = this.nodes.get(id);
    if (!st) return;
    this.focusId = id;
    this.glide = { id, from: this.controls.target.clone(), start: performance.now() };
  }
  /** @param {string|null} id */
  setLens(id) {
    this.lensId = id;
    this.refreshGhosts();
  }
  setFilter(f) { this.filter = f; }
  /** Height: lift nodes by one measure ('learning', 'coverage', 'connectedness'); 'off' is the flat floor.
   * Nodes ease to their new heights; the orbit target rises with them so the lifted map stays framed.
   * @param {string} mode */
  setHeight(mode) {
    const next = /** @type {readonly string[]} */ (HEIGHT_MODES).includes(mode) ? mode : 'off';
    if (next === this.heightMode) return;
    const was = this.heightMode !== 'off', on = next !== 'off';
    this.heightMode = next;
    this.heightDirty = true;
    this.heightAt = 0; // recompute on the next frame
    if (this.mounted && was !== on && !this.glide) {
      const from = this.controls.target.clone();
      const point = from.clone();
      point.y += (on ? 1 : -1) * HEIGHT_MAX * HEIGHT_CAMERA;
      if (!on) point.y = Math.max(0, point.y);
      this.glide = { id: null, point, from, start: performance.now() };
    }
    // Height reads only from the side: once a mode is on, a camera looking nearly straight down is
    // tilted (on the next frame, so it also happens when a saved mode is restored as the view mounts).
    if (on && !was) this.needTilt = true;
    if (!on) this.needTilt = false;
  }
  /** @param {string[]} ids */
  /** Chat citations: exactly these nodes and the links between them stay bright, their labels
   * always show, everything else dims. null or [] clears. Independent of highlight() (search).
   * @param {string[]|null} ids */
  cite(ids) {
    this.citeIds = ids && ids.length ? [...ids] : null;
    this.citeKey = (this.citeKey || 0) + 1;
    this.citePending = !!this.citeIds;
  }

  /** Keep one glow ring per cited node. */
  syncCiteHalos() {
    const want = this.cited ? this.cited.nodes : new Set();
    for (const [nid, mesh] of this.citeHalos) {
      if (want.has(nid)) continue;
      this.scene.remove(mesh); mesh.material.dispose(); this.citeHalos.delete(nid);
    }
    for (const nid of want) {
      if (this.citeHalos.has(nid)) continue;
      const mat = new THREE.MeshBasicMaterial({ color: 0xf2b84b, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(this.haloGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.scene.add(mesh);
      this.citeHalos.set(nid, mesh);
    }
  }

  highlight(ids) {
    this.highlighted = ids || [];
    this.hlKey = (this.hlKey || 0) + 1;
  }

  unmount() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    if (!this.mounted) return;
    this.mounted = false;
    this.ctx.layout.off('tick', this.tick);
    this.ro.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onDown);
    dom.removeEventListener('pointerup', this.onUp);
    dom.removeEventListener('pointermove', this.onMove);
    dom.removeEventListener('pointerleave', this.onLeave);
    dom.removeEventListener('dblclick', this.onDbl);
    this.glide = null;
    for (const { line } of this.arcs.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this.arcs.clear();
    for (const id of [...this.halos.keys()]) this.removeHalo(id);
    for (const mesh of this.citeHalos.values()) { this.scene.remove(mesh); mesh.material.dispose(); }
    this.citeHalos.clear();
    this.haloGeo.dispose();
    this.srcGeo.dispose();
    this.srcMat.dispose();
    this.scene.remove(this.treeLines);
    this.treeGeo.dispose();
    this.treeMat.dispose();
    this.scene.remove(this.stemLines);
    this.stemGeo.dispose();
    this.stemMat.dispose();
    this.controls.removeEventListener('start', this.onStart);
    this.controls.removeEventListener('end', this.onEnd);
    this.controls.dispose();
    for (const { mesh, label, ghost, badge } of this.nodes.values()) {
      mesh.material.dispose();
      mesh.remove(label);
      label.element.remove();
      if (ghost) { mesh.remove(ghost); ghost.element.remove(); }
      if (badge) { mesh.remove(badge); badge.element.remove(); }
      this.scene.remove(mesh);
    }
    this.nodes.clear();
    this.sphereGeo.dispose();
    this.floorGeo.dispose();
    this.floorMat.dispose();
    if (this.grid) { this.grid.geometry.dispose(); this.grid.material.dispose(); }
    document.removeEventListener('onto-theme', this.onTheme);
    if (this.mql) this.mql.removeEventListener('change', this.onTheme);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}

if (globalThis.customElements) {
  if (!customElements.get('onto-sky')) customElements.define('onto-sky', OntoSky);
  registerView('sky-3d', '3D', 'onto-sky');
}
