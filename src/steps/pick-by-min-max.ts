import type {
    AddedHandler,
    BuildContext,
    BuiltStepGraph,
    DescriptorNode,
    ImmutableProps,
    ModifiedHandler,
    ObjectDescriptor,
    PlacedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
    TypeDescriptor
} from '../pipeline.js';
import { IndexedHeap } from '../util/indexed-heap.js';
import { getMutablePropertiesOfArrayItems } from '../pipeline.js';
import { appendMutableIfMissing, appendObjectIfMissing, emptyDescriptorNode, updateNodeAt } from '../util/descriptor-transform.js';

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

function transformPickByMinMaxDescriptor(
    inputDescriptor: TypeDescriptor,
    segmentPath: string[],
    propertyName: string
): TypeDescriptor {
    let currentDescriptor: DescriptorNode = inputDescriptor;
    for (let i = 0; i < segmentPath.length - 1; i++) {
        const segment = segmentPath[i];
        const array = currentDescriptor.arrays.find(a => a.name === segment);
        if (array) {
            currentDescriptor = array.type;
        }
    }

    const arrayName = segmentPath[segmentPath.length - 1];
    const sourceArray = currentDescriptor.arrays.find(a => a.name === arrayName);

    const objectDesc: ObjectDescriptor = {
        name: propertyName,
        type: sourceArray?.type ?? emptyDescriptorNode()
    };

    return updateNodeAt(inputDescriptor, segmentPath.slice(0, -1), node =>
        appendMutableIfMissing(appendObjectIfMissing(node, objectDesc), propertyName)
    );
}

interface ItemRecord {
    parentKey: string;
    /** Complete current values of the item. */
    props: ImmutableProps;
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
    /** Placement and current values of every tracked item. */
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
        private comparator: (value1: number | string, value2: number | string) => number,
        inputDescriptor: TypeDescriptor
    ) {
        this.input.onAdded(this.segmentPath, (parentKey, itemKey, immutableProps) => {
            if (parentKey !== undefined) {
                this.items.set(itemKey, { parentKey, props: immutableProps });
                this.insert(itemKey);
                this.emitModification(parentKey);
            }
        });
        this.input.onRemoved(this.segmentPath, itemKey => {
            const record = this.items.get(itemKey);
            if (record) {
                this.withdraw(itemKey);
                this.items.delete(itemKey);
                this.emitModification(record.parentKey);
            }
        });
        this.input.onPlaced(this.segmentPath, (itemKey, oldParentKey, newParentKey) => {
            const record = this.items.get(itemKey);
            if (record) {
                this.withdraw(itemKey);
                record.parentKey = newParentKey;
                this.insert(itemKey);
                this.emitModification(oldParentKey);
                this.emitModification(newParentKey);
            }
        });

        // The picked object is the whole item, so every mutable property is tracked.
        for (const mutableProp of getMutablePropertiesOfArrayItems(inputDescriptor, this.segmentPath)) {
            this.input.onModified(this.segmentPath, mutableProp, (itemKey, _oldValue, newValue) => {
                this.handleMutablePropertyChanged(itemKey, mutableProp, newValue);
            });
        }
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

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        this.input.onPlaced(pathSegments, handler);
    }

    private isParentPath(pathSegments: string[]): boolean {
        const parentSegments = this.segmentPath.slice(0, -1);
        if (pathSegments.length !== parentSegments.length) {
            return false;
        }
        return pathSegments.every((segment, index) => segment === parentSegments[index]);
    }

    private getComparisonValue(itemRecord: ItemRecord): number | string | undefined {
        return parseComparisonValue(itemRecord.props[this.comparisonProperty]);
    }

    private insert(itemKey: string): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        const comparisonValue = this.getComparisonValue(record);
        if (comparisonValue === undefined) {
            return;
        }
        let heap = this.heaps.get(record.parentKey);
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
            this.heaps.set(record.parentKey, heap);
        }
        heap.insert({ comparisonValue, tieBreakerId: itemKey }, itemKey);
    }

    private withdraw(itemKey: string): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        const heap = this.heaps.get(record.parentKey);
        if (heap) {
            heap.removeById(itemKey);
            if (heap.isEmpty()) {
                this.heaps.delete(record.parentKey);
            }
        }
    }

    private handleMutablePropertyChanged(itemKey: string, property: string, newValue: unknown): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        const oldComparisonValue = this.getComparisonValue(record);
        record.props = { ...record.props, [property]: newValue };
        if (!comparisonValuesEqual(oldComparisonValue, this.getComparisonValue(record))) {
            this.withdraw(itemKey);
            this.insert(itemKey);
        }
        this.emitModification(record.parentKey);
    }

    private materializePickedItem(parentKey: string): ImmutableProps | undefined {
        const topEntry = this.heaps.get(parentKey)?.peek();
        return topEntry ? this.items.get(topEntry.id)?.props : undefined;
    }

    /**
     * Emits a modification event for the picked object.
     */
    private emitModification(parentKey: string): void {
        const oldPickedItem = this.lastEmitted.get(parentKey);
        const newPickedItem = this.materializePickedItem(parentKey);

        if (newPickedItem === undefined) {
            this.lastEmitted.delete(parentKey);
        } else {
            this.lastEmitted.set(parentKey, newPickedItem);
        }

        // The same picked object, unchanged, is not a change.
        if (!Object.is(oldPickedItem, newPickedItem)) {
            this.modifiedHandlers.forEach(handler => handler(parentKey, oldPickedItem, newPickedItem));
        }
    }
}

export class PickByMinMaxBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private comparisonProperty: string,
        private comparator: (value1: number | string, value2: number | string) => number
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformPickByMinMaxDescriptor(
            this.upstream.getTypeDescriptor(),
            this.segmentPath,
            this.propertyName
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new PickByMinMaxStep(
                up.lastStep,
                this.segmentPath,
                this.propertyName,
                this.comparisonProperty,
                this.comparator,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}

