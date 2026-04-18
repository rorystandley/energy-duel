type AudioContextConstructor = new () => AudioContext;
type AudioCue = "queue" | "move" | "pickupSmall" | "pickupBig" | "collision";

export interface AudioSettings {
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
}

interface ToneOptions {
  type?: OscillatorType;
  frequency: number;
  endFrequency?: number;
  duration: number;
  gain: number;
  gainMultiplier?: number;
  attack?: number;
  delay?: number;
}

const AUDIO_SETTINGS_STORAGE_KEY = "energy-duel:audio-settings";
const MUSIC_SOURCE = "./audio/background.mp3";
const MASTER_GAIN = 0.42;
const MIN_GAIN = 0.0001;
const DEFAULT_ATTACK_SECONDS = 0.006;
const MUSIC_IDLE_MULTIPLIER = 0.92;
const MUSIC_ROUND_MULTIPLIER = 1.08;
const MUSIC_VOLUME_TWEEN_MS = 420;
const MUSIC_DUCK_MULTIPLIER = 0.72;
const MUSIC_DUCK_IN_MS = 90;
const MUSIC_DUCK_HOLD_MS = 140;
const MUSIC_DUCK_OUT_MS = 340;
const PICKUP_SFX_GAIN_BOOST = 1.16;
const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  musicVolume: 0.05,
  sfxVolume: 1,
  muted: false,
};

const CUE_GAPS: Record<AudioCue, number> = {
  queue: 0.035,
  move: 0.045,
  pickupSmall: 0.08,
  pickupBig: 0.1,
  collision: 0.08,
};

function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}

export class AudioManager {
  private context?: AudioContext;
  private masterGain?: GainNode;
  private music?: HTMLAudioElement;
  private musicPlayInFlight = false;
  private musicRoundActive = false;
  private musicDuckActive = false;
  private musicTweenFrame?: number;
  private musicDuckRestoreTimer?: number;
  private readonly lastCueTime: Partial<Record<AudioCue, number>> = {};
  private settings: AudioSettings = this.loadSettings();

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  setMusicVolume(volume: number): void {
    this.settings = {
      ...this.settings,
      musicVolume: clampVolume(volume),
    };
    this.applyMusicVolume();
    this.persistSettings();
  }

  setSfxVolume(volume: number): void {
    this.settings = {
      ...this.settings,
      sfxVolume: clampVolume(volume),
    };
    this.applySfxVolume();
    this.persistSettings();
  }

  setMuted(muted: boolean): void {
    this.settings = {
      ...this.settings,
      muted,
    };
    this.applyMusicVolume(muted ? 140 : MUSIC_VOLUME_TWEEN_MS);
    this.applySfxVolume();
    this.persistSettings();
  }

  toggleMuted(): void {
    this.setMuted(!this.settings.muted);
  }

  startMusic(): void {
    const music = this.getMusic();

    if (!music || !music.paused || this.musicPlayInFlight) {
      return;
    }

    this.musicPlayInFlight = true;
    void music
      .play()
      .catch(() => {
        // Browsers may still block this until a trusted user gesture.
      })
      .finally(() => {
        this.musicPlayInFlight = false;
      });
  }

  setRoundMusicActive(active: boolean): void {
    if (this.musicRoundActive === active) {
      return;
    }

    this.musicRoundActive = active;
    this.applyMusicVolume();
  }

  playQueue(): void {
    if (!this.canPlay("queue")) {
      return;
    }

    this.playTone({
      frequency: 880,
      endFrequency: 720,
      duration: 0.055,
      gain: 0.02,
      attack: 0.003,
    });
  }

  playMove(): void {
    if (!this.canPlay("move")) {
      return;
    }

    this.playTone({
      frequency: 610,
      endFrequency: 420,
      duration: 0.095,
      gain: 0.04,
      attack: 0.006,
    });
    this.playTone({
      frequency: 1480,
      endFrequency: 1040,
      duration: 0.075,
      gain: 0.01,
      attack: 0.004,
      delay: 0.008,
    });
  }

  playPickupSmall(): void {
    if (!this.canPlay("pickupSmall")) {
      return;
    }

    this.playTone({
      frequency: 1080,
      endFrequency: 1320,
      duration: 0.12,
      gain: 0.034,
      gainMultiplier: PICKUP_SFX_GAIN_BOOST,
      attack: 0.005,
    });
  }

