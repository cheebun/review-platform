/**
 * Marks a server-function request without a session. The global request middleware puts a fresh
 * instance in the context; the global function middleware admits it only for a public server
 * function. Unless admitted, the request middleware answers the usual 401 redirect to /login.
 *
 * A class, checked with `instanceof`, so a look-alike object in client-sent context never counts.
 * The request middleware always sets the context key, and server keys override client keys.
 * Client-safe: no server-only imports.
 */
export class AnonymousCall {
  #admitted = false;

  get admitted(): boolean {
    return this.#admitted;
  }

  admit(): void {
    this.#admitted = true;
  }
}
