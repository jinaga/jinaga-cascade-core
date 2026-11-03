# Identity and Placement

## Problem

Steps used to address a node by its position: the key path of its ancestors. When a mutable grouping key changed, `groupBy` moved the item by removing it and adding it again with the payload it had at its first add. Values that had since arrived through `onModified` were lost, and so were the item's descendants, whose positions changed with it. `filter` had the same defect when it admitted an item late. The result depended on arrival order (issue #29).

## Model

The output is a forest of nodes.

- **Level**: the array path of a node in the type descriptor (`pathSegments`).
- **Identity**: `(level, key)`. Keys are unique within a level across the whole pipeline.
- **Placement**: the key of the node's parent at the level above, or none at the root. Placement is a value of the node and can change.
- **Values**: the node's properties.

Every key below the root is unique within its level by construction:

| Source of nodes | Key |
|---|---|
| Root rows | The key passed to `add` (unique by contract) |
| Source-level children (`collection().add`) | `computeChildKey(parentKey, key)` |
| `groupBy` groups at the root | `computeGroupKey(values)` |
| `groupBy` groups at a nested scope | `computeChildKey(parentKey, canonical(values))` |
| `flatten` items | The child's key |

## Events

| Event | Meaning |
|---|---|
| `onAdded(parentKey, key, props)` | The node exists, with placement `parentKey` and complete current values `props`. |
| `onRemoved(key, props)` | The node no longer exists. |
| `onModified(key, old, new)` | One value of the node changed. |
| `onPlaced(key, oldParent, newParent)` | The node's placement changed. |

A node's descendants are addressed by their own identity, so a move is a single event, and an ancestor's move never changes a descendant's address.

A node is removed only after its descendants. The input step guarantees this: removing a row first removes the children it received through `collection()`, deepest first. Steps that create nodes keep it too: `groupBy` removes a group only when it is empty, `filter` removes a hidden subtree children first, and `flatten` removes flattened children with their parent. No step ever sees a parent leave while it still has children.

## Proof obligation per step

Let `S` be the current set of input rows. Each step holds state `σ` and must satisfy:

1. **State is a function of the set.** `σ = g(S)` after every event, where `g` does not depend on the order in which rows arrived.
2. **Emissions are the difference.** For an event that takes `S` to `S'`, the events the step emits take its output from `f(S)` to `f(S')`.

Because every step keys state by identity, a step's proof refers only to its own input and output events. Correctness of a pipeline follows by composition. The tests in `src/test/pipeline.placement.test.ts` check the consequence directly: every permutation of the input operations produces the same output.

How each kind of step meets the obligations:

- **Aggregates** (`sum`, `count`, `min`, `max`, `average`, `pickBy*`) keep each item's placement and latest value, and one accumulator per parent. An item contributes to exactly one parent at a time. `onPlaced` moves its contribution, and `onModified` replaces it.
- **`groupBy`** keeps each item's placement and grouping values, and the members of each group. A change to either moves the item: add the new group if needed, emit `onPlaced`, then remove the old group if it is empty. Nothing below the item level is re-emitted.
- **`filter`** is a membership step. A hidden item is not in the output, so the step keeps the complete current state of every node at or below its scope. An item that becomes visible is added with its current values, followed by its subtree. An item that becomes hidden has its subtree removed, children first. The change that triggered either transition is not forwarded, because the add already carries it.
- **`flatten`** keys flattened items by the child's key. When a parent moves, its flattened children move with it. When a child moves, it takes on the new parent's values.
- **`cumulativeSum`, `replaceToDelta`** keep one sorted order per parent. A move removes the item from one order and inserts it into another, updating the successors in both.
- **Output store** keeps a `PlacementIndex` so it can locate a node. Each operation is located when it is queued, so applying a batch is a pure function of the state.

## A future sort step

Under this model, position within a parent is derived from a sort key and the node key. A change of sort key is an `onModified`. Only the output store needs to compute a position. No step re-emits a subtree.
