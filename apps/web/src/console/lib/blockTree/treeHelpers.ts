import type { ScenarioNode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

import { isEndSink } from "./structural";
import type { Block, BlockTree, Def, Seq } from "./types";

/** The node a block is entered at. */
export function firstNodeOf(block: Block): ScenarioNode {
  if (block.kind === "loop") return firstNodeOf(block.body.blocks[0]);
  return block.node;
}

/** Every sequence of the tree, depth first (root, then detached). */
export function allSeqs(tree: Pick<BlockTree, "root" | "detached">): Seq[] {
  const out: Seq[] = [];
  const visit = (seq: Seq) => {
    out.push(seq);
    for (const block of seq.blocks) {
      if (block.kind === "fork") for (const l of block.lanes) visit(l.body);
      if (block.kind === "loop") visit(block.body);
    }
  };
  visit(tree.root);
  tree.detached.forEach(visit);
  return out;
}

/** Every node the tree places (fork nodes and the origin included), in
 *  pre-order. */
export function treeNodes(
  tree: Pick<BlockTree, "root" | "detached" | "origin">,
): ScenarioNode[] {
  const out: ScenarioNode[] = [];
  const rootFork = tree.root.blocks[0];
  if (
    tree.origin &&
    !(rootFork?.kind === "fork" && rootFork.node.id === tree.origin.id)
  ) {
    out.push(tree.origin);
  }
  const visit = (seq: Seq) => {
    for (const block of seq.blocks) {
      if (block.kind === "step") out.push(block.node);
      if (block.kind === "fork") {
        out.push(block.node);
        for (const l of block.lanes) visit(l.body);
      }
      if (block.kind === "loop") visit(block.body);
    }
  };
  visit(tree.root);
  tree.detached.forEach(visit);
  return out;
}

/**
 * Throws unless the tree places every node other than END exactly once and
 * accounts for every edge exactly once (drawn or a link). Dev / test check.
 */
export function assertTreeCovers(def: Def, tree: BlockTree): void {
  const origin = tree.origin ?? undefined;
  const expected = new Set<string>();
  for (const node of def.nodes) {
    if (!isEndSink(node, origin)) expected.add(node.id);
  }
  const seen = new Map<string, number>();
  for (const node of treeNodes(tree)) {
    seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count !== 1) throw new Error(`node ${id} placed ${count} times`);
    if (!expected.has(id)) throw new Error(`node ${id} is not in the file`);
  }
  for (const id of expected) {
    if (!seen.has(id)) throw new Error(`node ${id} is not placed`);
  }
  const edgeCount = new Map<string, number>();
  for (const id of tree.drawnEdges.keys()) edgeCount.set(id, 1);
  for (const link of tree.links) {
    edgeCount.set(link.edge.id, (edgeCount.get(link.edge.id) ?? 0) + 1);
  }
  const fileIds = new Set(def.edges.map((e) => e.id));
  for (const [id, count] of edgeCount) {
    if (count !== 1) throw new Error(`edge ${id} accounted ${count} times`);
    if (!fileIds.has(id)) throw new Error(`edge ${id} is not in the file`);
  }
  for (const id of fileIds) {
    if (!edgeCount.has(id)) throw new Error(`edge ${id} is not accounted`);
  }
}
