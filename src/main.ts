import * as THREE from 'three';

type ObjectKind = 'evil' | 'good';

interface KaoParticle {
  mesh: THREE.Sprite;
  ox: number;
  oy: number;
  oz: number;
}

interface RhythmObject {
  id: number;
  kind: ObjectKind;
  symbol: string;
  group: THREE.Group;
  particles: KaoParticle[];
  speed: number;
  hit: boolean;
}

interface FlyParticle {
  mesh: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
}

interface PointerPoint {
  x: number;
  y: number;
  t: number;
}

class AudioEngine {
  readonly context = new AudioContext();
  readonly master = this.context.createGain();
  readonly distortion = this.context.createWaveShaper();
  readonly compressor = this.context.createDynamicsCompressor();
  private readonly layers: GainNode[] = [];
  private readonly layerPitches = [110, 220, 330, 495];
  private readonly pulseOsc = this.context.createOscillator();
  private readonly pulseGain = this.context.createGain();
  bpm = 88;
  private unstable = 0;

  constructor() {
    this.master.gain.value = 0.8;
    this.distortion.curve = this.makeDistCurve(80);
    this.distortion.oversample = '4x';
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;
    this.pulseOsc.type = 'triangle';
    this.pulseOsc.frequency.value = 44;
    this.pulseGain.gain.value = 0;
    this.pulseOsc.connect(this.pulseGain).connect(this.master);
    this.pulseOsc.start();
    this.master.connect(this.context.destination);
    this.createLayers();
  }

  async start() {
    if (this.context.state !== 'running') await this.context.resume();
  }

  private createLayers() {
    const baseMix = [0.35, 0, 0, 0];
    this.layerPitches.forEach((frequency, i) => {
      const osc = this.context.createOscillator();
      const filter = this.context.createBiquadFilter();
      const tremolo = this.context.createGain();
      const lfo = this.context.createOscillator();
      const lfoGain = this.context.createGain();
      const out = this.context.createGain();
      osc.type = i % 2 === 0 ? 'sawtooth' : 'square';
      osc.frequency.value = frequency;
      filter.type = 'bandpass';
      filter.frequency.value = 240 + i * 240;
      filter.Q.value = 1.6 + i * 0.5;
      tremolo.gain.value = 0.8;
      lfo.frequency.value = 2 + i * 0.6;
      lfoGain.gain.value = 0.25;
      lfo.connect(lfoGain).connect(tremolo.gain);
      out.gain.value = baseMix[i];
      osc.connect(filter).connect(tremolo).connect(out).connect(this.compressor);
      lfo.start();
      osc.start();
      this.layers.push(out);
    });
    this.compressor.connect(this.master);
  }

  setLayerUnlock(level: number) {
    this.layers.forEach((layer, i) => {
      const target = i <= level ? 0.35 - i * 0.04 : 0;
      layer.gain.linearRampToValueAtTime(target, this.context.currentTime + 0.2);
    });
  }

  pulse(intensity: number) {
    const now = this.context.currentTime;
    const beatDur = 60 / this.bpm;
    this.pulseGain.gain.cancelScheduledValues(now);
    this.pulseGain.gain.setValueAtTime(0, now);
    this.pulseGain.gain.linearRampToValueAtTime(0.24 * intensity, now + 0.01);
    this.pulseGain.gain.exponentialRampToValueAtTime(0.001, now + beatDur * 0.6);
  }

  setBpm(next: number) {
    this.bpm = Math.min(175, Math.max(88, next));
    this.pulseOsc.frequency.setTargetAtTime(this.bpm / 2, this.context.currentTime, 0.1);
  }

  addCorruption(value: number) {
    this.unstable = THREE.MathUtils.clamp(this.unstable + value, 0, 1);
    const dry = 1 - this.unstable;
    this.master.disconnect();
    this.compressor.disconnect();
    if (this.unstable > 0.01) {
      this.compressor.connect(this.distortion).connect(this.master);
      this.master.gain.setTargetAtTime(0.75 * dry + 0.15, this.context.currentTime, 0.15);
    } else {
      this.compressor.connect(this.master);
      this.master.gain.setTargetAtTime(0.82, this.context.currentTime, 0.1);
    }
  }

  calmDown(amount: number) { this.addCorruption(-amount); }

