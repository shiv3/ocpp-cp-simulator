import {
  DEFAULT_ID_TAG,
  type IdTagDistribution,
  type IdTagPool,
} from "../auth/IdTagPool";
import type { ChargePoint } from "./ChargePoint";

/** What the id tag source needs from its charge point. */
export interface IdTagSourceHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<ChargePoint, "canReplaceIdTags" | "nextIdTag">;
}

/**
 * The pool of idTags a charge point draws from when a call names none (#299,
 * #314, #603). `null` pool: the charge point was created without one. The
 * charge point keeps the public methods as thin delegates.
 */
export class IdTagSource {
  constructor(
    private readonly pool: IdTagPool | null,
    private readonly host: IdTagSourceHost,
  ) {}

  /**
   * The idTag to present when the caller named none.
   *
   * `null` when this charge point has no pool, so every existing call site
   * keeps its own fallback rather than inheriting one.
   */
  nextIdTag(connectorId = 0): string | null {
    return this.pool?.next(connectorId) ?? null;
  }

  /**
   * The pool's tags and distribution (#603), for traffic that keeps its own
   * seeded cursor instead of advancing the one `nextIdTag` shares. `null`
   * without a pool.
   */
  idTagPoolInfo(): {
    tags: readonly string[];
    distribution: IdTagDistribution;
  } | null {
    return this.pool
      ? {
          tags: this.pool.list(),
          distribution: this.pool.distributionPolicy,
        }
      : null;
  }

  /**
   * The idTag a control-plane call presents (#299): an explicit tag always
   * wins, the pool only fills a gap, and a charge point without one keeps the
   * historical literal. OCPP messages always carry a tag, so callers resolve
   * before building one.
   */
  resolveIdTag(tagId: string | undefined, connectorId?: number): string {
    return (
      tagId ?? this.host.chargePoint.nextIdTag(connectorId) ?? DEFAULT_ID_TAG
    );
  }

  /**
   * Whether a pool exists to replace — the same condition
   * {@link ChargePoint.replaceIdTags} refuses on, asked without mutating
   * anything, so a caller can persist before it changes the live charge point
   * (#314).
   */
  canReplaceIdTags(tags: readonly string[]): boolean {
    return this.pool !== null && tags.length > 0;
  }

  /**
   * Replace the pool's tags after an `idTagPool.file` was edited (#314).
   *
   * `false` when this charge point has no pool: it was created without one, and
   * conjuring one here would make a `--watch` daemon behave differently from
   * the `cp.create` that produced the charge point.
   */
  replaceIdTags(tags: readonly string[]): boolean {
    if (!this.pool || !this.host.chargePoint.canReplaceIdTags(tags)) {
      return false;
    }
    this.pool.replaceTags(tags);
    return true;
  }
}
