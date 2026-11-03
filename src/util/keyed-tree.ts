import type { ImmutableProps } from '../pipeline.js';

export type KeyedTree = { key: string; value: object }[];

interface PlacedNode {
    parentKey: string | undefined;
    /** Ids of the node's children, at any child level. */
    children: Set<string>;
}

function nodeId(segmentPath: string[], key: string): string {
    return `${segmentPath.join('\u0000')}\u0001${key}`;
}

/**
 * Records each node's parent so that a node addressed by (level, key) can be located in a
 * tree of keyed arrays. The location of a node at level L is the key path of its ancestors,
 * one key per segment of L. Removing a node forgets its descendants.
 */
export class PlacementIndex {
    private readonly nodes = new Map<string, PlacedNode>();

    has(segmentPath: string[], key: string): boolean {
        return this.nodes.has(nodeId(segmentPath, key));
    }

    parentOf(segmentPath: string[], key: string): string | undefined {
        return this.nodes.get(nodeId(segmentPath, key))?.parentKey;
    }

    /** Records a node, or changes its parent. The parent must already be recorded. */
    set(segmentPath: string[], key: string, parentKey: string | undefined): void {
        const id = nodeId(segmentPath, key);
        const existing = this.nodes.get(id);
        if (existing) {
            this.unlink(segmentPath, id, existing.parentKey);
            existing.parentKey = parentKey;
        } else {
            this.nodes.set(id, { parentKey, children: new Set() });
        }
        if (segmentPath.length > 0 && parentKey !== undefined) {
            this.nodes.get(nodeId(segmentPath.slice(0, -1), parentKey))?.children.add(id);
        }
    }

    /** Forgets a node and all of its descendants. */
    delete(segmentPath: string[], key: string): void {
        const id = nodeId(segmentPath, key);
        const node = this.nodes.get(id);
        if (!node) {
            return;
        }
        this.unlink(segmentPath, id, node.parentKey);
        this.forget(id);
    }

    /**
     * Key path of the ancestors of a node at `segmentPath` whose parent is `parentKey`,
     * or undefined when an ancestor is not recorded.
     */
    locate(segmentPath: string[], parentKey: string | undefined): string[] | undefined {
        const keyPath: string[] = [];
        let level = segmentPath;
        let currentParent = parentKey;
        while (level.length > 0) {
            level = level.slice(0, -1);
            if (currentParent === undefined || !this.has(level, currentParent)) {
                return undefined;
            }
            keyPath.unshift(currentParent);
            currentParent = this.parentOf(level, currentParent);
        }
        return keyPath;
    }

    /** Location of a recorded node: the key path of its ancestors. */
    locateNode(segmentPath: string[], key: string): string[] | undefined {
        if (!this.has(segmentPath, key)) {
            return undefined;
        }
        return this.locate(segmentPath, this.parentOf(segmentPath, key));
    }

    private unlink(segmentPath: string[], id: string, parentKey: string | undefined): void {
        if (segmentPath.length > 0 && parentKey !== undefined) {
            this.nodes.get(nodeId(segmentPath.slice(0, -1), parentKey))?.children.delete(id);
        }
    }

    private forget(id: string): void {
        const node = this.nodes.get(id);
        if (!node) {
            return;
        }
        this.nodes.delete(id);
        node.children.forEach(childId => this.forget(childId));
    }
}

function asRecord(value: object): Record<string, unknown> {
    return value as Record<string, unknown>;
}

function nestedArray(value: object, segment: string): KeyedTree {
    const nested = asRecord(value)[segment];
    return Array.isArray(nested) ? nested as KeyedTree : [];
}

/** Applies `update` to the keyed array at `segmentPath` under the ancestors in `keyPath`. */
function updateArrayAt(
    state: KeyedTree,
    segmentPath: string[],
    keyPath: string[],
    update: (array: KeyedTree) => KeyedTree
): KeyedTree | undefined {
    if (segmentPath.length === 0) {
        return update(state);
    }
    const parentIndex = state.findIndex(item => item.key === keyPath[0]);
    if (parentIndex < 0) {
        return undefined;
    }
    const parent = state[parentIndex];
    const segment = segmentPath[0];
    const updated = updateArrayAt(nestedArray(parent.value, segment), segmentPath.slice(1), keyPath.slice(1), update);
    if (updated === undefined) {
        return undefined;
    }
    const next = [...state];
    next[parentIndex] = { key: parent.key, value: { ...asRecord(parent.value), [segment]: updated } };
    return next;
}

/** Each operation returns undefined when an ancestor in `keyPath` is missing. */
export function addNode(state: KeyedTree, segmentPath: string[], keyPath: string[], key: string, props: ImmutableProps): KeyedTree | undefined {
    return updateArrayAt(state, segmentPath, keyPath, array => [...array, { key, value: props }]);
}

export function removeNode(state: KeyedTree, segmentPath: string[], keyPath: string[], key: string): KeyedTree | undefined {
    return updateArrayAt(state, segmentPath, keyPath, array => array.filter(item => item.key !== key));
}

export function modifyNode(
    state: KeyedTree,
    segmentPath: string[],
    keyPath: string[],
    key: string,
    name: string,
    value: unknown
): KeyedTree | undefined {
    let found = false;
    const result = updateArrayAt(state, segmentPath, keyPath, array => array.map(item => {
        if (item.key !== key) {
            return item;
        }
        found = true;
        return { key, value: { ...asRecord(item.value), [name]: value } };
    }));
    return found ? result : undefined;
}

/** Moves a node, with its subtree, from one parent to another at the same level. */
export function moveNode(
    state: KeyedTree,
    segmentPath: string[],
    fromKeyPath: string[],
    toKeyPath: string[],
    key: string
): KeyedTree | undefined {
    let moved: KeyedTree[number] | undefined;
    const removed = updateArrayAt(state, segmentPath, fromKeyPath, array => {
        moved = array.find(item => item.key === key);
        return array.filter(item => item.key !== key);
    });
    if (removed === undefined || moved === undefined) {
        return undefined;
    }
    const node = moved;
    return updateArrayAt(removed, segmentPath, toKeyPath, array => [...array, node]);
}
