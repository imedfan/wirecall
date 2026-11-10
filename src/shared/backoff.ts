export function nextDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 8);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

export class RetryBudget {
  private attempt = 0;

  constructor(
    private readonly maxAttempts: number,
    private readonly baseMs: number,
    private readonly capMs: number,
  ) {}

  next(): number | null {
    if (this.attempt >= this.maxAttempts) return null;
    const delay = nextDelayMs(this.attempt, this.baseMs, this.capMs);
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }

  get used(): number {
    return this.attempt;
  }
}