  playPickupBig(): void {
    if (!this.canPlay("pickupBig")) {
      return;
    }

    this.playTone({
      frequency: 720,
      endFrequency: 860,
      duration: 0.15,
      gain: 0.034,
      gainMultiplier: PICKUP_SFX_GAIN_BOOST,
      attack: 0.006,
    });
    this.playTone({
      frequency: 1440,
      endFrequency: 1680,
      duration: 0.115,
      gain: 0.016,
      gainMultiplier: PICKUP_SFX_GAIN_BOOST,
      attack: 0.005,
      delay: 0.018,
    });
  }

  playCollision(): void {
    this.duckMusic();

    if (!this.canPlay("collision")) {
      return;
    }

    this.playTone({
      type: "square",
      frequency: 520,
      endFrequency: 170,
      duration: 0.1,
      gain: 0.042,
      attack: 0.003,
    });
    this.playNoiseZap();
  }

  destroy(): void {
    const context = this.context;

    this.cancelMusicTween();
    this.clearMusicDuckRestoreTimer();
    this.music?.pause();
    this.music = undefined;
    this.masterGain?.disconnect();
    this.masterGain = undefined;
    this.context = undefined;

    if (context && context.state !== "closed") {
      void context.close();
    }
  }

  private canPlay(cue: AudioCue): boolean {
    if (this.effectiveSfxMasterGain() <= 0) {
      return false;
    }

    const context = this.getContext();

    if (!context) {
      return false;
    }

    const now = context.currentTime;
    const lastTime = this.lastCueTime[cue] ?? -Infinity;

    if (now - lastTime < CUE_GAPS[cue]) {
      return false;
    }

    this.lastCueTime[cue] = now;
    return true;
  }

  private playTone(options: ToneOptions): void {
    const context = this.getContext();
    const masterGain = this.masterGain;

    if (!context || !masterGain) {
      return;
    }

    const startAt = context.currentTime + (options.delay ?? 0);
    const endAt = startAt + options.duration;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(options.frequency, startAt);

    if (options.endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        options.endFrequency,
        endAt,
      );
    }

