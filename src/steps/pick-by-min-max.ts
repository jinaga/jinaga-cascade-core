import type { AddedHandler, DescriptorNode, ImmutableProps, ModifiedHandler, ObjectDescriptor, RemovedHandler, Step, TypeDescriptor } from '../pipeline.js';
import { IndexedHeap } from '../util/indexed-heap.js';
import { appendMutableIfMissing, appendObjectIfMissing, emptyDescriptorNode } from '../util/descriptor-transform.js';

/**
 * Computes a hash key for a key path (for map lookups).
 */
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

/**
 * Determines if a value is numeric.
 */
function isNumeric(value: unknown): value is number {
    if (typeof value === 'number') {
        return !isNaN(value);
    }
    const numValue = Number(value);
    return !isNaN(numValue) && isFinite(numValue);
}

function parseComparisonValue(value: unknown): number | string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (isNumeric(value)) {
        return Number(value);
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        // Non-serializable values are treated as undefined and ignored in comparisons.
        return undefined;
    }
}

function comparisonValuesEqual(
    left: number | string | undefined,
    right: number | string | undefined
): boolean {
    return left === right;
}

interface ItemRecord {
    immutableProps: ImmutableProps;
    mutableProps: Record<string, unknown>;
}

interface HeapValue {
    comparisonValue: number | string;
    tieBreakerId: string;
}

/**
 * A step that picks the object with the minimum or maximum value of a property from a nested array.
 *
 * - Returns undefined for empty arrays
 * - Ignores null/undefined values in comparison
 * - Supports both numeric and string comparisons
 * - Uses an indexed heap for O(log n) updates and O(1) current pick lookup
 */
export class PickByMinMaxStep<
    _TInput,
    TPath extends string[],
    TPropertyName extends string
