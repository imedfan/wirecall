export class IceBuffer {
  private queued: string[] = [];
  private ready = false;

  push(payload: string): string[] {
    if (!this.ready) {
      this.queued.push(payload);
      return [];
    }
    return [payload];
  }

  markReady(): string[] {
    this.ready = true;
    const queued = this.queued;
    this.queued = [];
    return queued;
  }

  reset(): void {
    this.ready = false;
    this.queued = [];
  }

  get pending(): number {
    return this.queued.length;
  }
}
