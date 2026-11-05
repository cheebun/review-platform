export interface Throttle {
  /** True at most once per `intervalMs` for `name`. */
  tryPass(name: string, intervalMs: number): Promise<boolean>;
}