> implements Step {
    /** Canonical payload store for all tracked items */
    private readonly items: Map<string, ItemRecord> = new Map();

    /** Heap per parent for ordered comparison values */
    private readonly heaps: Map<string, IndexedHeap<HeapValue>> = new Map();

    /** Last emitted picked item per parent (for oldValue tracking) */
    private readonly lastEmitted: Map<string, ImmutableProps | undefined> = new Map();

    /** Handlers interested in picked-item modifications at the parent level */
    private readonly modifiedHandlers: ModifiedHandler[] = [];

    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private comparisonProperty: string,
        private comparator: (value1: number | string, value2: number | string) => number
    ) {
        const inputDescriptor = input.getTypeDescriptor();
        const rootMutableProperties = inputDescriptor.mutableProperties;
        const isPropertyMutable = rootMutableProperties.includes(comparisonProperty);

        this.input.onAdded(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemAdded(keyPath, itemKey, immutableProps);
        });

        this.input.onRemoved(this.segmentPath, (keyPath, itemKey) => {
            this.handleItemRemoved(keyPath, itemKey);
        });

        if (isPropertyMutable) {
            for (const mutableProp of rootMutableProperties) {
                this.input.onModified(this.segmentPath, mutableProp, (keyPath, itemKey, _oldValue, newValue) => {
                    this.handleMutablePropertyChanged(keyPath, itemKey, mutableProp, newValue);
                });
            }
        }
    }

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();

        // Navigate through the segment path to find the source array's item type.
        let currentDescriptor: DescriptorNode = inputDescriptor;
        for (let i = 0; i < this.segmentPath.length - 1; i++) {
            const segment = this.segmentPath[i];
            const array = currentDescriptor.arrays.find(a => a.name === segment);
            if (array) {
                currentDescriptor = array.type;
            }
        }

        const arrayName = this.segmentPath[this.segmentPath.length - 1];
        const sourceArray = currentDescriptor.arrays.find(a => a.name === arrayName);

        const objectDesc: ObjectDescriptor = {
            name: this.propertyName,
            type: sourceArray?.type ?? emptyDescriptorNode()
        };

        if (this.segmentPath.length === 1) {
            const withObject = appendObjectIfMissing(inputDescriptor, objectDesc);
            return appendMutableIfMissing(withObject, this.propertyName) as TypeDescriptor;
        }

        const result = this.addObjectAtPath(inputDescriptor, this.segmentPath.slice(0, -1), objectDesc);
        return {
            ...appendMutableIfMissing(result, this.propertyName),
            rootCollectionName: inputDescriptor.rootCollectionName
        };
    }

    /**
     * Recursively clones the type descriptor and adds an object descriptor at the specified path.
     */
    private addObjectAtPath(
        descriptor: DescriptorNode,
        path: string[],
        objectDesc: ObjectDescriptor
    ): DescriptorNode {
        if (path.length === 0) {
            return appendObjectIfMissing(descriptor, objectDesc);
        }

        const [first, ...rest] = path;
        return {
            ...descriptor,
            arrays: descriptor.arrays.map(arr => {
                if (arr.name === first) {
                    return {
                        ...arr,
                        type: this.addObjectAtPath(arr.type, rest, objectDesc)
                    };
                }
                return arr;
            }),
            objects: descriptor.objects
        };
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (this.isParentPath(pathSegments) && propertyName === this.propertyName) {
            this.modifiedHandlers.push(handler);
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    /**
     * Checks if the given path segments represent the parent level (where picked object property lives).
     */
    private isParentPath(pathSegments: string[]): boolean {
        const parentSegments = this.segmentPath.slice(0, -1);
        if (pathSegments.length !== parentSegments.length) {
            return false;
        }
        return pathSegments.every((segment, index) => segment === parentSegments[index]);
    }

    private getItemKeyHash(parentKeyPath: string[], itemKey: string): string {
        return computeKeyPathHash([...parentKeyPath, itemKey]);
    }

    private getOrCreateHeap(parentKeyHash: string): IndexedHeap<HeapValue> {
        let heap = this.heaps.get(parentKeyHash);
        if (!heap) {
            heap = new IndexedHeap<HeapValue>((left, right) => {
                const comparisonResult = this.comparator(left.comparisonValue, right.comparisonValue);
                if (comparisonResult !== 0) {
                    return comparisonResult;
                }
                if (left.tieBreakerId < right.tieBreakerId) {
                    return -1;
                }
                if (left.tieBreakerId > right.tieBreakerId) {
                    return 1;
                }
                return 0;
            });
            this.heaps.set(parentKeyHash, heap);
        }
        return heap;
    }

    private removeHeapIfEmpty(parentKeyHash: string): void {
        const heap = this.heaps.get(parentKeyHash);
        if (heap?.isEmpty()) {
            this.heaps.delete(parentKeyHash);
        }
    }

    private getCurrentPropertyValue(itemRecord: ItemRecord, property: string): unknown {
        if (Object.prototype.hasOwnProperty.call(itemRecord.mutableProps, property)) {
            return itemRecord.mutableProps[property];
        }
        return itemRecord.immutableProps[property];
    }

    private getComparisonValue(itemRecord: ItemRecord): number | string | undefined {
        const rawValue = this.getCurrentPropertyValue(itemRecord, this.comparisonProperty);
        return parseComparisonValue(rawValue);
    }

    private handleItemAdded(parentKeyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const itemKeyHash = this.getItemKeyHash(parentKeyPath, itemKey);
        const itemRecord: ItemRecord = {
            immutableProps: item,
            mutableProps: {}
        };

        this.items.set(itemKeyHash, itemRecord);

        const comparisonValue = this.getComparisonValue(itemRecord);
        if (comparisonValue !== undefined) {
            this.getOrCreateHeap(parentKeyHash).insert(
                {
                    comparisonValue,
                    tieBreakerId: itemKeyHash
                },
                itemKeyHash
            );
        }

        this.emitModification(parentKeyPath);
    }

    private handleItemRemoved(parentKeyPath: string[], itemKey: string): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const itemKeyHash = this.getItemKeyHash(parentKeyPath, itemKey);

        const heap = this.heaps.get(parentKeyHash);
        if (heap) {
            heap.removeById(itemKeyHash);
            this.removeHeapIfEmpty(parentKeyHash);
        }

        this.items.delete(itemKeyHash);
        this.emitModification(parentKeyPath);
    }

    /**
     * Handle when any mutable property of an item changes.
     */
    private handleMutablePropertyChanged(
        parentKeyPath: string[],
        itemKey: string,
        property: string,
        newValue: unknown
    ): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const itemKeyHash = this.getItemKeyHash(parentKeyPath, itemKey);
        const itemRecord = this.items.get(itemKeyHash);
        if (!itemRecord) {
            return;
        }

        const oldComparisonValue =
            property === this.comparisonProperty
                ? this.getComparisonValue(itemRecord)
                : undefined;

        // Always store the latest mutable value, including null/undefined.
        // Undefined/null must shadow immutable props for correct valid -> null transitions.
        itemRecord.mutableProps[property] = newValue;

        if (property === this.comparisonProperty) {
            const newComparisonValue = this.getComparisonValue(itemRecord);
            if (!comparisonValuesEqual(oldComparisonValue, newComparisonValue)) {
                const heap = this.heaps.get(parentKeyHash);
                if (heap) {
                    heap.removeById(itemKeyHash);
                    this.removeHeapIfEmpty(parentKeyHash);
                }
                if (newComparisonValue !== undefined) {
                    this.getOrCreateHeap(parentKeyHash).insert(
                        {
                            comparisonValue: newComparisonValue,
                            tieBreakerId: itemKeyHash
                        },
                        itemKeyHash
                    );
                }
            }
        }

        this.emitModification(parentKeyPath);
    }

    private materializePickedItem(parentKeyHash: string): ImmutableProps | undefined {
        const heap = this.heaps.get(parentKeyHash);
        if (!heap) {
            return undefined;
        }

        let topEntry = heap.peek();
        while (topEntry) {
            const itemRecord = this.items.get(topEntry.id);
            if (itemRecord) {
                return {
                    ...itemRecord.immutableProps,
                    ...itemRecord.mutableProps
                };
            }
            heap.removeById(topEntry.id);
            topEntry = heap.peek();
        }

        this.heaps.delete(parentKeyHash);
        return undefined;
    }

    /**
     * Emits a modification event for the picked object.
     */
    private emitModification(parentKeyPath: string[]): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const oldPickedItem = this.lastEmitted.get(parentKeyHash);
        const newPickedItem = this.materializePickedItem(parentKeyHash);

        if (newPickedItem === undefined) {
            this.lastEmitted.delete(parentKeyHash);
        } else {
            this.lastEmitted.set(parentKeyHash, newPickedItem);
        }

        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            this.modifiedHandlers.forEach(handler => {
                handler(keyPathToParent, parentKey, oldPickedItem, newPickedItem);
            });
            return;
        }

        this.modifiedHandlers.forEach(handler => {
            handler([], '', oldPickedItem, newPickedItem);
        });
    }
}

