/**
 * Postgres `ReviewUnitOfWork`: one `db.transaction` per `run`. An `err` result rolls back by
 * throwing a private sentinel out of the transaction callback; any other throw rolls back and
 * is re-thrown.
 *
 * The thread index and the reaction enqueue run inside a SAVEPOINT: they must never decide the
 * review result, and in Postgres a failed statement would otherwise abort the whole transaction.
 */
import {
  enqueueReactionTarget,
  insertReviewRecord,
  PgReviewJobRepo,
  recordThreadReview,
  type Db,
} from "../../adapters/db";
import { insertReviewEvent } from "../../adapters/db/pg-review-event-repo";
import type { ReviewTx, ReviewUnitOfWork } from "../../application/review/ports";
import { err, type DomainError, type Result } from "../../domain/shared/result";
import type { Clock, Logger } from "../../ports/system";

class Rollback {
  constructor(readonly error: DomainError) {}
}

type TxDb = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class PgReviewUnitOfWork implements ReviewUnitOfWork {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async run<T>(fn: (tx: ReviewTx) => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await this.db.transaction(async (raw) => {
        const out = await fn(this.bind(raw));
        if (!out.ok) throw new Rollback(out.error);
        return out;
      });
    } catch (error) {
      if (error instanceof Rollback) return err(error.error);
      throw error;
    }
  }

  private bind(raw: TxDb): ReviewTx {
    const tx = raw as unknown as Db;
    const savepoint = async <R>(what: string, body: (sp: Db) => Promise<Result<R>>) => {
      try {
        return await raw.transaction((sp) => body(sp as unknown as Db));
      } catch (error) {
        this.logger.warn(`${what} failed inside the review transaction`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return err<DomainError>({ kind: "upstream", service: "slack", retryable: true });
      }
    };
    return {
      saveJob: (job, opts) => new PgReviewJobRepo(tx, this.clock).save(job, opts),
      insertRecord: (record) => insertReviewRecord(tx, record),
      appendEvent: (event) => insertReviewEvent(tx, event),
      recordThreadReview: (input) =>
        savepoint("thread index", (sp) => recordThreadReview(sp, input, this.clock.now())),
      enqueueReaction: (target) =>
        savepoint("reaction enqueue", (sp) => enqueueReactionTarget(sp, target, this.clock.now())),
    };
  }
}
