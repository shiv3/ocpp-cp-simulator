---
title: File hot-reload (`--watch`)
type: concept
summary: Why `--watch` behaves as it does — the derivation behind each reload rule, and how a watched file's origin survives a daemon restart. The operator-facing contract and the supported-layouts table stay on the daemon page.
sources:
  - src/cli/server/FileWatcher.ts
  - src/cli/server/FileReloadManager.ts
  - src/cli/server/startServer.ts
  - src/cli/service.ts
  - GitHub issue #314
related:
  - ../entities/daemon.md
  - ../entities/cli.md
  - state-persistence.md
  - control-plane.md
  - scenario-format.md
updated: 2026-09-07
---

# File hot-reload (`--watch`)

The contract — what `--watch` guarantees, which files it covers, and which
filesystem layouts it supports — is on
[Daemon → File hot-reload](../entities/daemon.md#file-hot-reload), where an
operator deciding whether to turn the flag on will look for it. This page holds
the derivations behind those sentences: what each rule defends against, why the
obvious simpler version of it was wrong, and what is deliberately still not
covered. Read it when a rule surprises you, or before changing one.

Every guarantee below is stated on the daemon page in a sentence or two. If the
two ever disagree, the daemon page is the contract and this page is the
explanation that has fallen behind.

## The rules, and what each one defends against

- **`applied` is a claim about durable state.** With `--state-db`, a scenario
  reload is not announced until its write to the `scenarios` table has settled.
  `loadScenario` installs the definition synchronously and persists in the
  background, so a rejected write (`SQLITE_BUSY`, a full disk) used to be
  swallowed and the reload reported `applied` for a change a restart would undo.
  A reload whose write fails is reported **`rejected`**, with a message saying
  the definition is live until the daemon restarts — the in-memory copy is
  deliberately not rolled back, because reloading the previous definition can
  tear down a run this one has already auto-started, trading a durability
  failure for a liveness one. The idTag half has no such gap **per charge
  point**: its pool is persisted before the live pool is touched, so a charge
  point whose write fails is left untouched, live and stored alike. Across a
  _set_ of charge points sharing one file that is not the same thing — see the
  next rule.
- **The duplicate-bytes baseline is per file and means "everyone has these".**
  A watched idTag file's cached copy records the bytes _every_ charge point
  drawing from that path currently holds, not merely the bytes of the last
  reload that landed somewhere. The difference matters inside the debounce
  window: a charge point created between an edit and its scheduled re-read
  reads the file itself and is already current, and treating that as "the file
  has been taken up" cancelled the pending reload that every earlier charge
  point still needed. The baseline advances only when they all agree, and is
  dropped outright when a parse or an apply fails.
- **A partly-applied idTag reload drops the baseline, and repairs on the next
  event rather than by itself.** Several charge points can share one file, and
  the apply loop keeps going after one of them throws — so a failed reload means
  _somewhere between none and all of them changed_, never "nothing did". The
  baseline therefore claims nothing, which is what lets the operator's next
  save — **including a revert to the previous bytes** — be judged afresh rather
  than discarded as unchanged; left cached, that revert was an early-out and the
  charge points that had already moved were never brought back.
  What this does **not** do is re-sync them on its own. Dropping the baseline
  restores the ability to repair; the repair happens on the next event for that
  file. On a quiet daemon there may be none — a charge point already reconciled
  is not revisited — so until the operator touches the file again the fleet can
  hold two different pools from one path. A restart also repairs it: the
  reconcile markers start empty and every charge point is compared against the
  file afresh.
- **Debounced.** Editors save in bursts — write a temp file, rename it over the
  target, touch the mtime — so an undebounced watch fires two or three times per
  save and can read a truncated intermediate file. The watch waits 200 ms after
  the last event, then reads once. Identical bytes are not a reload and produce
  no event.
- **A malformed file never lands, and `rejected` is true of everything.** The
  reload path applies exactly the checks the load path applies, and an idTag
  pool is written to `--state-db` **before** the live pool is touched — so the
  charge point whose write fails is left exactly as it was, and its event, its
  live pool and its stored state cannot disagree. Read that as the per-charge-
  point guarantee it is: several charge points can share one file, and an
  earlier one may already be changed when a later one's write fails (see
  **A partly-applied idTag reload** above). (Persist-first rather
  than mutate-then-roll-back: a rollback would expose a window in which a
  concurrent draw presents a tag that is not durable.) A file that fails them is
  logged, reported as `rejected`, and the previous good copy stays in place — a half-saved file
  never leaves a charge point with half a configuration. A reload the control
  plane could not announce is refused the same way and for the same reason:
  applying it would leave every subscriber on the previous graph with nothing to
  say so. What is checked is the **resulting `scenario-definitions-changed`
  snapshot**, not the edited file — that envelope carries every definition on the
  connector, capped at 1 000 entries of at most 256 KiB serialized each, so an
  oversized _sibling_ scenario, or a connector already holding more scenarios
  than fit, refuses the edit even when the edited file is small. The rejection
  names the scenario id at fault.
