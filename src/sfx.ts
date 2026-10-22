/** Music in public/music (generated with ElevenLabs Music), looped with a crossfade. */
export type Track = "calm" | "battle" | "techno1" | "techno2" | "boss";
const TRACKS: Track[] = ["calm", "techno1", "techno2", "battle", "boss"];
/** The fights take turns, wave by wave: two lighter techno tracks, then the heavy one. */
export const BATTLE_TRACKS: Track[] = ["techno1", "techno2", "battle"];
const MUSIC_VOLUME = 0.37;
/** Seconds of overlap when one track hands over to another, or to its own next loop. */
const CROSSFADE = 2.5;

/** Recorded effects in public/sfx (generated with ElevenLabs Sound Effects). */
const SAMPLES = ["gun", "rocket", "explosion", "explosion_big", "step_a", "step_b", "land", "laser", "powerup", "thunder_near", "thunder_far", "slam", "boss", "tesla", "warp", "victory"] as const;
type Sample = (typeof SAMPLES)[number];

/**
 * Sound effects: the weapons and explosions play recorded samples; everything else
 * (and the weapons too, until the samples have loaded) is synthesized on the fly.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private musicOut!: GainNode;
  private tracks = new Map<Track, AudioBuffer>();
  private playing: { track: Track; src: AudioBufferSourceNode; gain: GainNode; ends: number } | null = null;
  private wanted: Track | null = null;
  musicOn = true;
  private noise!: AudioBuffer;
  private samples = new Map<Sample, AudioBuffer>();

  /** Must be called from a user gesture (browsers keep audio muted until then). */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new AudioContext());
    this.out = ctx.createGain();
    this.out.gain.value = 0.4;
    this.out.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.musicOut = ctx.createGain();
    this.musicOut.gain.value = this.musicOn ? MUSIC_VOLUME : 0;
    this.musicOut.connect(ctx.destination);
    void this.loadSamples(ctx);
    void this.loadMusic(ctx);
  }

  private async loadMusic(ctx: AudioContext) {
    for (const name of TRACKS) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}music/${name}.mp3`);
        this.tracks.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // No music for this one, then.
      }
    }
  }

  /** Which track should be playing (null for silence); call every frame. Switches and loops with crossfades. */
  music(track: Track | null) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.wanted = track;
    const now = ctx.currentTime;
    const p = this.playing;
    const due = p && now > p.ends - CROSSFADE; // its loop is about to run out
    if (p && (p.track !== track || due)) {
      p.gain.gain.setTargetAtTime(0, now, CROSSFADE / 4);
      p.src.stop(now + CROSSFADE + 0.5);
      this.playing = null;
    }
    if (this.playing || !track) return;
    const buffer = this.tracks.get(track);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.setTargetAtTime(1, now, CROSSFADE / 4);
    src.connect(gain).connect(this.musicOut);
    src.start(now);
    this.playing = { track, src, gain, ends: now + buffer.duration };
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.ctx) this.musicOut.gain.setTargetAtTime(this.musicOn ? MUSIC_VOLUME : 0, this.ctx.currentTime, 0.1);
  }

  /** A hit soaked up by the force field: a bright electric zap. */
  shieldHit() {
    this.tone(1600, 700, 0.12, "triangle", 0.1);
    this.burst(0.08, 4000, "highpass", 0.15);
  }

  /** The force field collapsing: a falling electric whine. */
  shieldDown() {
    this.tone(1200, 120, 0.5, "sawtooth", 0.12);
    this.burst(0.35, 1500, "bandpass", 0.3);
  }

  /** A kamikaze's warning beep; urgency 0..1 raises the pitch. */
  beep(urgency: number, dist: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 900 + urgency * 900;
    osc.connect(this.envelope(ctx, 0.07 * Math.max(0.2, 1 - dist / 50), 0.06));
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /** The rising sting under a kill-streak callout; higher for bigger streaks. */
  callout(level: number) {
    this.play("powerup", 0.55, 1.1 + level * 0.12, 0.45);
  }

  private async loadSamples(ctx: AudioContext) {
    await Promise.all(
      SAMPLES.map(async (name) => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}sfx/${name}.mp3`);
          this.samples.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {
          // Keep the synthesized fallback for this one.
        }
      }),
    );
  }

  /** Plays a sample if it has loaded; `length` cuts it short with a quick fade. Returns false otherwise. */
  private play(name: Sample, vol: number, rate = 1, length?: number) {
    const ctx = this.ctx, buffer = this.samples.get(name);
    if (!ctx || !buffer) return false;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    if (length) {
      g.gain.setValueAtTime(vol, t + length * 0.6);
      g.gain.linearRampToValueAtTime(0, t + length);
    }
    src.connect(g).connect(this.out);
    src.start(t, 0, length);
    return true;
  }

  private envelope(ctx: AudioContext, vol: number, dur: number) {
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out);
    return g;
  }

  private burst(dur: number, freq: number, type: BiquadFilterType, vol: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    src.connect(filter).connect(this.envelope(ctx, vol, dur));
    src.start(ctx.currentTime, Math.random() * 0.5, dur + 0.05);
  }

  private tone(from: number, to: number, dur: number, type: OscillatorType, vol: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    osc.connect(this.envelope(ctx, vol, dur));
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** A shawarma leaving the launcher. */
  whoosh() {
    this.burst(0.16, 900, "bandpass", 0.18);
    this.tone(260, 140, 0.12, "triangle", 0.06);
  }

  /** A shawarma bouncing off the ground or a wall: a cartoon boing, lower with each bounce. */
  boing(bounce: number) {
    this.tone(160 / bounce, 640 / bounce, 0.18, "triangle", 0.16);
  }

  /** A shawarma landing in a robot's face: "nyam-nyam". */
  nom() {
    this.tone(330, 520, 0.08, "square", 0.08);
    setTimeout(() => this.tone(300, 560, 0.1, "square", 0.08), 110);
    this.burst(0.08, 600, "lowpass", 0.2);
  }

  shoot() {
    // Cut short and slightly detuned each time, so 14 shots a second stay crisp and don't sound looped.
    if (this.play("gun", 0.675, 0.9 + Math.random() * 0.2, 0.2)) return;
    this.burst(0.06, 2400 + Math.random() * 800, "highpass", 0.22);
    this.burst(0.09, 400, "lowpass", 0.35);
    this.tone(520 + Math.random() * 80, 90, 0.07, "square", 0.06);
  }

  rocket(vol = 0.8) {
    if (this.play("rocket", vol, 0.95 + Math.random() * 0.1)) return;
    this.burst(0.5, 1200, "bandpass", 0.35);
    this.tone(200, 900, 0.3, "sawtooth", 0.04);
  }

  enemyShoot(dist: number, heavy: boolean) {
    const v = Math.max(0.08, 1 - dist / 90);
    if (heavy) this.tone(300, 60, 0.4, "sawtooth", 0.12 * v);
    else this.tone(1500, 380, 0.14, "sawtooth", 0.06 * v);
  }

  hit() {
    this.tone(2200, 1400, 0.04, "triangle", 0.12);
  }

  hurt() {
    this.tone(260, 70, 0.22, "square", 0.14);
    this.burst(0.12, 900, "bandpass", 0.25);
  }

  explode(big: boolean, dist = 0) {
    const v = Math.max(0.25, 1 - dist / 150);
    if (this.play(big ? "explosion_big" : "explosion", (big ? 1.4 : 1) * v, big ? 0.9 : 1.05 + Math.random() * 0.15)) return;
    this.burst(big ? 1.2 : 0.7, 700, "lowpass", (big ? 1 : 0.7) * v);
    this.tone(140, 28, big ? 0.9 : 0.5, "sine", 0.7 * v);
  }

  rumble(dist: number) {
    const v = Math.max(0.2, 1 - dist / 200);
    // A collapsing building: the big blast slowed right down, under a low rumble.
    this.play("explosion_big", 1.5 * v, 0.6);
    this.burst(3, 220, "lowpass", 1.2 * v);
    this.tone(70, 25, 2.5, "sine", 0.6 * v);
  }

  private jetGain: GainNode | null = null;

  /** Continuous jet roar while flying; `level` 0..1. */
  jet(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.jetGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 700;
      filter.Q.value = 0.6;
      this.jetGain = ctx.createGain();
      this.jetGain.gain.value = 0;
      src.connect(filter).connect(this.jetGain).connect(this.out);
      src.start();
    }
    this.jetGain.gain.setTargetAtTime(level * 0.35, ctx.currentTime, 0.05);
  }

  /** A footfall of the hero mech; the two feet sound a little different. */
  step(foot: number, running: boolean) {
    this.play(foot % 2 ? "step_b" : "step_a", running ? 0.75 : 0.55, 0.92 + Math.random() * 0.14);
  }

  thunder(dist: number) {
    const vol = Math.max(0.35, Math.min(1.2, 1.4 - dist / 350));
    this.play(dist < 220 ? "thunder_near" : "thunder_far", vol, 0.9 + Math.random() * 0.15);
  }

  /** Two harsh beeps: incoming missiles. */
  missileWarning() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const at of [0, 0.22]) {
      const t = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(660, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + 0.2);
    }
  }

  slam(dist = 0) {
    this.play("slam", Math.max(0.3, 1.3 - dist / 120), 0.95 + Math.random() * 0.1);
  }

  bossAlarm() {
    this.play("boss", 0.9);
  }

  powerup() {
    this.play("powerup", 0.8);
  }

  private loops = new Map<Sample, GainNode>();

  /** A sample looping for as long as `on` stays true (the laser's hum, the tesla's crackle). */
  private loop(name: Sample, on: boolean, vol: number) {
    const ctx = this.ctx, buffer = this.samples.get(name);
    if (!ctx || !buffer) return;
    let gain = this.loops.get(name);
    if (!gain) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      // Skip the encoder padding at both ends of the mp3, or the loop clicks.
      src.loopStart = 0.05;
      src.loopEnd = buffer.duration - 0.05;
      gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.out);
      src.start(0, 0.05);
      this.loops.set(name, gain);
    }
    gain.gain.setTargetAtTime(on ? vol : 0, ctx.currentTime, 0.04);
  }

  laser(on: boolean) {
    this.loop("laser", on, 0.6);
  }

  tesla(on: boolean) {
    this.loop("tesla", on, 0.55);
  }

  victory() {
    this.play("victory", 0.9);
  }

  warp() {
    this.play("warp", 0.9);
  }

  /** Touching down after a flight; strength 0..1. */
  land(strength: number) {
    this.play("land", 0.5 + 0.7 * strength, 0.95 + Math.random() * 0.1);
  }

  pickup() {
    this.tone(520, 1300, 0.18, "triangle", 0.2);
  }
}