  private makeDistCurve(amount: number) {
    const n = 44100;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
}

class RhythmRiftGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 200);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });

  private readonly overlay = document.createElement('div');
  private readonly hud = document.createElement('div');
  private readonly dangerVignette = document.createElement('div');
  private readonly trailCanvas = document.createElement('canvas');
  private readonly trailCtx: CanvasRenderingContext2D;

  private readonly audio = new AudioEngine();
  private readonly stars = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0x88b8ff, size: 0.06, transparent: true, opacity: 0.6 }),
  );

  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly slashTrail: PointerPoint[] = [];
  private readonly flyParticles: FlyParticle[] = [];

  private currentObject: RhythmObject | null = null;
  private spawnCooldown = 0.6;

  private nextId = 1;
  private combo = 0;
  private score = 0;
  private energy = 0;
  private corruption = 0;
  private bpm = 88;
  private musicLayer = 0;
  private running = false;
  private songTime = 0;
  private shakeAmount = 0;
  private lastTime = 0;

  constructor(private readonly mount: HTMLElement) {
    this.camera.position.z = 6;
    this.scene.fog = new THREE.FogExp2(0x020207, 0.055);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mount.appendChild(this.renderer.domElement);

    const ctx = this.trailCanvas.getContext('2d');
    if (!ctx) throw new Error('no 2d ctx');
    this.trailCtx = ctx;
    this.trailCanvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4;';
    this.resizeTrail();
    document.body.appendChild(this.trailCanvas);

    this.dangerVignette.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:3;';
    document.body.appendChild(this.dangerVignette);

    this.injectStyles();
    this.buildHud();
    this.showOverlay('start');
    this.initStars();
    this.scene.add(this.stars);
    this.bindEvents();
    this.updateHud();
  }

  private injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      @keyframes floatUp {
        0%   { opacity:1; transform:translate(-50%,-50%) scale(1.15); }
        100% { opacity:0; transform:translate(-50%,-160%) scale(0.7); }
      }
      #rhud {
        position:fixed; left:18px; top:14px; z-index:5;
        font-family:'JetBrains Mono','Fira Code',monospace; font-size:11px;
        color:#d8f7ff; display:flex; flex-direction:column; gap:5px; min-width:170px;
      }
      .hr { display:flex; align-items:center; gap:7px; }
      .hl { color:#5ab8d4; font-size:10px; letter-spacing:1px; width:56px; flex-shrink:0; }
      .hv { color:#fff; font-weight:bold; min-width:40px; text-align:right; font-size:12px; }
      .hb { flex:1; height:5px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; }
      .hbf { height:100%; border-radius:3px; transition:width 0.1s; }
      .ef { background:linear-gradient(90deg,#00ffcc,#00aaff); }
      .cf { background:linear-gradient(90deg,#ff4477,#ff0044); }
      .bf { background:linear-gradient(90deg,#aa44ff,#6622cc); }
      #slash-zone {
        position:fixed; left:0; right:0; top:50%; height:50%;
        border-top:1px solid rgba(255,255,255,0.05);
        pointer-events:none; z-index:2;
      }
    `;
    document.head.appendChild(s);

    const zone = document.createElement('div');
    zone.id = 'slash-zone';
    document.body.appendChild(zone);
  }

  private buildHud() {
    this.hud.id = 'rhud';
    this.hud.innerHTML = `
      <div class="hr"><span class="hl">SCORE</span><span class="hv" id="hs">0</span></div>
      <div class="hr"><span class="hl">COMBO</span><span class="hv" id="hc">×0</span></div>
      <div class="hr"><span class="hl">ENERGY</span><div class="hb"><div class="hbf ef" id="he" style="width:0%"></div></div></div>
      <div class="hr"><span class="hl">CORRUPT</span><div class="hb"><div class="hbf cf" id="hco" style="width:0%"></div></div></div>
      <div class="hr"><span class="hl">BPM</span><div class="hb"><div class="hbf bf" id="hbp" style="width:0%"></div></div><span class="hv" id="hbv" style="font-size:10px">88</span></div>
    `;
    document.body.appendChild(this.hud);
  }

  private showOverlay(mode: 'start' | 'win' | 'lose', s = 0) {
    this.overlay.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;z-index:6;background:linear-gradient(180deg,#050510dd,#020207ee);font-size:clamp(18px,3vw,34px);text-align:center;padding:24px;cursor:pointer;font-family:JetBrains Mono,monospace;color:#d8f7ff;';
    if (mode === 'start') {
      this.overlay.innerHTML = `Kao0m0oji Rhythm Rift<br/><br/><span style="font-size:0.46em;line-height:2.3;opacity:0.85">Swipe to <span style="color:#ff4466">SLASH</span> evil kaomoji&nbsp; (ಠ_ಠ)<br/>Tap to <span style="color:#44ffcc">COLLECT</span> good signals&nbsp; (◕‿◕)<br/><br/>Touch or Click to start</span>`;
    } else if (mode === 'win') {
      this.overlay.innerHTML = `<span style="color:#44ffcc">PURIFIED</span><br/><br/><span style="font-size:0.5em">Score&nbsp;<b>${s}</b><br/><br/>Click to replay</span>`;
    } else {
      this.overlay.innerHTML = `<span style="color:#ff4466">Signal Lost</span><br/><br/><span style="font-size:0.5em">Score&nbsp;<b>${s}</b><br/><br/>Click to restart</span>`;
    }
    document.body.appendChild(this.overlay);
  }

  private resizeTrail() {
    this.trailCanvas.width = window.innerWidth;
    this.trailCanvas.height = window.innerHeight;
  }

  private bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.resizeTrail();
    });

    this.overlay.addEventListener('pointerdown', async () => {
      await this.audio.start();
      this.resetRun();
      this.running = true;
      this.overlay.remove();
      this.lastTime = performance.now();
      requestAnimationFrame(this.frame);
    });

    const canvas = this.renderer.domElement;

    canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
      const p = this.toNdc(ev.clientX, ev.clientY);
      this.slashTrail.length = 0;
      this.slashTrail.push({ x: p.x, y: p.y, t: performance.now() });
      this.tryTap(ev.clientX, ev.clientY);
    });

    canvas.addEventListener('pointermove', (ev: PointerEvent) => {
      if ((ev.buttons & 1) === 0 && ev.pointerType !== 'touch') return;
      const p = this.toNdc(ev.clientX, ev.clientY);
      this.slashTrail.push({ x: p.x, y: p.y, t: performance.now() });
      while (this.slashTrail.length > 16) this.slashTrail.shift();
      this.trySlash();
    });
  }

  private resetRun() {
    if (this.currentObject) {
      this.scene.remove(this.currentObject.group);
      this.currentObject = null;
    }
    for (const fp of this.flyParticles) {
      this.scene.remove(fp.mesh);
      (fp.mesh.material as THREE.Material).dispose();
    }
    this.flyParticles.length = 0;
    this.combo = 0;
    this.score = 0;
    this.energy = 0;
    this.corruption = 0;
    this.bpm = 88;
    this.musicLayer = 0;
    this.audio.setBpm(this.bpm);
    this.audio.setLayerUnlock(0);
    this.audio.calmDown(1);
    this.spawnCooldown = 0.6;
    this.songTime = 0;
    this.shakeAmount = 0;
    this.updateHud();
  }

  private toNdc(clientX: number, clientY: number) {
    return {
      x: (clientX / window.innerWidth) * 2 - 1,
      y: -(clientY / window.innerHeight) * 2 + 1,
    };
  }

  private initStars() {
    const count = 1800;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 60;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 45;
      pos[i * 3 + 2] = -Math.random() * 180;
    }
    this.stars.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  }

  private buildCharTexture(char: string, color: string): THREE.Texture {
    const key = `c::${char}::${color}`;
    if (this.textureCache.has(key)) return this.textureCache.get(key)!;
    const W = 64;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = W;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, W);
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = color;
    ctx.fillText(char, W / 2, W / 2);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(char, W / 2, W / 2);
    const tex = new THREE.CanvasTexture(canvas);
    this.textureCache.set(key, tex);
    return tex;
  }

  // Samples the kaomoji shape from a canvas and creates a particle cloud.
  private buildKaomoji(symbol: string, color: string): { group: THREE.Group; particles: KaoParticle[] } {
    const W = 320, H = 130;
    const offscreen = document.createElement('canvas');
    offscreen.width = W; offscreen.height = H;
    const ctx = offscreen.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.font = 'bold 82px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(symbol, W / 2, H / 2);

    const imgData = ctx.getImageData(0, 0, W, H);
    const sampled: { x: number; y: number }[] = [];
    const step = 7;
    for (let py = 0; py < H; py += step) {
      for (let px = 0; px < W; px += step) {
        if (imgData.data[(py * W + px) * 4] > 110) {
          sampled.push({
            x: (px / W - 0.5) * 4.8,
            y: (0.5 - py / H) * 1.9,
          });
        }
      }
    }

    const chars = [...symbol].filter(c => c.trim().length > 0);
    if (chars.length === 0) chars.push('·');

    const group = new THREE.Group();
    const particles: KaoParticle[] = [];

    sampled.forEach((pt, i) => {
      const char = chars[i % chars.length];
      const tex = this.buildCharTexture(char, color);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      const oz = (Math.random() - 0.5) * 0.45;
      sprite.position.set(pt.x, pt.y, oz);
      sprite.scale.set(0.3, 0.3, 1);
      group.add(sprite);
      particles.push({ mesh: sprite, ox: pt.x, oy: pt.y, oz });
    });

    return { group, particles };
  }

  private spawnObject() {
    const evilSymbols = ['(ಠ_ಠ)', '(╬Ò﹏Ó)', '(◣_◢)', '(×_×)', 'ヽ(ಠ益ಠ)ﾉ'];
    const goodSymbols = ['(◕‿◕)', '(｡♥‿♥｡)', '(ﾉ◕ヮ◕)ﾉ', '(◠‿◠✿)'];
    const kind: ObjectKind = Math.random() < 0.62 ? 'evil' : 'good';
    const syms = kind === 'evil' ? evilSymbols : goodSymbols;
    const symbol = syms[Math.floor(Math.random() * syms.length)];
    const color = kind === 'evil' ? '#ff4466' : '#44ffcc';

    const { group, particles } = this.buildKaomoji(symbol, color);

    // Lower half of screen, slight random X
    const x = (Math.random() - 0.5) * 3.5;
    const y = -1.4 - Math.random() * 0.7;
    group.position.set(x, y, -36);
    this.scene.add(group);

    this.currentObject = {
      id: this.nextId++,
      kind,
      symbol,
      group,
      particles,
      speed: 7.5 + Math.random() * 2 + this.bpm * 0.014,
      hit: false,
    };
  }

  private tryTap(clientX: number, clientY: number) {
    const obj = this.currentObject;
    if (!obj || obj.hit || obj.kind !== 'good') return;
    const screen = obj.group.position.clone().project(this.camera);
    const tap = this.toNdc(clientX, clientY);
    if (Math.hypot(screen.x - tap.x, screen.y - tap.y) < 0.42) {
      obj.hit = true;
      this.collectGood(obj, clientX, clientY);
    }
  }

  private trySlash() {
    const obj = this.currentObject;
    if (!obj || obj.hit) return;
    if (this.slashTrail.length < 2) return;

    const a = this.slashTrail[this.slashTrail.length - 2];
    const b = this.slashTrail[this.slashTrail.length - 1];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = Math.max(1, b.t - a.t);
    if (dist / dt < 0.0006 || dist < 0.015) return;

    const screen = obj.group.position.clone().project(this.camera);
    const cx = (a.x + b.x) * 0.5;
    const cy = (a.y + b.y) * 0.5;
    const toObjX = screen.x - cx;
    const toObjY = screen.y - cy;
    const dir = new THREE.Vector2(b.x - a.x, b.y - a.y).normalize();
    const distToLine = Math.abs(toObjX * (-dir.y) + toObjY * dir.x);

    if (distToLine < 0.28 && Math.hypot(toObjX, toObjY) < 0.72) {
      obj.hit = true;
      if (obj.kind === 'evil') {
        this.slashEvil(obj, dir);
      } else {
        this.missGood(obj);
      }
    }
  }

  private worldToClient(pos: THREE.Vector3) {
    const v = pos.clone().project(this.camera);
    return {
      x: (v.x + 1) / 2 * window.innerWidth,
      y: (-v.y + 1) / 2 * window.innerHeight,
    };
  }

  private popText(text: string, x: number, y: number, color: string) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `position:fixed;left:${x}px;top:${y}px;font-family:'JetBrains Mono',monospace;font-size:21px;font-weight:bold;color:${color};text-shadow:0 0 14px ${color};pointer-events:none;z-index:10;white-space:nowrap;animation:floatUp 0.65s ease-out forwards;`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 700);
  }

  private launchParticles(obj: RhythmObject, velFn: (p: KaoParticle, i: number) => THREE.Vector3) {
    obj.particles.forEach((p, i) => {
      const worldPos = new THREE.Vector3();
      obj.group.localToWorld(worldPos.copy(p.mesh.position));
      p.mesh.removeFromParent();
      p.mesh.position.copy(worldPos);
      this.scene.add(p.mesh);
      this.flyParticles.push({
        mesh: p.mesh,
        vel: velFn(p, i),
        life: 0.85 + Math.random() * 0.45,
      });
    });
    this.scene.remove(obj.group);
    this.currentObject = null;
  }

  private slashEvil(obj: RhythmObject, dir: THREE.Vector2) {
    this.combo++;
    this.score += 150 + this.combo * 10;
    this.energy = Math.min(100, this.energy + 3);
    this.audio.pulse(1.2);
    this.audio.calmDown(0.07);
    this.spawnCooldown = 0.55;

    const sc = this.worldToClient(obj.group.position);
    this.popText(`SLASH ×${this.combo}`, sc.x, sc.y - 20, '#ff88cc');

    // Normal perpendicular to slash — determines which half each particle goes to
    const nx = -dir.y;
    const ny = dir.x;
    const groupScreen = obj.group.position.clone().project(this.camera);

    this.launchParticles(obj, (p) => {
      const worldPos = new THREE.Vector3();
      obj.group.localToWorld(worldPos.copy(p.mesh.position));
      const ps = worldPos.clone().project(this.camera);
      const dot = (ps.x - groupScreen.x) * nx + (ps.y - groupScreen.y) * ny;
      const side = dot >= 0 ? 1 : -1;
      const speed = 0.035 + Math.random() * 0.045;
      return new THREE.Vector3(
        dir.x * side * speed + (Math.random() - 0.5) * 0.025,
        dir.y * side * speed + (Math.random() - 0.5) * 0.025 + 0.012,
        (Math.random() - 0.5) * 0.03,
      );
    });

    const nextLayer = Math.min(3, Math.floor(this.energy / 25));
    if (nextLayer !== this.musicLayer) {
      this.musicLayer = nextLayer;
      this.audio.setLayerUnlock(this.musicLayer);
    }
  }

  private collectGood(obj: RhythmObject, cx: number, cy: number) {
    this.score += 120;
    this.energy = Math.min(100, this.energy + 8);
    this.combo++;
    this.bpm = Math.min(175, this.bpm + 2);
    this.audio.setBpm(this.bpm);
    this.spawnCooldown = 0.55;
    this.popText('♥ TUNE', cx, cy - 20, '#44ffcc');

    this.launchParticles(obj, () => new THREE.Vector3(
      (Math.random() - 0.5) * 0.08,
      0.04 + Math.random() * 0.07,
      (Math.random() - 0.5) * 0.04,
    ));

    const nextLayer = Math.min(3, Math.floor(this.energy / 25));
    if (nextLayer !== this.musicLayer) {
      this.musicLayer = nextLayer;
      this.audio.setLayerUnlock(this.musicLayer);
    }
  }

  private missEvil() {
    this.combo = 0;
    this.corruption = Math.min(100, this.corruption + 14);
    this.shakeAmount = 0.26;
    this.audio.addCorruption(0.22);
    this.spawnCooldown = 0.7;
  }

  private missGood(obj: RhythmObject) {
    this.combo = 0;
    this.corruption = Math.min(100, this.corruption + 8);
    this.shakeAmount = 0.14;
    this.audio.addCorruption(0.12);
    this.scene.remove(obj.group);
    obj.particles.forEach(p => (p.mesh.material as THREE.Material).dispose());
    this.currentObject = null;
    this.spawnCooldown = 0.7;
  }

  private updateObject(dt: number) {
    const obj = this.currentObject;
    if (!obj) return;

    // If hit was set externally (by trySlash/tryTap), launchParticles already nulled currentObject.
    // This guard catches the case where missEvil was called and object needs cleanup.
    if (obj.hit) {
      this.currentObject = null;
      return;
    }

    obj.group.position.z += obj.speed * dt;

    // Gentle breathing animation on particles
    const t = performance.now() / 1000;
    obj.particles.forEach((p, i) => {
      p.mesh.position.x = p.ox + Math.sin(t * 2.2 + i * 0.28) * 0.016;
      p.mesh.position.y = p.oy + Math.cos(t * 1.8 + i * 0.22) * 0.012;
    });

    // Evil objects flash when in danger zone (close to camera)
    if (obj.kind === 'evil' && obj.group.position.z > 0.5) {
      const flash = 0.6 + Math.sin(t * 22) * 0.4;
      obj.particles.forEach(p => { p.mesh.material.opacity = flash; });
    }

    if (obj.group.position.z > 4.2) {
      obj.hit = true;
      if (obj.kind === 'evil') {
        this.missEvil();
        this.scene.remove(obj.group);
        obj.particles.forEach(p => (p.mesh.material as THREE.Material).dispose());
      } else {
        this.scene.remove(obj.group);
        this.spawnCooldown = 0.5;
      }
      this.currentObject = null;
    }
  }

  private updateFlyParticles(dt: number) {
    const gravity = new THREE.Vector3(0, -0.0028, 0);
    for (let i = this.flyParticles.length - 1; i >= 0; i--) {
      const fp = this.flyParticles[i];
      fp.life -= dt * 1.05;
      fp.mesh.position.add(fp.vel);
      fp.vel.add(gravity);
      fp.vel.multiplyScalar(0.972);
      fp.mesh.material.opacity = Math.max(0, fp.life);
      if (fp.life <= 0) {
        this.scene.remove(fp.mesh);
        (fp.mesh.material as THREE.Material).dispose();
        this.flyParticles.splice(i, 1);
      }
    }
  }

  private drawTrail() {
    const ctx = this.trailCtx;
    const W = this.trailCanvas.width;
    const H = this.trailCanvas.height;

    // Fade previous frame
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, W, H);

    if (this.slashTrail.length < 2) return;

    const pts = this.slashTrail.map(p => ({
      x: (p.x + 1) / 2 * W,
      y: (-p.y + 1) / 2 * H,
    }));

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(170,55,255,0.25)';
    ctx.lineWidth = 32;
    ctx.shadowColor = '#bb44ff';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(215,130,255,0.5)';
    ctx.lineWidth = 13;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,240,255,0.92)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    ctx.restore();
  }

  private updateHud() {
    const bar = (id: string, pct: number) => {
      const el = document.getElementById(id);
      if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    };
    const val = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    val('hs', this.score.toString());
    val('hc', `×${this.combo}`);
    val('hbv', Math.round(this.bpm).toString());
    bar('he', this.energy);
    bar('hco', this.corruption);
    bar('hbp', ((this.bpm - 88) / (175 - 88)) * 100);

    this.dangerVignette.style.boxShadow = this.corruption > 10
      ? `inset 0 0 ${80 + this.corruption * 1.2}px rgba(255,0,60,${this.corruption * 0.0055})`
      : 'none';
  }

  private frame = (t: number) => {
    if (!this.running) return;
    const dt = Math.min(0.033, (t - this.lastTime) / 1000);
    this.lastTime = t;
    this.songTime += dt;

    this.spawnCooldown -= dt;
    if (!this.currentObject && this.spawnCooldown <= 0) {
      this.spawnObject();
    }

    this.updateObject(dt);
    this.updateFlyParticles(dt);

    if (this.shakeAmount > 0.002) {
      this.camera.position.x = (Math.random() - 0.5) * this.shakeAmount;
      this.camera.position.y = (Math.random() - 0.5) * this.shakeAmount;
      this.shakeAmount *= 0.76;
    } else {
      this.camera.position.x = 0;
      this.camera.position.y = 0;
    }

    const starPos = this.stars.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < starPos.count; i++) {
      starPos.array[i * 3 + 2] += (5 + this.bpm * 0.035) * dt;
      if (starPos.array[i * 3 + 2] > 8) starPos.array[i * 3 + 2] = -180;
    }
    starPos.needsUpdate = true;

    this.drawTrail();

    this.renderer.domElement.style.filter =
      `contrast(${1 + this.corruption * 0.006}) saturate(${1 + this.energy * 0.004}) hue-rotate(${this.corruption * 0.5}deg)`;
    this.corruption = Math.max(0, this.corruption - dt * 4.2);
    this.energy     = Math.max(0, this.energy - dt * 1.4);
    this.bpm        = Math.max(88, this.bpm - dt * 0.45);

    this.updateHud();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.frame);
  };
}

const mount = document.getElementById('app');
if (!mount) throw new Error('Missing app mount');
new RhythmRiftGame(mount);
