import type { AddedHandler, BuildContext, BuiltStepGraph, ImmutableProps, ModifiedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';
import { getDescriptorFromFactory } from '../step-builder-utils.js';
import { IndexedHeap } from '../util/indexed-heap.js';

/**
 * Computes a hash key for a key path (for map lookups).
 */
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

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
    /** Canonical representation of values by parent group */
    private readonly heaps: Map<string, IndexedHeap<number>> = new Map();

    /** Last emitted aggregate value per parent (for oldValue tracking) */
    private readonly lastEmitted: Map<string, number | undefined> = new Map();

    /** Handlers interested in aggregate modifications at the parent level */
    private readonly modifiedHandlers: ModifiedHandler[] = [];

    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string,
        private comparator: (a: number, b: number) => number
    ) {
        const inputDescriptor = input.getTypeDescriptor();
        const rootMutableProperties = inputDescriptor.mutableProperties;
        const isPropertyMutable = rootMutableProperties.includes(numericProperty);

        this.input.onAdded(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemAdded(keyPath, itemKey, immutableProps);
        });

        this.input.onRemoved(this.segmentPath, (keyPath, itemKey) => {
            this.handleItemRemoved(keyPath, itemKey);
        });

        if (isPropertyMutable) {
            this.input.onModified(this.segmentPath, numericProperty, (keyPath, itemKey, _oldValue, newValue) => {
                this.handleItemPropertyChanged(keyPath, itemKey, newValue);
            });
        }
    }

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        
        // Add aggregate output to scalars (idempotent: only add if not already present)
        const outputScalar = {
            name: this.propertyName,
            type: 'number' as const
        };
        const scalars = inputDescriptor.scalars.some(s => s.name === this.propertyName)
            ? inputDescriptor.scalars
            : [...inputDescriptor.scalars, outputScalar];
        
        const mutableProperties = inputDescriptor.mutableProperties;
        if (!mutableProperties.includes(this.propertyName)) {
            return {
                ...inputDescriptor,
                scalars,
                mutableProperties: [...mutableProperties, this.propertyName]
            };
        }
        return {
            ...inputDescriptor,
            scalars
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
     * Checks if the given path segments represent the parent level (where aggregate property lives).
     */
    private isParentPath(pathSegments: string[]): boolean {
        const parentSegments = this.segmentPath.slice(0, -1);
        if (pathSegments.length !== parentSegments.length) {
            return false;
        }
        return pathSegments.every((segment, index) => segment === parentSegments[index]);
    }

    private getOrCreateHeap(parentKeyHash: string): IndexedHeap<number> {
        let heap = this.heaps.get(parentKeyHash);
        if (!heap) {
            heap = new IndexedHeap<number>(this.comparator);
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

    private handleItemAdded(parentKeyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const numericValue = parseNumericValue(item[this.numericProperty]);
        if (numericValue !== undefined) {
            this.getOrCreateHeap(parentKeyHash).insert(numericValue, itemKey);
        }
        this.emitModification(parentKeyPath);
    }

    private handleItemRemoved(parentKeyPath: string[], itemKey: string): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const heap = this.heaps.get(parentKeyHash);
        if (heap) {
            heap.removeById(itemKey);
            this.removeHeapIfEmpty(parentKeyHash);
        }
        this.emitModification(parentKeyPath);
    }

    private handleItemPropertyChanged(parentKeyPath: string[], itemKey: string, newValue: unknown): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);

        const existingHeap = this.heaps.get(parentKeyHash);
        if (existingHeap) {
            existingHeap.removeById(itemKey);
            this.removeHeapIfEmpty(parentKeyHash);
        }

        const newNumericValue = parseNumericValue(newValue);
        if (newNumericValue !== undefined) {
            this.getOrCreateHeap(parentKeyHash).insert(newNumericValue, itemKey);
        }

        this.emitModification(parentKeyPath);
    }

    private emitModification(parentKeyPath: string[]): void {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const oldAggregate = this.lastEmitted.get(parentKeyHash);
        const newAggregate = this.heaps.get(parentKeyHash)?.peek()?.value;

        if (newAggregate === undefined) {
            this.lastEmitted.delete(parentKeyHash);
        } else {
            this.lastEmitted.set(parentKeyHash, newAggregate);
        }

        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            this.modifiedHandlers.forEach(handler => {
                handler(keyPathToParent, parentKey, oldAggregate, newAggregate);
            });
            return;
        }

        this.modifiedHandlers.forEach(handler => {
            handler([], '', oldAggregate, newAggregate);
        });
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
        return getDescriptorFromFactory(
            this.upstream.getTypeDescriptor(),
            input => new MinMaxAggregateStep(input, this.segmentPath, this.propertyName, this.numericProperty, this.comparator)
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new MinMaxAggregateStep(up.lastStep, this.segmentPath, this.propertyName, this.numericProperty, this.comparator)
        };
    }
}
