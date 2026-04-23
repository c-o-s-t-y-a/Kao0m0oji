import * as THREE from 'three';

type ObjectKind = 'evil' | 'good';

interface RhythmObject {
  id: number;
  kind: ObjectKind;
  symbol: string;
  mesh: THREE.Sprite;
  speed: number;
  spawnedAt: number;
  hit: boolean;
  radius: number;
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
  bpm = 96;
  private unstable = 0;

  constructor() {
    this.master.gain.value = 0.8;
    this.distortion.curve = this.makeDistCurve(80);
    this.distortion.oversample = '4x';
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;

    this.pulseOsc.type = 'triangle';
    this.pulseOsc.frequency.value = 48;
    this.pulseGain.gain.value = 0;
    this.pulseOsc.connect(this.pulseGain).connect(this.master);
    this.pulseOsc.start();

    this.master.connect(this.context.destination);
    this.createLayers();
  }

  async start() {
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
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
    this.bpm = Math.min(185, Math.max(90, next));
    this.pulseOsc.frequency.setTargetAtTime(this.bpm / 2, this.context.currentTime, 0.1);
    this.layers.forEach((layer, i) => {
      layer.gain.setTargetAtTime(0.2 + i * 0.05, this.context.currentTime, 0.5);
    });
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

  calmDown(amount: number) {
    this.addCorruption(-amount);
  }

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
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly hud = document.createElement('div');
  private readonly overlay = document.createElement('div');
  private readonly audio = new AudioEngine();
  private readonly stars = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0x88b8ff, size: 0.08, transparent: true, opacity: 0.75 })
  );
  private readonly objects: RhythmObject[] = [];
  private readonly particles: { mesh: THREE.Points; life: number; velocity: THREE.Vector3[] }[] = [];
  private readonly slashTrail: PointerPoint[] = [];

  private nextId = 1;
  private combo = 0;
  private score = 0;
  private energy = 0;
  private corruption = 0;
  private bpm = 96;
  private musicLayer = 0;
  private spawnTimer = 0;
  private running = false;
  private bossSpawned = false;
  private bossHp = 14;
  private songTime = 0;
  private readonly songLength = 95;

  constructor(private readonly mount: HTMLElement) {
    this.camera.position.z = 6;
    this.scene.fog = new THREE.FogExp2(0x020207, 0.07);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mount.appendChild(this.renderer.domElement);

    this.initStars();
    this.scene.add(this.stars);

    this.hud.style.cssText = 'position:fixed;left:20px;top:16px;z-index:5;white-space:pre-line;font-size:14px;text-shadow:0 0 8px #60f6ff';
    this.overlay.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;z-index:6;background:linear-gradient(180deg,#050510dd,#020207ee);font-size:clamp(20px,3vw,36px);text-align:center;padding:24px;cursor:pointer';
    this.overlay.innerHTML = 'Kao0m0oji Rhythm Rift<br/><small>Swipe EVIL kaomoji. Tap GOOD signals.<br/>Click / Touch to enter trance.</small>';
    document.body.append(this.hud, this.overlay);

    this.bindEvents();
    this.updateHud();
  }

  private bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
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
      const now = performance.now();
      this.slashTrail.push({ x: p.x, y: p.y, t: now });
      while (this.slashTrail.length > 8) this.slashTrail.shift();
      this.trySlash();
    });

    canvas.addEventListener('pointerup', () => {
      this.slashTrail.length = 0;
    });
  }


  private resetRun() {
    for (const obj of this.objects) {
      this.scene.remove(obj.mesh);
      (obj.mesh.material as THREE.Material).dispose();
    }
    this.objects.length = 0;

    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.particles.length = 0;

    this.combo = 0;
    this.score = 0;
    this.energy = 0;
    this.corruption = 0;
    this.bpm = 96;
    this.musicLayer = 0;
    this.audio.setBpm(this.bpm);
    this.audio.setLayerUnlock(0);
    this.audio.calmDown(1);
    this.spawnTimer = 0;
    this.songTime = 0;
    this.bossSpawned = false;
    this.bossHp = 14;
    this.updateHud();
  }

  private toNdc(clientX: number, clientY: number) {
    return {
      x: (clientX / window.innerWidth) * 2 - 1,
      y: -(clientY / window.innerHeight) * 2 + 1
    };
  }

  private initStars() {
    const count = 1500;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 45;
      positions[i * 3 + 2] = -Math.random() * 180;
    }
    this.stars.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }

  private makeTextSprite(symbol: string, color: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 86px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 26;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff22';
    ctx.lineWidth = 2;
    ctx.strokeText(symbol, canvas.width / 2, canvas.height / 2);
    ctx.fillText(symbol, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2.2, 1.1, 1);
    return sprite;
  }

  private spawnObject() {
    const evilSymbols = ['(ಠ_ಠ)', '(╬ Ò﹏Ó)', '(◣_◢)', '(×_×)'];
    const goodSymbols = ['(◕‿◕)', '♥', '✦', '(｡♥‿♥｡)'];
    const kind: ObjectKind = Math.random() < 0.65 ? 'evil' : 'good';
    const symbol = kind === 'evil' ? evilSymbols[Math.floor(Math.random() * evilSymbols.length)] : goodSymbols[Math.floor(Math.random() * goodSymbols.length)];
    const sprite = this.makeTextSprite(symbol, kind === 'evil' ? '#ff4477' : '#70ffe3');
    sprite.position.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4.8, -58 - Math.random() * 20);
    this.scene.add(sprite);

    this.objects.push({
      id: this.nextId++,
      kind,
      symbol,
      mesh: sprite,
      speed: 13 + Math.random() * 4 + this.bpm * 0.03,
      spawnedAt: performance.now(),
      hit: false,
      radius: kind === 'evil' ? 0.8 : 0.7
    });
  }

  private tryTap(clientX: number, clientY: number) {
    this.pointer.copy(this.toNdc(clientX, clientY));
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster
      .intersectObjects(this.objects.map((o) => o.mesh), false)
      .map((i: THREE.Intersection<THREE.Object3D>) => this.objects.find((o: RhythmObject) => o.mesh === i.object))
      .find((o: RhythmObject | undefined): o is RhythmObject => Boolean(o) && !o.hit);

    if (!hit) return;
    if (hit.kind === 'good') {
      hit.hit = true;
      this.collectGood(hit);
    }
  }

  private trySlash() {
    if (this.slashTrail.length < 2) return;
    const a = this.slashTrail[this.slashTrail.length - 2];
    const b = this.slashTrail[this.slashTrail.length - 1];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const dt = Math.max(1, b.t - a.t);
    const velocity = dist / dt;
    if (velocity < 0.0014 || dist < 0.03) return;

    const direction = new THREE.Vector2(b.x - a.x, b.y - a.y).normalize();
    const center = new THREE.Vector2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);

    for (const obj of this.objects) {
      if (obj.hit || obj.kind !== 'evil') continue;
      const screen = obj.mesh.position.clone().project(this.camera);
      const toObj = new THREE.Vector2(screen.x - center.x, screen.y - center.y);
      const normal = new THREE.Vector2(-direction.y, direction.x);
      const distanceToLine = Math.abs(toObj.dot(normal));
      if (distanceToLine < 0.1 && toObj.length() < 0.25 + obj.radius * 0.08) {
        obj.hit = true;
        this.slashEvil(obj, direction);
      }
    }
  }

  private spawnParticles(position: THREE.Vector3, color: number, amount = 30) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(amount * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < amount; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      velocities.push(
        new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.2)
      );
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color, size: 0.06, transparent: true, opacity: 0.95 });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    this.particles.push({ mesh: points, life: 1, velocity: velocities });
  }

  private slashEvil(obj: RhythmObject, direction: THREE.Vector2) {
    this.combo += 1;
    this.score += 150 + this.combo * 8;
    this.energy = Math.min(100, this.energy + 2);
    this.audio.pulse(1.2);
    this.audio.calmDown(0.06);

    const left = this.makeTextSprite(obj.symbol.slice(0, Math.ceil(obj.symbol.length / 2)), '#ff88ac');
    const right = this.makeTextSprite(obj.symbol.slice(Math.ceil(obj.symbol.length / 2)), '#ff88ac');
    left.position.copy(obj.mesh.position);
    right.position.copy(obj.mesh.position);
    left.scale.copy(obj.mesh.scale).multiplyScalar(0.7);
    right.scale.copy(obj.mesh.scale).multiplyScalar(0.7);

    const normal = new THREE.Vector3(-direction.y, direction.x, 0).multiplyScalar(0.12);
    left.position.add(normal);
    right.position.addScaledVector(normal, -1);
    this.scene.add(left, right);
    this.spawnParticles(obj.mesh.position, 0xff4f7d, 38);
    this.spawnParticles(obj.mesh.position, 0x9e57ff, 22);

    const disperse = (sprite: THREE.Sprite, sign: number) => {
      let life = 0.8;
      const vel = new THREE.Vector3(direction.x * sign * 0.08, direction.y * sign * 0.08, 0.05);
      const animate = () => {
        life -= 0.016;
        if (life <= 0) {
          this.scene.remove(sprite);
          (sprite.material as THREE.Material).dispose();
          return;
        }
        sprite.position.add(vel);
        vel.y -= 0.002;
        sprite.material.opacity = life;
        requestAnimationFrame(animate);
      };
      animate();
    };

    disperse(left, 1);
    disperse(right, -1);
    this.scene.remove(obj.mesh);
    (obj.mesh.material as THREE.Material).dispose();
  }

  private collectGood(obj: RhythmObject) {
    this.score += 120;
    this.energy = Math.min(100, this.energy + 8);
    this.combo += 1;
    this.bpm = Math.min(182, this.bpm + 2.5);
    this.audio.setBpm(this.bpm);

    const nextLayer = Math.min(3, Math.floor(this.energy / 25));
    if (nextLayer !== this.musicLayer) {
      this.musicLayer = nextLayer;
      this.audio.setLayerUnlock(this.musicLayer);
    }

    this.spawnParticles(obj.mesh.position, 0x69ffe0, 44);
    this.spawnParticles(obj.mesh.position, 0xffffff, 14);
    this.scene.remove(obj.mesh);
    (obj.mesh.material as THREE.Material).dispose();
  }

  private missEvil(obj: RhythmObject) {
    this.combo = 0;
    this.corruption = Math.min(100, this.corruption + 12);
    this.audio.addCorruption(0.2);
    this.audio.setBpm(this.bpm - 3);
    this.spawnParticles(obj.mesh.position, 0xff003c, 24);
  }

  private spawnBoss() {
    const boss = this.makeTextSprite('༼༎ຶ෴༎ຶ༽', '#ff2a8d');
    boss.scale.set(8.5, 4.5, 1);
    boss.position.set(0, 0, -45);
    this.scene.add(boss);
    this.objects.push({
      id: this.nextId++,
      kind: 'evil',
      symbol: 'boss',
      mesh: boss,
      speed: 8,
      spawnedAt: performance.now(),
      hit: false,
      radius: 2.6
    });
    this.bossSpawned = true;
  }

  private updateObjects(dt: number) {
    for (const obj of this.objects) {
      if (obj.hit) continue;

      obj.mesh.position.z += obj.speed * dt;
      const size = THREE.MathUtils.clamp(0.45 + (58 + obj.mesh.position.z) * 0.032, 0.3, obj.symbol === 'boss' ? 9 : 3.5);
      obj.mesh.scale.set(size * 2, size, 1);

      if (obj.mesh.position.z > 4.3) {
        obj.hit = true;
        if (obj.kind === 'evil') {
          if (obj.symbol === 'boss') {
            this.corruption = 100;
          } else {
            this.missEvil(obj);
          }
        }
        this.scene.remove(obj.mesh);
      }
    }

    if (this.bossSpawned) {
      const boss = this.objects.find((o) => o.symbol === 'boss' && !o.hit);
      if (boss) {
        if (this.combo > 0 && Math.random() < 0.03 + this.energy / 2000) {
          this.bossHp -= 1;
          this.spawnParticles(boss.mesh.position, 0xff5e91, 26);
          this.audio.pulse(1.6);
        }
        if (this.bossHp <= 0) {
          boss.hit = true;
          this.spawnParticles(boss.mesh.position, 0xffffff, 140);
          this.scene.remove(boss.mesh);
          this.score += 6000;
          this.overlay.style.display = 'grid';
          this.overlay.innerHTML = `TRANSMISSION PURIFIED<br/><small>Score ${this.score}<br/>Tap to replay</small>`;
          document.body.append(this.overlay);
          this.running = false;
        }
      }
    }

    for (let i = this.objects.length - 1; i >= 0; i--) {
      if (this.objects[i].hit) this.objects.splice(i, 1);
    }
  }

  private updateParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt * 1.45;
      const attr = p.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let j = 0; j < p.velocity.length; j++) {
        const v = p.velocity[j];
        attr.array[j * 3] += v.x;
        attr.array[j * 3 + 1] += v.y;
        attr.array[j * 3 + 2] += v.z;
        v.multiplyScalar(0.985);
      }
      attr.needsUpdate = true;
      (p.mesh.material as THREE.PointsMaterial).opacity = Math.max(0, p.life);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }
  }

  private updateHud() {
    this.hud.textContent = `Score ${this.score}\nCombo ${this.combo}\nEnergy ${this.energy.toFixed(0)}%\nBPM ${this.bpm.toFixed(1)}\nCorruption ${this.corruption.toFixed(0)}%`;
    this.hud.style.color = `hsl(${170 - this.corruption}, 95%, ${72 - this.corruption * 0.25}%)`;
  }

  private lastTime = 0;
  private frame = (t: number) => {
    if (!this.running) return;
    const dt = Math.min(0.033, (t - this.lastTime) / 1000);
    this.lastTime = t;
    this.songTime += dt;

    const spawnInterval = Math.max(0.14, 0.66 - this.bpm * 0.0032 - this.energy * 0.0018);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.songTime < this.songLength) {
      this.spawnTimer = spawnInterval;
      this.spawnObject();
    }

    if (this.songTime > this.songLength * 0.82 && !this.bossSpawned) {
      this.spawnBoss();
    }

    if (this.songTime > this.songLength && !this.bossSpawned) {
      this.overlay.style.display = 'grid';
      this.overlay.innerHTML = `Signal Faded<br/><small>Score ${this.score}<br/>Tap to restart</small>`;
      document.body.append(this.overlay);
      this.running = false;
      return;
    }

    this.updateObjects(dt);
    this.updateParticles(dt);

    const positions = this.stars.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      positions.array[i * 3 + 2] += (8 + this.bpm * 0.05) * dt;
      if (positions.array[i * 3 + 2] > 8) {
        positions.array[i * 3 + 2] = -180;
      }
    }
    positions.needsUpdate = true;

    this.renderer.domElement.style.filter = `contrast(${1 + this.corruption * 0.007}) saturate(${1 + this.energy * 0.005}) hue-rotate(${this.corruption * 0.6}deg)`;
    this.corruption = Math.max(0, this.corruption - dt * 4.5);
    this.energy = Math.max(0, this.energy - dt * 1.6);
    this.bpm = Math.max(96, this.bpm - dt * 0.75);

    this.updateHud();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.frame);
  };
}

const mount = document.getElementById('app');
if (!mount) {
  throw new Error('Missing app mount');
}
new RhythmRiftGame(mount);
