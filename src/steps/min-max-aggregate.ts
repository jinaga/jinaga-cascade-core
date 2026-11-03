import type { AddedHandler, BuildContext, BuiltStepGraph, ModifiedHandler, PlacedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';
import { IndexedHeap } from '../util/indexed-heap.js';

/**
 * Parses a value as a finite number.
 */
function parseNumericValue(value: unknown): number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function transformMinMaxAggregateDescriptor(
    inputDescriptor: TypeDescriptor,
    propertyName: string
): TypeDescriptor {
    const outputScalar = {
        name: propertyName,
        type: 'number' as const
    };
    const scalars = inputDescriptor.scalars.some(s => s.name === propertyName)
        ? inputDescriptor.scalars
        : [...inputDescriptor.scalars, outputScalar];
    const mutableProperties = inputDescriptor.mutableProperties;
    if (!mutableProperties.includes(propertyName)) {
        return {
            ...inputDescriptor,
            scalars,
            mutableProperties: [...mutableProperties, propertyName]
        };
    }
    return {
        ...inputDescriptor,
        scalars
    };
}

/**
 * A step that computes the minimum or maximum value of a property over items in a nested array.
 *
 * - Returns undefined for empty arrays
 * - Ignores null/undefined values in comparison
 * - Uses an indexed heap for O(log n) add/remove/update and O(1) min/max lookup
 */
export class MinMaxAggregateStep<
    _TInput,
    TPath extends string[],
    TPropertyName extends string
> implements Step {
    /** Values of each parent's items, ordered by the comparator. */
    private readonly heaps: Map<string, IndexedHeap<number>> = new Map();

    /** Placement and current numeric value of each item. */
    private readonly items: Map<string, { parentKey: string; value: number | undefined }> = new Map();

    /** Last emitted aggregate value per parent (for oldValue tracking) */
    private readonly lastEmitted: Map<string, number | undefined> = new Map();

    /** Handlers interested in aggregate modifications at the parent level */
    private readonly modifiedHandlers: ModifiedHandler[] = [];

    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string,
        private comparator: (a: number, b: number) => number,
        inputDescriptor: TypeDescriptor
    ) {
        this.input.onAdded(this.segmentPath, (parentKey, itemKey, immutableProps) => {
            if (parentKey !== undefined) {
                this.items.set(itemKey, { parentKey, value: parseNumericValue(immutableProps[this.numericProperty]) });
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
        if (inputDescriptor.mutableProperties.includes(numericProperty)) {
            this.input.onModified(this.segmentPath, numericProperty, (itemKey, _oldValue, newValue) => {
                const record = this.items.get(itemKey);
                if (record) {
                    this.withdraw(itemKey);
                    record.value = parseNumericValue(newValue);
                    this.insert(itemKey);
                    this.emitModification(record.parentKey);
                }
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

    /** Adds the item's value to its parent's heap. */
    private insert(itemKey: string): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        if (record.value !== undefined) {
            let heap = this.heaps.get(record.parentKey);
            if (!heap) {
                heap = new IndexedHeap<number>(this.comparator);
                this.heaps.set(record.parentKey, heap);
            }
            heap.insert(record.value, itemKey);
        }
    }

    /** Removes the item's value from its parent's heap. */
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

    private emitModification(parentKey: string): void {
        const oldAggregate = this.lastEmitted.get(parentKey);
        const newAggregate = this.heaps.get(parentKey)?.peek()?.value;

        if (newAggregate === undefined) {
            this.lastEmitted.delete(parentKey);
        } else {
            this.lastEmitted.set(parentKey, newAggregate);
        }

        if (!Object.is(oldAggregate, newAggregate)) {
            this.modifiedHandlers.forEach(handler => handler(parentKey, oldAggregate, newAggregate));
        }
    }
}

export class MinMaxAggregateBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private numericProperty: string,
        private comparator: (a: number, b: number) => number
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformMinMaxAggregateDescriptor(this.upstream.getTypeDescriptor(), this.propertyName);
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new MinMaxAggregateStep(
                up.lastStep,
                this.segmentPath,
                this.propertyName,
                this.numericProperty,
                this.comparator,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}