- **An accepted reload always ends in `applied` or `rejected` — never neither.**
  Once a reload has been accepted it is either installed or reported; it is
  never left held indefinitely. A hold is released when the session ends, when
  the scenario's run settles, when a `cp.update` rebuild completes — and, as a
  backstop that does not depend on any of those firing, on **any connector
  status transition**, which no lifecycle change on a live connector avoids.
  That backstop is what makes this a guarantee rather than a list of cases: a
  gate can be opened by something that announces nothing (a `StartTransaction`
  answered with a CALLERROR returns the connector to Available without ending a
  session that never began), because the condition clearing and the
  notification are separate events.
- **A replaced run still settles its own connector.** When a scenario is
  replaced under the same id — a `scenario.definitions.replace` upload, or a
  reload draining into a connector whose previous run has not finished
  unwinding — the new run owns the executor slot, the run id and the transcript,
  and the outgoing run touches none of them. The artifacts that hang off the
  **connector** are a separate question: they are owed by the run that is
  ending, because nothing else will clear them. The scenario position is claimed
  by acquisition — a run that starts without resuming clears it, and writes that
  through, so a restart in the window before its first node completes cannot
  resume the new graph from the old graph's node ids — **except when the
  position belongs to a run that is still going.** A connector can carry two
  runs at once, and normally does: `cp.create` seeds `essential-cp-behavior` on
  every connector, it auto-starts on connect and then parks on
  `remoteStartTrigger` until a CSMS acts, so an operator's `run_scenario`
  arrives beside a run already in flight. The acquiring run asks the same
  ownership question the ending run asks — is this position mine, or a live
  neighbour's? — and leaves a live neighbour's alone. **What that cannot fix is
  structural:** the daemon holds one scenario position per connector in memory
  and one `connector_runtime` row per connector on disk, so the moment the
  incoming run completes its first node it owns the slot and the neighbour's
  checkpoint is gone. Two concurrent runs on one connector therefore share one
  checkpoint, last writer wins, and only a per-run checkpoint would change that
  — a schema change, deliberately not made. Refusing the second run instead is
  not available either: with the seeded default running on every connector it
  would refuse every operator `run_scenario` on a default daemon. The EV settings
  override is released by the run that **actually applied** it — on an ordinary
  completion as well as a replacement — and by no one else. The daemon records
  the run id that applied EV settings to a connector at the moment it applies
  them, so releasing is one comparison: the run that is ending is the run that
  claimed. A run that never declared `evSettings` claimed nothing and so leaves
  an operator's `set_ev_settings` alone (#105); an operator's `set_ev_settings`
  takes the override over, so a run in flight when it lands no longer releases
  it; and a replacement run that has applied its own settings owns them, so the
  outgoing run does not clear a live override.
  **Installed is not "has taken effect".** A replacement definition is stored
  under the id _before_ it runs, and — with the outgoing run still holding the
  executor slot, which blocks its auto-start — it may never run at all. Three
  earlier rules read the definitions map instead of the claim (is a definition
  with `evSettings` installed; is the installed definition mine; does the
  replacement declare `evSettings`) and each was wrong wherever those two points
  in time came apart. The map also never reflects the _end_ of a run: nothing
  removes an entry on completion, only a removal or a replace.