    this.applyEnvelope(
      gain.gain,
      startAt,
      endAt,
      options.gain * (options.gainMultiplier ?? 1),
      options.attack ?? DEFAULT_ATTACK_SECONDS,
    );
    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }

  private playNoiseZap(): void {
    const context = this.getContext();
    const masterGain = this.masterGain;

    if (!context || !masterGain) {
      return;
    }

    const duration = 0.095;
    const startAt = context.currentTime;
    const endAt = startAt + duration;
    const buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * duration),
      context.sampleRate,
    );
    const samples = buffer.getChannelData(0);

    for (let index = 0; index < samples.length; index += 1) {
      const fade = 1 - index / samples.length;
      samples[index] = (Math.random() * 2 - 1) * fade;
    }

    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();

    noise.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2800, startAt);
    filter.frequency.exponentialRampToValueAtTime(1100, endAt);
    filter.Q.setValueAtTime(2.2, startAt);
    this.applyEnvelope(gain.gain, startAt, endAt, 0.038, 0.002);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    noise.start(startAt);
    noise.stop(endAt + 0.01);
    noise.onended = () => {
      noise.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  private applyEnvelope(
    gain: AudioParam,
    startAt: number,
    endAt: number,
    peakGain: number,
    attack: number,
  ): void {
    const attackEnd = Math.min(startAt + attack, endAt);

    gain.cancelScheduledValues(startAt);
    gain.setValueAtTime(MIN_GAIN, startAt);
    gain.linearRampToValueAtTime(peakGain, attackEnd);
    gain.exponentialRampToValueAtTime(MIN_GAIN, endAt);
    gain.setValueAtTime(0, endAt + 0.006);
  }

  private getContext(): AudioContext | undefined {
    if (typeof window === "undefined") {
      return undefined;
    }

    if (!this.context || this.context.state === "closed") {
      const AudioContextClass = this.getAudioContextClass();

      if (!AudioContextClass) {
        return undefined;
      }

      this.context = new AudioContextClass();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.effectiveSfxMasterGain();
      this.masterGain.connect(this.context.destination);
    }

    if (this.context.state === "suspended") {
      void this.context.resume();
    }

    return this.context;
  }

  private getMusic(): HTMLAudioElement | undefined {
    if (typeof window === "undefined") {
      return undefined;
    }

    if (!this.music) {
      this.music = new Audio(MUSIC_SOURCE);
      this.music.loop = true;
      this.music.preload = "auto";
      this.applyMusicVolume(0);
      this.music.load();
    }

    return this.music;
  }

  private applyMusicVolume(durationMs = MUSIC_VOLUME_TWEEN_MS): void {
    if (!this.music) {
      return;
    }

    this.tweenMusicVolumeTo(this.effectiveMusicVolume(), durationMs);
  }

  private applySfxVolume(): void {
    if (!this.masterGain || !this.context) {
      return;
    }

    this.masterGain.gain.setValueAtTime(
      this.effectiveSfxMasterGain(),
      this.context.currentTime,
    );
  }

  private effectiveMusicVolume(): number {
    if (this.settings.muted) {
      return 0;
    }

    const roundMultiplier = this.musicRoundActive
      ? MUSIC_ROUND_MULTIPLIER
      : MUSIC_IDLE_MULTIPLIER;
    const duckMultiplier = this.musicDuckActive ? MUSIC_DUCK_MULTIPLIER : 1;
    return clampVolume(this.settings.musicVolume * roundMultiplier * duckMultiplier);
  }

  private effectiveSfxMasterGain(): number {
    return this.settings.muted ? 0 : MASTER_GAIN * this.settings.sfxVolume;
  }

  private loadSettings(): AudioSettings {
    if (typeof window === "undefined") {
      return { ...DEFAULT_AUDIO_SETTINGS };
    }

    try {
      const rawSettings = window.localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY);

      if (!rawSettings) {
        return { ...DEFAULT_AUDIO_SETTINGS };
      }

      const parsedSettings = JSON.parse(rawSettings) as Partial<AudioSettings>;

      return {
        musicVolume: this.readVolume(
          parsedSettings.musicVolume,
          DEFAULT_AUDIO_SETTINGS.musicVolume,
        ),
        sfxVolume: this.readVolume(
          parsedSettings.sfxVolume,
          DEFAULT_AUDIO_SETTINGS.sfxVolume,
        ),
        muted:
          typeof parsedSettings.muted === "boolean"
            ? parsedSettings.muted
            : DEFAULT_AUDIO_SETTINGS.muted,
      };
    } catch {
      return { ...DEFAULT_AUDIO_SETTINGS };
    }
  }

  private readVolume(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
      ? clampVolume(value)
      : fallback;
  }

  private persistSettings(): void {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        AUDIO_SETTINGS_STORAGE_KEY,
        JSON.stringify(this.settings),
      );
    } catch {
      // Storage can be unavailable in private contexts; audio still works.
    }
  }

  private getAudioContextClass(): AudioContextConstructor | undefined {
    const windowWithFallback = window as Window &
      typeof globalThis & {
        webkitAudioContext?: AudioContextConstructor;
      };

    return window.AudioContext ?? windowWithFallback.webkitAudioContext;
  }

  private duckMusic(): void {
    if (!this.music || this.effectiveMusicVolume() <= 0) {
      return;
    }

    this.clearMusicDuckRestoreTimer();
    this.musicDuckActive = true;
    this.applyMusicVolume(MUSIC_DUCK_IN_MS);

    this.musicDuckRestoreTimer = window.setTimeout(() => {
      this.musicDuckRestoreTimer = undefined;
      this.musicDuckActive = false;
      this.applyMusicVolume(MUSIC_DUCK_OUT_MS);
    }, MUSIC_DUCK_IN_MS + MUSIC_DUCK_HOLD_MS);
  }

  private tweenMusicVolumeTo(targetVolume: number, durationMs: number): void {
    const music = this.music;

    if (!music) {
      return;
    }

    const target = clampVolume(targetVolume);

    this.cancelMusicTween();

    if (
      durationMs <= 0 ||
      typeof window === "undefined" ||
      Math.abs(music.volume - target) < 0.001
    ) {
      music.volume = target;
      return;
    }

    const startVolume = music.volume;
    const startAt = window.performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startAt) / durationMs);
      const easedProgress = 1 - (1 - progress) ** 3;

      music.volume = startVolume + (target - startVolume) * easedProgress;

      if (progress < 1) {
        this.musicTweenFrame = window.requestAnimationFrame(tick);
        return;
      }

      this.musicTweenFrame = undefined;
      music.volume = target;
    };

    this.musicTweenFrame = window.requestAnimationFrame(tick);
  }

  private cancelMusicTween(): void {
    if (this.musicTweenFrame === undefined || typeof window === "undefined") {
      this.musicTweenFrame = undefined;
      return;
    }

    window.cancelAnimationFrame(this.musicTweenFrame);
    this.musicTweenFrame = undefined;
  }

  private clearMusicDuckRestoreTimer(): void {
    if (this.musicDuckRestoreTimer === undefined || typeof window === "undefined") {
      this.musicDuckRestoreTimer = undefined;
      return;
    }

    window.clearTimeout(this.musicDuckRestoreTimer);
    this.musicDuckRestoreTimer = undefined;
  }
}
