export class Capacity {
  private active = 0;
  constructor(private readonly limit: number, private readonly message: string) {}
  acquire(): () => void {
    if (this.active >= this.limit) throw new Error(this.message);
    this.active++;
    let held = true;
    return () => { if (held) { held = false; this.active--; } };
  }
}
