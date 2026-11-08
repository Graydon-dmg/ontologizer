// @ts-check
// <onto-sky>: the 3D "Floor and Sky" view. Reads the shared layout (never writes it).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { registerView } from '../../shared/view.js';
import { boundsOf, toWorld } from './math.js';
import { descendants } from './graphmath.js';

const WORLD = 600;
const MIN_RADIUS = 3;
const IDLE_MS = 5000;
const BOUNDS_LERP = 0.1;
const RADIUS_REFRESH_MS = 500;

/** Parse 'hsl(210 68% 58%)' into [h, s, l]. */
function parseHsl(css) {
  const m = /hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(css);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 60];
}

class OntoSky extends (globalThis.HTMLElement || Object) {
  constructor() {
    super();
    /** @type {Map<string, { mesh: any, label: any }>} */
    this.nodes = new Map();
    this.focusId = '';
    this.lensId = null;
    this.filter = null;
    this.highlighted = [];
    this.raf = 0;
    this.idleTimer = 0;
    this.mounted = false;
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
    scene.background = new THREE.Color(tk.THEME.dark.bg);
    this.scene = scene;
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    camera.position.set(WORLD * 0.55, WORLD * 0.75, WORLD * 0.95);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 600, 200);
    scene.add(sun);

    // Floor: dark disc plus a faint grid.
    const floorGeo = new THREE.CircleGeometry(WORLD * 0.8, 64);
    const floorMat = new THREE.MeshBasicMaterial({ color: 0x151922, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.5;
    scene.add(floor);
    const grid = new THREE.GridHelper(WORLD * 1.6, 32, 0x2a3040, 0x1e2330);
    grid.position.y = -0.4;
    scene.add(grid);
    this.floorParts = [floor, grid];
    this.floorGeo = floorGeo;
    this.floorMat = floorMat;

    this.sphereGeo = new THREE.SphereGeometry(1, 24, 16);

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

    const snap = ctx.snapshot();
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
    this.mounted = true;
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
      color.set(tk.THEME.dark.fg);
    }
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
    const mesh = new THREE.Mesh(this.sphereGeo, mat);
    mesh.userData.id = id;
    mesh.visible = false;
    this.scene.add(mesh);

    const div = document.createElement('div');
    div.textContent = node.label;
    div.style.cssText = `color:${tk.THEME.dark.fg};font:12px system-ui,sans-serif;white-space:nowrap;` +
      'text-shadow:0 0 3px #000,0 1px 2px #000;pointer-events:none;';
    const label = new CSS2DObject(div);
    label.visible = false;
    mesh.add(label);
    this.nodes.set(id, { mesh, label });
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
    if (now - this.radiiAt > RADIUS_REFRESH_MS) {
      this.radiiAt = now;
      for (const [id, st] of this.nodes) {
        const n = snap.nodes[id];
        if (!n) continue;
        st.px = tk.nodeRadius(descendants(id, snap));
      }
    }

    for (const [id, st] of this.nodes) {
      const p = positions.get(id);
      const n = snap.nodes[id];
      if (!p || !n) { st.mesh.visible = false; continue; }
      const r = Math.max(MIN_RADIUS, (st.px ?? tk.nodeRadius(0)) * scale);
      const w = toWorld(p, b, WORLD);
      st.mesh.position.set(w[0], r, w[2]);
      st.mesh.scale.setScalar(r);
      st.mesh.visible = true;
      // Label is a child of the mesh, so its offset is in unit-sphere space.
      st.label.position.set(0, 1.6, 0);
      st.label.visible = n.depth <= tk.LABEL_RULE.alwaysDepth || id === this.focusId;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** @param {{ t: string }} event */
  apply(event) {
    switch (event.t) {
      case 'node.added':
        this.ensureNode(/** @type {any} */ (event).node.id);
        break;
      default:
        break; // W3 adds the rest
    }
  }

  /** @param {string} id */
  setFocus(id) { this.focusId = id; }
  /** @param {string|null} id */
  setLens(id) { this.lensId = id; }
  setFilter(f) { this.filter = f; }
  /** @param {string[]} ids */
  highlight(ids) { this.highlighted = ids; }

  unmount() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    if (!this.mounted) return;
    this.mounted = false;
    this.ctx.layout.off('tick', this.tick);
    this.ro.disconnect();
    this.controls.removeEventListener('start', this.onStart);
    this.controls.removeEventListener('end', this.onEnd);
    this.controls.dispose();
    for (const { mesh, label } of this.nodes.values()) {
      mesh.material.dispose();
      mesh.remove(label);
      label.element.remove();
      this.scene.remove(mesh);
    }
    this.nodes.clear();
    this.sphereGeo.dispose();
    this.floorGeo.dispose();
    this.floorMat.dispose();
    for (const o of this.floorParts) if (o.geometry && o !== this.floorParts[0]) { o.geometry.dispose(); o.material.dispose(); }
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }
}

if (globalThis.customElements) {
  if (!customElements.get('onto-sky')) customElements.define('onto-sky', OntoSky);
  registerView('sky-3d', '3D', 'onto-sky');
}