- **A hold is never left waiting on something that is gone.** A reload held for
  a connector is released when that connector's session ends, when the
  scenario's own run settles, or when a `cp.update` rebuilds the charge point.
  Two things can _destroy_ what it waits on instead of releasing it, and both
  are answered rather than left to strand. Removing the connector
  (`remove_connector`, or a `cp.update` that rebuilds the charge point with
  fewer of them) disposes it without ending a session, so the hold is reported
  **`rejected`** — naming the connector — and the file stops being watched,
  because nothing could ever apply it again. That question is asked _before_ the
  rebuild window is assumed: a rebuild is temporary for the connectors it keeps
  and permanent for the ones it drops, and the two are indistinguishable unless
  the code asks. Removing the charge point
  drops the registration and its stored row with it. And a session that never
  ran does not close the gate at all: a `StartTransaction` that is rejected, or
  answered with a CALLERROR, leaves a stopped transaction object attached to the
  connector by design, with no further notification to come — so the gate asks
  whether a session is _running_, which is the question the rest of the
  simulator already asks before refusing a duplicate start.
- **A reload never mutates a charge point mid-session.** A scenario reload for a
  connector with an open transaction, or for a scenario whose run is in flight,
  is _held_ — not dropped — and installed when that session ends. An in-flight
  transaction therefore always runs to completion on the values it started with.
  A held reload that is refused when it finally drains — a sibling scenario grew
  past the envelope cap while the session was open, say — clears its baseline
  with it, so saving those same bytes again is judged afresh rather than
  dismissed as unchanged. `lastText` names the bytes the daemon took
  responsibility for; a rejection never advances it and a failed drain clears
  it.
  A held definition is applied when the transaction stops **or when the run's
  cleanup completes**, whichever released the gate — whether the run reached the
  end of its graph, errored, or was stopped by hand with `stop_scenario`. The
  A held definition is never installed from inside the call that released it —
  not from a teardown whose own gate has already opened, and not from a registry
  mutation. Both drain triggers defer to a later microtask, so the enclosing
  synchronous work always finishes first. "The gate is clear" is not a
  sufficient condition, because installing a definition can auto-start a run
  that snapshots connector state the gate says nothing about. There are exactly
  two triggers: the settled hook, which fires where a gate actually opens, and
  the registry sync, which fires on any change to a charge point's init options
  because a `cp.update` rebuild takes the old service's lifecycle handlers with
  it and nothing else would retry. The registry ping itself stays synchronous —
  its subscriber must see the registry as the mutation left it, and the file
  watches it establishes must not be delayed — so only the drain at the end of
  it is deferred.
  The daemon waits for the blocking state to actually clear, never for the
  lifecycle event that announces it: every such event on the control plane is
  published from inside the code that is ending the thing, while the state it
  announces is still set — `scenario_completed` with the run's executor still
  registered, `transaction_stopped` and `Finishing` several statements before
  the transaction is cleared. A held reload is therefore released from the three
  points where a gate genuinely opens (a run's cleanup, a connector's
  transaction being dropped, and `reset_scenario`), which is why it lands even
  with `set_auto_reset_to_available` off, where no later `Available` status
  would arrive to retry on. A `cp.update` that rebuilds the charge point
  releases it too: the rebuild ends the session, and the held definition is
  applied to the replacement once its scenarios are back.
  An idTag pool is exempt by construction: it is drawn from once per session, so
  the transaction under way keeps the tag it presented at StartTransaction and
  only the next draw sees the new list.
