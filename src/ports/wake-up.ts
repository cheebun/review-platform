/** Best effort: a lost message only adds latency, because consumers also poll. */
export interface WakeUp {
  /** Notifies handlers subscribed to `channel` at the time of the call. */
  notify(channel: string): Promise<void>;
  /** Returns an async unsubscribe. After it resolves, the handler is never called again. */
  subscribe(channel: string, handler: () => void): Promise<() => Promise<void>>;
}
