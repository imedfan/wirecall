/**
 * How deep the buffer for incoming voice should be. A deeper one covers a jittery path and costs delay, which
 * the picture then shares to stay in step with the sound. So a clean link keeps the browser's own short buffer,
 * and the depth grows only while the browser has to invent sound to fill gaps, and shrinks back slowly.
 */
const STEPS_MS: readonly (number | null)[] = [null, 100, 200];
/** This share of invented sound is audible as a broken voice. */
const ROUGH_RATIO = 0.03;
const CLEAN_RATIO = 0.005;
const ROUGH_STREAK = 2;
/** About half a minute of clean sound before giving delay back. */
const CLEAN_STREAK = 15;

export interface CushionDecision {
  /** Milliseconds to hold, or null for the browser's own choice. */
  targetMs: number | null;
  changed: boolean;
}

export class AudioCushion {
  private step = 0;
  private rough = 0;
  private clean = 0;

  /** One reading of the share of concealed sound. An unknown reading changes nothing. */
  observe(concealmentRatio: number | undefined): CushionDecision {
    if (concealmentRatio === undefined || !Number.isFinite(concealmentRatio)) return this.decision(false);
    if (concealmentRatio >= ROUGH_RATIO) {
      this.clean = 0;
      this.rough += 1;
      if (this.rough >= ROUGH_STREAK && this.step < STEPS_MS.length - 1) return this.move(1);
    } else if (concealmentRatio <= CLEAN_RATIO) {
      this.rough = 0;
      this.clean += 1;
      if (this.clean >= CLEAN_STREAK && this.step > 0) return this.move(-1);
    } else {
      this.rough = 0;
      this.clean = 0;
    }
    return this.decision(false);
  }

  private move(direction: -1 | 1): CushionDecision {
    this.step += direction;
    this.rough = 0;
    this.clean = 0;
    return this.decision(true);
  }

  private decision(changed: boolean): CushionDecision {
    return { targetMs: STEPS_MS[this.step] ?? null, changed };
  }
}