- **Removing or replacing a scenario drops its watch.** Every path that takes a
  definition away drops it, and they are enumerated in one place in the code so
  a new one is noticed: `remove_scenario` (runtime and stored definition);
  a `load_scenario` that installs an inline definition under the same id;
  `scenario.definitions.delete`, which removes only the stored row and leaves
  the runtime scenario loaded — so without this the next edit would reload and
  persist exactly what was deleted; and a `scenario.definitions.replace`
  upload, which makes the console the source of truth for that connector's
  whole set. `scenario.definitions.save` is an upsert and removes nothing;
  `cp.delete` and `state.reset` are handled at the registry and schema level
  because they are about a charge point rather than one scenario. Without that the file would stay
  authoritative and the next edit would re-create a scenario the operator
  deleted, or overwrite the definition they had just uploaded. The reload path
  checks as well: a scenario the charge point no longer holds is **never
  re-created** by an edit, whichever path removed it.
- **A scenario keeps the connector it was loaded onto, and the id it was loaded
  under.** If the edited file's own `id` changed, it is ignored. Honouring it
  would load a _second_ scenario and leave the first one in place under the old
  definition. The **target** follows one of two rules, and the difference
  between them is deliberate:
  - A file behind a **startup flag** has its `targetType` / `targetId`
    _re-derived_ on every reload. `--scenario` fanned out across connectors
    keeps its independent copies, and a single-connector one repointed by hand
    is rewritten back onto the connector it is registered for rather than left
    waiting on one it is not attached to.
  - A file behind **`load_scenario { file }` or `run_scenario_file`** has its
    target _pinned_ to what the load installed. Nothing re-derives it on that
    path, so an edited target was otherwise accepted while the scenario stayed
    mapped to its registered connector — the executor then derived expectations
    from the edited `targetId` and waited on a connector its runtime callbacks
    were not operating on. A reload replaces a definition; it never moves a
    scenario. Pinning copies what is there, including a **missing**
    `targetId`: a `chargePoint`-wide scenario has none on purpose, and filling
    it in from the registration would advertise connector-specific constraints
    for a definition that deliberately has none.
- **Blueprints are not watched, and do not need to be.** A blueprint is stored
  through `blueprint.save` and lives in the `blueprints` table, not in a file
  (#297 declined a watched blueprint file deliberately, so the control plane
  stays the single source of truth). The file a blueprint can _reference_ — its
  `params.idTagPool.file` — is re-read at every `cp.create_many` instantiation,
  which is why editing it affects charge points created from the blueprint
  **afterwards** and never retroactively: charge points instantiated from a
  blueprint are independent copies, not live views of it.
- **Watching degrades, it never fails to start.** `fs.watch` is unreliable on
  network mounts and some container filesystems. When it cannot be established
  the daemon logs one line saying watching is unavailable and carries on
  unwatched, rather than refusing to start over a convenience. Degraded is
  never _worse_ than unwatched: a charge point being reconciled is measured
  against the **file on disk**, never against the bytes of the last reload that
  landed. When the two disagree the file is newer — the watch may be
  unavailable, or its debounce may simply not have run — so a charge point
  created from a pool that has since changed keeps the tags its own `cp.create`
  read, instead of having them overwritten and persisted with an older list that
  nothing would ever re-read.
- **A ConfigMap-mounted file reloads like any other.** On a Kubernetes projected
  volume the tracked files are stable symlinks and an update swaps the
  directory's `..data` symlink, so the filesystem event names `..data` and never
  the file. A **rename naming something not tracked re-checks every tracked file
  in that directory**, which covers that rotation and, locally, an editor that
  writes a temp file and renames it into place. A `change` on an unrelated
  neighbour is still ignored, so a shared directory costs nothing. The re-check
  is debounced and content-compared, so a file that did not change produces no
  event.
