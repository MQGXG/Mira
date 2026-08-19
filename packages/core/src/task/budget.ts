export class IterationBudget {
  used = 0
  constructor(public maxTotal: number) {}

  consume(): boolean {
    if (this.used >= this.maxTotal) return false
    this.used++
    return true
  }

  refund(): void {
    if (this.used > 0) this.used--
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this.used)
  }

  resetRemaining(count: number): void {
    this.used = Math.max(0, this.maxTotal - count)
  }
}
