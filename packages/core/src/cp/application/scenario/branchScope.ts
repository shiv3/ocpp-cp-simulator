/**
 * Branch-scoped cancellation for a scenario run (schema 1.9 `parallel` /
 * `join`). The run's root scope ends when the run is stopped; a branch a
 * `parallel` starts gets a child scope that also ends when the branch is
 * cancelled (an `any` join was reached by a sibling, or a sibling failed).
 * Every wait and sleep of a branch races its scope's `ended`, so a cancelled
 * branch unblocks at once, and a cancelled scope cancels its children.
 */
export class BranchScope {
  /** Resolves when this scope or any ancestor ends (the run stopped or the
   *  branch was cancelled). */
  readonly ended: Promise<void>;
  private cancelledHere = false;
  private resolveEnded: () => void = () => {};
  private readonly children = new Set<BranchScope>();

  private constructor(
    private readonly parent: BranchScope | null,
    /** The innermost parallel execution this branch belongs to; null for
     *  the run's root scope and a branch from Start. */
    readonly region: ParallelRegion | null,
    runEnded: Promise<void> | null,
  ) {
    if (runEnded) {
      // The root scope's end is the run's abort itself, so a run without a
      // parallel races exactly what it raced before.
      this.ended = runEnded;
    } else {
      this.ended = new Promise<void>((resolve) => {
        this.resolveEnded = resolve;
      });
      parent?.ended.then(() => this.resolveEnded());
      parent?.children.add(this);
    }
  }

  /** The scope of a run: ends when `runEnded` (the run's abort) resolves. */
  static root(runEnded: Promise<void>): BranchScope {
    return new BranchScope(null, null, runEnded);
  }

  /** A branch of `region`, cancelled with this scope. */
  child(region: ParallelRegion): BranchScope {
    return new BranchScope(this, region, null);
  }

  /** True once this branch, or a branch it belongs to, was cancelled. A
   *  stopped run is not a cancellation: check the run's abort for that. */
  get cancelled(): boolean {
    return this.cancelledHere || (this.parent?.cancelled ?? false);
  }

  cancel(): void {
    if (this.cancelledHere) return;
    this.cancelledHere = true;
    this.resolveEnded();
    for (const child of this.children) child.cancel();
  }

  /** Forget a finished child scope. */
  release(): void {
    this.parent?.children.delete(this);
  }
}

/** The join node a region met at, as the executor hands it in. */
export type JoinNode = { readonly id: string };

/** How one execution of a `parallel` ended (schema 1.9). */
export type ParallelOutcome =
  | { kind: "join"; join: JoinNode }
  | { kind: "noJoin" }
  | { kind: "failed"; error: unknown };

/**
 * One execution of a `parallel` node: its branches, and where they meet.
 * The first branch to arrive at a join names the join (and its mode). With
 * `any` the region settles on that arrival; with `all` it settles once every
 * branch arrived or ended. A branch that fails settles it at once.
 */
export class ParallelRegion {
  readonly settled: Promise<ParallelOutcome>;
  private join: JoinNode | null = null;
  private pending = 0;
  private done = false;
  private resolveSettled: (outcome: ParallelOutcome) => void = () => {};
  readonly branches: BranchScope[] = [];

  constructor(readonly parallelNodeId: string) {
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  get isSettled(): boolean {
    return this.done;
  }

  /** The join the first arrival named, if any. */
  get joinNode(): JoinNode | null {
    return this.join;
  }

  addBranch(scope: BranchScope): void {
    this.branches.push(scope);
    this.pending += 1;
  }

  /** A branch reached `join`; returns whether `any` settled the region. */
  arrive(join: JoinNode, mode: "all" | "any"): boolean {
    if (this.done) return false;
    this.join ??= join;
    if (mode === "any" && this.join === join) {
      this.settle({ kind: "join", join });
      return true;
    }
    return false;
  }

  /** A branch ended: arrived, ran out of steps, or was cancelled. */
  branchEnded(): void {
    this.pending -= 1;
    if (this.pending > 0 || this.done) return;
    this.settle(
      this.join === null
        ? { kind: "noJoin" }
        : { kind: "join", join: this.join },
    );
  }

  fail(error: unknown): void {
    this.settle({ kind: "failed", error });
  }

  /** Settle with no branches at all. */
  empty(): void {
    if (this.pending === 0) this.settle({ kind: "noJoin" });
  }

  private settle(outcome: ParallelOutcome): void {
    if (this.done) return;
    this.done = true;
    this.resolveSettled(outcome);
  }
}