- **A symlink is watched at both ends.** The daemon watches the directory
  holding the path you named _and_ the directory holding whatever that path
  resolves to. The two cover disjoint cases and neither sees the other's: the
  first catches the link being **repointed** (the rotation above), the second
  catches the target **changing under a link that stays put** — an ordinary
  symlink into a shared config directory, edited in place, whose event fires in
  the target's directory and nowhere else. The target is re-resolved on every
  event that reaches the file, so repointing the link moves the second watch
  with it. Only a link at the _end_ of the path gets this: a symlinked
  _ancestor_ needs nothing extra, because `fs.watch` resolves the directory it
  is given, and repointing such an ancestor is the replaced-directory limitation
  below rather than something this covers. A broken link or a symlink cycle is
  not an error: `readlink` answers where `realpath` cannot, so the directory the
  target _will_ appear in is watched from the start and stays watched while the
  link is broken. That matters because the recreation fires **only** in the
  target's directory — closing that watch on the failure to resolve was the one
  way this could look supported and not be. **The bound on that:** the
  directory has to exist. There is nothing to open a watch on otherwise, and the
  directory appearing later fires only in an ancestor nothing is watching — so a
  target whose parent directory is still missing is not covered.
  **Every hop of a chain is watched, not just its ends** (capped at 8). Each
  link lives in a directory of its own, and what happens to that link is only
  visible there: a target created past the first missing hop lands in the last
  directory, and an intermediate link being repointed is a rename in the middle
  one. Neither is reachable from the registered path's directory or the final
  target's. This is safe where the ancestor case is not, because no directory
  along a chain is _replaced_ — only a link inside one changes — so the watches
  already open on them stay valid and see it.

## What survives a restart

Under `--state-db` the `idTagPool.file` path is persisted alongside the resolved
tags (`charge_points.id_tag_file`, schema v13), so a daemon restarted with
`--watch` watches the same files again instead of coming back holding a frozen
snapshot of a file it believes it is watching. The path is **resolved to an
absolute path when the charge point is created** and stored that way, so a
daemon restarted from a different working directory still watches the file the
operator meant. See [State persistence](state-persistence.md).

A **scenario** loaded over the control plane persists its source path the same
way (`watched_scenario_files`, schema v13), so a restarted `--watch` daemon
re-establishes that watch and reconciles an edit made while it was down. The row
is written **whether or not `--watch` is on**, for the same reason it is cleared
that way: it is a fact about stored state, not about the feature that reads it.
Only the in-memory watch is behind the flag — so a daemon run without `--watch`
still records where each scenario came from, and a later watched start has
something to restore. The
startup flags are the deliberate exception: `--scenario` and
`--scenario-template-file` are **not** written down, because the per-connector
rewrite that a fan-out depends on lives in a callback no row can carry, and the
bootstrap that owns it runs again on every boot. Persisting them would restore a
second, rewrite-less watch per connector alongside the fresh instances, under
the previous run's scenario ids. A startup registration also **deletes** any row
already stored under the key it takes over: `--scenario` keeps the file's own id
when the file already targets its connector, so it can collide with an earlier
control-plane load of that id, and the abandoned row would otherwise be restored
at the next start and applied before the bootstrap registered the configured
scenario. That deletion, too, does not depend on `--watch`.

**At most one startup scenario option is accepted.** `--scenario`,
`--scenario-template` and `--scenario-template-file` each load a definition onto
every selected connector, so two of them together is a question with no answer.
The daemon refuses the combination — at parse time in the CLI, and again before
`startServer` opens the state DB, with a message naming the flags it cannot
reconcile — rather than ranking them. Ranking is what it did before, and it did
it in three places that disagreed: the load preferred `--scenario-template`, the
boot's single file read preferred `--scenario-template-file`, and the claim
below looked only at whether either _file_ flag was set. Pass
`--scenario-template` alongside `--scenario` and the claim named the file's ids
while the load installed the built-in template, so the first pass held rows back
for a scenario the boot never loaded and they stayed unwatched until the charge
point dialled. Which flag is in effect is now resolved once, and every one of
those three readers asks the same resolver, so the load and the prediction of
the load cannot pick different flags.

The restore itself runs in **two passes**, because three constraints have to
hold at once and no single position satisfies all three:

1. **A restored charge point must not run a stale graph.** Its persisted
   connect-triggered scenarios start the moment its boot gate opens, so the
   fleet is now rebuilt **without dialling**, the watches go back on, and only
   then does it connect. The dial is split as well: a charge point **a startup
   flag is about to configure** is held back from that first round of connects
   and left to the bootstrap loop, which dials it immediately before loading the
   flag's definition — so its restored scenarios cannot start and then have the
   whole bootstrap loop pass before the flag lands. Only when `--auto-connect`
   is on, because that is what makes the bootstrap loop dial; without it nothing
   else would, and the startup load's boot-accepted wait would time out on a
   charge point deliberately left unconnected.

   **The deferral is now load-bearing, not an optimisation.** It used to exist
   so that the restored copy's auto-start and the flag's load happened next to
   each other rather than minutes apart: the stale run started, the flag's load
   took a _different_ key (generated ids carried the clock), and the stale run
   was orphaned against a definition no longer installed and died. Since a
   generated instance's id is stable, the flag's load takes the **same** key —
   so a dial that beats the install leaves `startScenarioIfNotAlreadyActive`
   looking at an already-active id, the stale executor keeps running, and the
   current graph never runs at all. The daemon therefore **installs the startup
   definition before the charge point dials** and starts it afterwards; what the
   boot gate auto-starts is then the configured definition rather than a
   restored copy of the previous boot's. Installing needs no network — the
   connect-auto-start is gated on the charge point being Available, which an
   undialled one is not — so the two halves separate cleanly.

   Two different questions are involved and they must not share an answer.
   _Which stored scenario ids will a flag overwrite?_ decides which watch rows
   wait for the second pass, and it names exactly those ids — skip more than the
   flag claims and the charge point's other restored scenarios go unwatched
   until it dials. _Which charge points is startup about to configure?_ decides
   the dial, and the id set is the wrong answer for it: it is empty for a
   built-in `--scenario-template`, whose id the daemon does not mint, so keying
   the dial on it left that mode dialling immediately.

   | Startup mode                                          | Deferred? | Dialled afterwards by                             |
   | ----------------------------------------------------- | --------- | ------------------------------------------------- |
   | `--scenario` (file already targets its one connector) | yes       | the bootstrap loop, immediately after its install |
   | `--scenario` (instantiated across connectors)         | yes       | the bootstrap loop, immediately after its install |
   | `--scenario-template`                                 | yes       | the bootstrap loop, immediately after its install |
   | `--scenario-template-file`                            | yes       | the bootstrap loop, immediately after its install |
   | restored charge point with no startup flag against it | no        | `connectRestored`, in the first round             |

   Every deferred charge point is in the bootstrap fleet, and the bootstrap loop
   iterates exactly that fleet — which is what makes the widening safe: nothing
   is deferred that nothing subsequently dials. That still holds under the
   install-before-dial ordering, and for the same reason: the loop performs the
   install, the dial and the start for each charge point in that order, so a
   deferred dial is one the loop is about to make. Only the two `--scenario`
   rows' "immediately before its load" wording changes — every mode now loads
   before its dial rather than after.

   **A startup-generated scenario has a stable id.** `--scenario` fanned across
   connectors and `--scenario-template-file` both instantiate a per-connector
   copy, and that copy is named `<file's scenario id>-c<connector>` — derived
   from the configuration, not from the clock, so it is the same id on every
   boot. It has to be: with `--state-db`, a restart restores the previous boot's
   copy, and unless the new one lands on the same key the daemon cannot
   recognise its own previous output. It then loaded a **second** graph beside
   the restored one, which stayed unwatched — a startup registration is not
   persisted, so no source row survives to re-attach a watch — and could
   auto-start, so one configured scenario produced two graphs' worth of traffic
   after every restart. The cost is a deterministic namespace: a scenario an
   operator authored under exactly that id on the same charge point is
   overwritten by the startup load rather than coexisting with it, the same
   collision `--scenario` already had whenever its file kept its own id.

   A state DB written by a build through `0f6f951` carries the old
   `<base>-c<connector>-<epoch ms>` ids, which no stable id can ever match. Each
   boot drops exactly those — that shape, on that connector, for that base id,
   and nothing else — before loading, so an upgrade self-cleans. Two cases are
   deliberately **not** pruned, because recognising them needs preparation
   metadata stored alongside the scenario: a boot that narrows
   `--scenario-connector`, and a file whose own `id` changed, both leave the
   previous boot's copy loaded on a connector this boot never touches.

   **The file is read once per boot**, and both the claim above and the load use
   that read. Because the load now happens before the dial, the registration's
   reconcile-against-disk also happens before anything can run: an edit saved
   while the fleet was still coming up is applied outright rather than deferred
   behind a run of the captured copy. They used to open it separately, minutes apart across the restored
   fleet's connect, so an edit landing in the window made the claim describe a
   file that was no longer the one being loaded — the first pass held a row back
   under the old id while the bootstrap loaded and deleted a different one, and
   the second pass then reattached the held row and reloaded the current file
   under an abandoned id. An edit that does land mid-boot is not lost: the
   registration reconciles against disk immediately, so `--watch` applies it as
   soon as the watch goes on.

2. **A startup flag owns its keys before its rows are read.** A stored row can
   name an id a startup flag will claim, so the first pass skips **exactly those
   ids** — neither applying nor pruning their rows — and a second pass after the
   startup scenarios picks up whatever the flags did not claim. By then a
   takeover has deleted the rows they did. The prediction is exact because a
   generated instance's id is now stable (below): every id the boot will load is
   knowable before it loads. It used to be _incomplete_ rather than exact — an
   instantiated copy's id carried the clock, so those modes claimed nothing and
   their rows were reconciled under ids the boot was about to abandon. Skipping
   the whole charge point instead of exactly those ids left its _other_ restored
   scenarios unwatched right up to the moment it dialled, so they auto-started
   from the database copy rather than from the file as it reads now — which is
   constraint 1 broken by constraint 2's own solution.
3. **A restored row must not overwrite a live registration.** This one is not
   solved by position at all: both passes skip keys the reloader already holds.
   Keeping it out of the ordering is what lets the first two be satisfied
   independently.

The second pass runs past the point where the daemon is **already serving**.
The HTTP listener is bound before the bootstrap begins — deliberately, so
`cp.list` answers before an unreachable CSMS times out — which means the whole
bootstrap runs concurrently with RPCs: fleet creation, the `--state-db` restore,
the connect loop, the startup scenarios and the watch restore at its end. So a
restored row **never overwrites a registration this run already holds**. A row
records what a previous run knew; a `load_scenario { file }` or
`run_scenario_file` that arrived mid-bootstrap knows better, and re-registering
over it would discard its baseline, re-apply the definition already loaded, and
— with a run in flight — hold and reinstall it when that run settles, starting
it a second time from a single request. The rows are simulator-owned state, so
`cp.delete` cascades to them and `state.reset` truncates them, with or without
`--watch`.

Both watched kinds establish the watch **before** reading the copy they compare
against, so an edit landing between a file being loaded and its watch starting
is still seen — otherwise the cached text would already be the pre-edit copy and
the reconciliation would compare the old file with the state it produced, find
them equal, and leave the charge point stale.

A file edited **while the daemon was stopped** is reconciled at startup rather
than merely watched from then on: the restore brings back the tags as of the
last time the daemon saw the file, so the daemon compares the file against what
each restored charge point actually holds and applies it if they differ. The
comparison is made **once per charge point**, not once per file — several charge
points can share one pool, and the restore re-creates them one at a time. Without
that step the current bytes would be recorded as already-seen, and the
operator's next save of that same content would be dismissed as a duplicate —
the pool would stay stale until the file happened to change again.
