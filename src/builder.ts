import { getPathSegmentsFromDescriptor, type DescriptorNode, type ImmutableProps, type Pipeline, type Step, type TypeDescriptor } from './pipeline.js';
import { CommutativeAggregateStep, type AddOperator, type SubtractOperator } from './steps/commutative-aggregate.js';
import { DefinePropertyStep } from './steps/define-property.js';
import { DropPropertyStep } from './steps/drop-property.js';
import { FilterStep } from './steps/filter.js';
import { GroupByStep } from './steps/group-by.js';
import { NavigateToPath, TransformAtPath } from './types/path.js';
import { MinMaxAggregateStep } from './steps/min-max-aggregate.js';
import { AverageAggregateStep } from './steps/average-aggregate.js';
import { PickByMinMaxStep } from './steps/pick-by-min-max.js';

// Public types (exported for use in build() signature)
export type KeyedArray<T> = { key: string, value: T }[];
export type Transform<T> = (state: T) => T;

/** Cell value contribution for sum: null/undefined → 0; finite numbers → value; NaN/Infinity/non-numeric → 0. */
function finiteNumericContribution(value: unknown): number {
    if (value === null || value === undefined) {
        return 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Type-safe storage for batched updaters associated with pipelines.
 * Uses WeakMap to avoid memory leaks and maintain type safety.
 */
const pipelineUpdaters = new WeakMap<Pipeline<unknown>, BatchedStateUpdater<unknown>>();

/**
 * Operation type for batched updates.
 */
type BatchedOperation = 
    | { type: 'add', segmentPath: string[], keyPath: string[], key: string, immutableProps: ImmutableProps }
    | { type: 'remove', segmentPath: string[], keyPath: string[], key: string }
    | { type: 'modify', segmentPath: string[], keyPath: string[], key: string, name: string, value: unknown };

/**
 * Batched state updater that collects multiple changes and applies them together.
 * This reduces O(N) operations by batching changes and using efficient data structures.
 * 
 * Operations are preserved in the order they were queued to maintain temporal dependencies.
 */
class BatchedStateUpdater<T> {
    private pendingOperations: BatchedOperation[] = [];
    private batchSize: number;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly flushDelayMs: number = 16; // ~60fps for UI updates

    constructor(
        private setState: (transform: Transform<KeyedArray<T>>) => void,
        batchSize: number = 50,
        flushDelayMs: number = 16
    ) {
        this.batchSize = batchSize;
        this.flushDelayMs = flushDelayMs;
    }

    add(segmentPath: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        this.pendingOperations.push({ type: 'add', segmentPath, keyPath, key, immutableProps });
        this.scheduleFlush();
    }

    remove(segmentPath: string[], keyPath: string[], key: string): void {
        this.pendingOperations.push({ type: 'remove', segmentPath, keyPath, key });
        this.scheduleFlush();
    }

    modify(segmentPath: string[], keyPath: string[], key: string, propertyName: string, newValue: unknown): void {
        this.pendingOperations.push({ type: 'modify', segmentPath, keyPath, key, name: propertyName, value: newValue });
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        // Flush immediately if batch size reached
        if (this.pendingOperations.length >= this.batchSize) {
            this.flush();
            return;
        }

        // Otherwise schedule a delayed flush
        if (this.flushTimer === null) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush();
            }, this.flushDelayMs);
        }
    }

    flush(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.pendingOperations.length === 0) {
            return;
        }

        // Apply all pending changes in a single state update, preserving order
        // This maintains temporal dependencies between operations
        this.setState(state => {
            let result = state;

            // Process operations in the order they were queued to preserve temporal dependencies
            // Note: Map creation for lookups is O(N) per operation, but batching reduces
            // the number of state updates from O(N) to O(N/batchSize), providing overall O(N) complexity
            for (const op of this.pendingOperations) {
                switch (op.type) {
                    case 'add':
                        result = addToKeyedArray(result, op.segmentPath, op.keyPath, op.key, op.immutableProps);
                        break;
                    case 'remove':
                        result = removeFromKeyedArray(result, op.segmentPath, op.keyPath, op.key);
                        break;
                    case 'modify':
                        result = modifyInKeyedArray(result, op.segmentPath, op.keyPath, op.key, op.name, op.value);
                        break;
                }
            }

            return result;
        });

        // Clear pending operations
        this.pendingOperations = [];
    }

    /**
     * Force immediate flush of all pending changes.
     * Useful when you need to ensure state is up-to-date (e.g., before reading results).
     */
    forceFlush(): void {
        this.flush();
    }

    /**
     * Dispose of this updater, cleaning up any pending timers.
     * Call this when the pipeline is no longer needed to prevent memory leaks.
     */
    dispose(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // Clear pending operations to allow garbage collection
        this.pendingOperations = [];
    }
}

// Type utility to expand intersection types into a single object type for better IDE display
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

// Type utilities for commutativeAggregate

type ArrayPropertyNameAtCurrentPath<T, Path extends string[]> = {
    [K in keyof NavigateToPath<T, Path>]-?:
        NavigateToPath<T, Path>[K] extends KeyedArray<unknown> ? K : never
}[keyof NavigateToPath<T, Path>] & string;

type ArrayItemAtCurrentPath<
    T,
    Path extends string[],
    ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>
> = NavigateToPath<T, Path>[ArrayName] extends KeyedArray<infer ItemType>
    ? ItemType
    : never;

/**
 * Replaces an array property with an aggregate property at a specific level.
 */
type ReplaceArrayWithAggregate<
    T,
    _ArrayName extends string,
    PropName extends string,
    TAggregate
> = Expand<T & Record<PropName, TAggregate>>;

/**
 * Transforms the output type by navigating to the parent level and
 * adding the aggregate property alongside the array (array is kept).
 */
type TransformWithAggregate<
    T,
    Path extends string[],
    PropName extends string,
    TAggregate
> = Path extends [infer ArrayName extends string]
    // Single-level path: replace directly in T
    ? ReplaceArrayWithAggregate<T, ArrayName, PropName, TAggregate>
    // Multi-level path: navigate and transform recursively
    : Path extends [infer First extends string, ...infer Rest extends string[]]
        ? First extends keyof T
            ? T[First] extends KeyedArray<infer ItemType>
                ? Expand<Omit<T, First> & {
                    [K in First]: KeyedArray<
                        TransformWithAggregate<ItemType, Rest & string[], PropName, TAggregate>
                    >
                }>
                : never
            : never
        : never;

type CurrentScopeName<Path extends string[], RootScopeName extends string> =
    Path extends [...infer _Rest extends string[], infer LastSegment extends string]
        ? LastSegment
        : RootScopeName;

function compareMixedPrimitiveValues(left: number | string, right: number | string): number {
    if (typeof left === 'number' && typeof right === 'number') {
        return left - right;
    }
    if (typeof left === 'string' && typeof right === 'string') {
        if (left < right) {
            return -1;
        }
        if (left > right) {
            return 1;
        }
        return 0;
    }

    const leftAsString = String(left);
    const rightAsString = String(right);
    if (leftAsString < rightAsString) {
        return -1;
    }
    if (leftAsString > rightAsString) {
        return 1;
    }
    return 0;
}

/**
 * Removes an array at the specified path from the type.
 */

export class PipelineBuilder<T extends object, TStart, Path extends string[] = [], RootScopeName extends string = 'items'> {
    constructor(
        private input: Pipeline<TStart>,
        private lastStep: Step,
        private scopeSegments: Path = [] as unknown as Path
    ) {}

    /**
     * Adds a computed property to each item at the current path.
     *
     * @param propertyName - The name for the new property
     * @param compute - Function that computes the property value from the item
     * @param mutableProperties - Properties that when changed should trigger recomputation.
     *   NOTE: Unlike aggregate methods (sum, count, min, max, average), defineProperty
     *   requires explicit mutableProperties because the dependencies cannot be automatically
     *   inferred from the compute function. The function is opaque - we can't know which
     *   properties it accesses without executing or analyzing it.
     *
     * @example
     * // Recompute 'status' when 'total' changes
     * .defineProperty('status', item => item.total > 100 ? 'Gold' : 'Bronze', ['total'])
     */
    defineProperty<K extends string, U>(propertyName: K, compute: (item: NavigateToPath<T, Path>) => U, mutableProperties: string[] = []): PipelineBuilder<
        Path extends []
            ? Expand<T & Record<K, U>>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<K, U>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const newStep = new DefinePropertyStep(
            this.lastStep,
            propertyName,
            compute as (item: unknown) => U,
            this.scopeSegments as string[],
            mutableProperties
        );
        return new PipelineBuilder(this.input, newStep);
    }

    dropProperty<K extends keyof NavigateToPath<T, Path>>(propertyName: K): PipelineBuilder<
        Path extends []
            ? Expand<Omit<T, K>>
            : Expand<TransformAtPath<T, Path, Expand<Omit<NavigateToPath<T, Path>, K>>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const newStep = new DropPropertyStep<NavigateToPath<T, Path>, K>(
            this.lastStep,
            propertyName,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.input, newStep);
    }

    groupBy<K extends keyof NavigateToPath<T, Path>, ArrayName extends string>(
        groupingProperties: K[],
        arrayName: ArrayName
    ): PipelineBuilder<
        Path extends []
            ? Expand<{ [P in K]: NavigateToPath<T, Path>[P] } & { [P in CurrentScopeName<Path, RootScopeName>]: KeyedArray<{ [Q in Exclude<keyof NavigateToPath<T, Path>, K>]: NavigateToPath<T, Path>[Q] }> }>
            : Expand<TransformAtPath<T, Path, { [P in K]: NavigateToPath<T, Path>[P] } & { [P in CurrentScopeName<Path, RootScopeName>]: KeyedArray<{ [Q in Exclude<keyof NavigateToPath<T, Path>, K>]: NavigateToPath<T, Path>[Q] }> }>>,
        TStart,
        Path,
        Path extends [] ? ArrayName : RootScopeName
    > {
        const descriptor = this.lastStep.getTypeDescriptor();
        const inferredChildArrayName = this.scopeSegments.length > 0
            ? this.scopeSegments[this.scopeSegments.length - 1]
            : descriptor.rootCollectionName;

        const newStep = new GroupByStep<NavigateToPath<T, Path> & {}, K, ArrayName, string>(
            this.lastStep,
            groupingProperties,
            arrayName,
            inferredChildArrayName,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.input, newStep);
    }

    /*
     * API Design Decision: Mutable Property Detection
     * ===============================================
     *
     * Aggregate methods (sum, count, min, max, average, pickByMin, pickByMax):
     *   - AUTO-DETECT mutableProperties from TypeDescriptor
     *   - The property being aggregated is explicitly passed (e.g., 'price' in sum)
     *   - We can check if that property is in TypeDescriptor.mutableProperties
     *   - User doesn't need to specify ['price'] - it's inferred
     *
     * Function-based methods (defineProperty, filter):
     *   - REQUIRE manual mutableProperties parameter
     *   - The compute/predicate function is opaque - we can't introspect which
     *     properties it accesses without static analysis or runtime tracking
     *   - User must explicitly declare dependencies
     *
     * This split provides the best developer experience while maintaining correctness:
     *   - Common case (aggregates): Zero-config, just works
     *   - Complex case (custom functions): Explicit but necessary
     */

    /**
     * Computes an aggregate value over items in a nested array.
     *
     * The aggregate is computed incrementally as items are added or removed.
     * The target array is replaced with the aggregate property in the output type.
     *
     * @param arrayName - Name of the array to aggregate
     * @param propertyName - Name of the new aggregate property
     * @param add - Operator called when an item is added
     * @param subtract - Operator called when an item is removed
     * @param propertyToAggregate - Optional property name for auto-detection of mutable properties
     *
     * @example
     * // Sum of values across all items for each category
     * .commutativeAggregate(
     *     'items',
     *     'total',
     *     (acc, item) => (acc ?? 0) + item.value,
     *     (acc, item) => acc - item.value
     * )
     *
     * @example
     * // Sum of capacity across all venues within cities (using in() for path prefix)
     * .in('cities').commutativeAggregate(
     *     'venues',
     *     'totalCapacity',
     *     (acc, venue) => (acc ?? 0) + venue.capacity,
     *     (acc, venue) => acc - venue.capacity
     * )
     */
    commutativeAggregate<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        PropName extends string,
        TAggregate
    >(
        arrayName: ArrayName,
        propertyName: PropName,
        add: AddOperator<ArrayItemAtCurrentPath<T, Path, ArrayName>, TAggregate>,
        subtract: SubtractOperator<ArrayItemAtCurrentPath<T, Path, ArrayName>, TAggregate>,
        propertyToAggregate?: string
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], PropName, TAggregate>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<PropName, TAggregate>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new CommutativeAggregateStep(
            this.lastStep,
            fullSegmentPath,
            propertyName,
            {
                add: add as AddOperator<ImmutableProps, TAggregate>,
                subtract: subtract as SubtractOperator<ImmutableProps, TAggregate>
            },
            propertyToAggregate
        );
        return new PipelineBuilder(this.input, newStep);
    }

    /**
     * Sums a numeric property over items in a nested array.
     * Handles null/undefined as 0, returns 0 for empty arrays.
     *
     * @param arrayName - Name of the array to sum
     * @param propertyName - Name of the numeric property to sum
     * @param outputProperty - Name of the new aggregate property
     *
     * @example
     * // Sum of prices across all items for each category
     * .sum('items', 'price', 'totalPrice')
     */
    sum<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number>>>,
        TStart,
        Path,
        RootScopeName
    > {
        return this.commutativeAggregate(
            arrayName,
            outputProperty,
            (acc: number | undefined, item: unknown) => {
                const value = (item as Record<string, unknown>)[propertyName];
                const numValue = finiteNumericContribution(value);
                return (acc ?? 0) + numValue;
            },
            (acc: number, item: unknown) => {
                const value = (item as Record<string, unknown>)[propertyName];
                const numValue = finiteNumericContribution(value);
                return acc - numValue;
            },
            propertyName  // Pass property name for auto-detection
        );
    }
    
    /**
     * Counts items in a nested array.
     * Returns 0 for empty arrays.
     *
     * @param arrayName - Name of the array to count
     * @param outputProperty - Name of the new aggregate property
     *
     * @example
     * // Count items for each category
     * .count('items', 'itemCount')
     */
    count<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number>>>,
        TStart,
        Path,
        RootScopeName
    > {
        return this.commutativeAggregate(
            arrayName,
            outputProperty,
            (acc: number | undefined, _item: unknown) => (acc ?? 0) + 1,
            (acc: number, _item: unknown) => acc - 1
        );
    }
    
    /**
     * Finds the minimum value of a property over items in a nested array.
     * Returns undefined for empty arrays, ignores null/undefined values.
     *
     * @param arrayName - Name of the array to find minimum in
     * @param propertyName - Name of the numeric property to find minimum of
     * @param outputProperty - Name of the new aggregate property
     *
     * @example
     * // Minimum price across all items for each category
     * .min('items', 'price', 'minPrice')
     */
    min<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number | undefined>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new MinMaxAggregateStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (left, right) => left - right
        );
        return new PipelineBuilder(this.input, newStep);
    }
    
    /**
     * Finds the maximum value of a property over items in a nested array.
     * Returns undefined for empty arrays, ignores null/undefined values.
     *
     * @param arrayName - Name of the array to find maximum in
     * @param propertyName - Name of the numeric property to find maximum of
     * @param outputProperty - Name of the new aggregate property
     *
     * @example
     * // Maximum price across all items for each category
     * .max('items', 'price', 'maxPrice')
     */
    max<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number | undefined>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new MinMaxAggregateStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (left, right) => right - left
        );
        return new PipelineBuilder(this.input, newStep);
    }
    
    /**
     * Computes the average of a numeric property over items in a nested array.
     * Returns undefined for empty arrays, excludes null/undefined from calculation.
     *
     * @param arrayName - Name of the array to average
     * @param propertyName - Name of the numeric property to average
     * @param outputProperty - Name of the new aggregate property
     *
     * @example
     * // Average price across all items for each category
     * .average('items', 'price', 'avgPrice')
     */
    average<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number | undefined>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new AverageAggregateStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName
        );
        return new PipelineBuilder(this.input, newStep);
    }
    
    /**
     * Picks the object with the minimum value of a property from a nested array.
     * Returns undefined for empty arrays, ignores null/undefined values.
     * Supports both numeric and string comparisons.
     *
     * @param arrayName - Name of the array to pick from
     * @param propertyName - Name of the property to minimize
     * @param outputProperty - Name of the new property containing the picked object
     *
     * @example
     * // Pick cheapest item for each category
     * .pickByMin('items', 'price', 'cheapestItem')
     */
    pickByMin<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, ArrayItemAtCurrentPath<T, Path, ArrayName> | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, ArrayItemAtCurrentPath<T, Path, ArrayName> | undefined>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new PickByMinMaxStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            compareMixedPrimitiveValues
        );
        return new PipelineBuilder(this.input, newStep);
    }
    
    /**
     * Picks the object with the maximum value of a property from a nested array.
     * Returns undefined for empty arrays, ignores null/undefined values.
     * Supports both numeric and string comparisons.
     *
     * @param arrayName - Name of the array to pick from
     * @param propertyName - Name of the property to maximize
     * @param outputProperty - Name of the new property containing the picked object
     *
     * @example
     * // Pick most expensive item for each category
     * .pickByMax('items', 'price', 'mostExpensiveItem')
     */
    pickByMax<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, ArrayItemAtCurrentPath<T, Path, ArrayName> | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, ArrayItemAtCurrentPath<T, Path, ArrayName> | undefined>>>,
        TStart,
        Path,
        RootScopeName
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new PickByMinMaxStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (left, right) => compareMixedPrimitiveValues(right, left)
        );
        return new PipelineBuilder(this.input, newStep);
    }
    
    /**
     * Creates a scoped builder that applies operations at the specified path depth.
     * Can be chained to append multiple path segments.
     *
     * @param pathSegments - Variadic path segments to navigate to
     * @returns A PipelineBuilder for operating at that depth
     */
    in<NewPath extends string[]>(
        ...pathSegments: NewPath
    ): PipelineBuilder<T, TStart, [...Path, ...NewPath], RootScopeName> {
        return new PipelineBuilder<T, TStart, [...Path, ...NewPath], RootScopeName>(
            this.input,
            this.lastStep,
            [...this.scopeSegments, ...pathSegments] as [...Path, ...NewPath]
        );
    }

    /**
     * Filters items in an array based on a predicate function.
     *
     * @param predicate - Function that returns true for items to keep
     * @param mutableProperties - Properties that when changed should re-evaluate the filter.
     *   NOTE: Unlike aggregate methods (sum, count, min, max, average), filter requires
     *   explicit mutableProperties because the dependencies cannot be automatically
     *   inferred from the predicate function. The function is opaque - we can't know
     *   which properties it accesses without executing or analyzing it.
     *
     * @example
     * // Re-filter when 'isActive' changes
     * .filter(item => item.isActive && item.count > 0, ['isActive', 'count'])
     */
    filter(
        predicate: (item: NavigateToPath<T, Path>) => boolean,
        mutableProperties: string[] = []
    ): PipelineBuilder<T, TStart, Path, RootScopeName> {
        const newStep = new FilterStep<NavigateToPath<T, Path>>(
            this.lastStep,
            predicate as (item: unknown) => boolean,
            this.scopeSegments as string[],
            mutableProperties
        );
        return new PipelineBuilder(this.input, newStep, this.scopeSegments);
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.lastStep.getTypeDescriptor();
    }

    build(setState: (transform: Transform<KeyedArray<T>>) => void, typeDescriptor: TypeDescriptor): Pipeline<TStart> {
        const pathSegments = getPathSegmentsFromDescriptor(typeDescriptor);
        
        // Create batched updater for efficient state updates
        // Batch size of 50 provides good balance between performance and responsiveness
        // Flush delay of 16ms (~60fps) ensures UI stays responsive
        const batchedUpdater = new BatchedStateUpdater<T>(setState, 50, 16);
        
        // Register handlers for each path the step will emit
        pathSegments.forEach(segmentPath => {
            this.lastStep.onAdded(segmentPath, (keyPath, key, immutableProps) => {
                batchedUpdater.add(segmentPath, keyPath, key, immutableProps);
            });
            
            this.lastStep.onRemoved(segmentPath, (keyPath, key, _immutableProps) => {
                batchedUpdater.remove(segmentPath, keyPath, key);
            });
            
            // Register for mutable properties
            // Collect all mutable properties from the entire type descriptor tree
            // This handles cases where aggregates add mutable properties at root level
            // even when they semantically belong at nested levels
            const mutableProperties = collectAllMutableProperties(typeDescriptor);
            
            if (mutableProperties.length > 0) {
                // Register for each mutable property at this path level
                // Note: Aggregates emit modifications at the parent level of their array,
                // so we register at both the current path and parent paths
                mutableProperties.forEach(propertyName => {
                    // Register at current path level
                    this.lastStep.onModified(segmentPath, propertyName, (keyPath, key, _oldValue, newValue) => {
                        batchedUpdater.modify(segmentPath, keyPath, key, propertyName, newValue);
                    });
                    
                    // Also register at parent level (for aggregates that emit at parent level)
                    if (segmentPath.length > 0) {
                        const parentPath = segmentPath.slice(0, -1);
                        this.lastStep.onModified(parentPath, propertyName, (keyPath, key, _oldValue, newValue) => {
                            batchedUpdater.modify(parentPath, keyPath, key, propertyName, newValue);
                        });
                    }
                });
            }
            // If no mutable properties, modifications won't be tracked (this is expected for immutable-only pipelines)
        });
        
        // Store the batched updater in WeakMap for type-safe access
        pipelineUpdaters.set(this.input, batchedUpdater as BatchedStateUpdater<unknown>);
        
        return this.input;
    }

    /**
     * Flushes any pending batched updates for a pipeline.
     * Call this before reading results to ensure state is up-to-date.
     */
    static flushBatchedUpdates(pipeline: Pipeline<unknown>): void {
        const batchedUpdater = pipelineUpdaters.get(pipeline);
        if (batchedUpdater) {
            batchedUpdater.forceFlush();
        }
    }

    /**
     * Disposes of the batched updater for a pipeline, cleaning up resources.
     * Call this when a pipeline is no longer needed to prevent memory leaks.
     */
    static disposeBatchedUpdates(pipeline: Pipeline<unknown>): void {
        const batchedUpdater = pipelineUpdaters.get(pipeline);
        if (batchedUpdater) {
            batchedUpdater.dispose();
            pipelineUpdaters.delete(pipeline);
        }
    }
}

/**
 * Collects all mutable properties from the entire type descriptor tree.
 * Returns a flat array of all mutable property names found at any level.
 */
function collectAllMutableProperties(descriptor: DescriptorNode): string[] {
    const mutableProps = new Set<string>();
    
    // Add mutable properties at this level
    if (descriptor.mutableProperties) {
        descriptor.mutableProperties.forEach(prop => mutableProps.add(prop));
    }
    
    // Recursively collect from nested arrays
    for (const arrayDesc of descriptor.arrays) {
        const nestedProps = collectAllMutableProperties(arrayDesc.type);
        nestedProps.forEach(prop => mutableProps.add(prop));
    }
    
    return Array.from(mutableProps);
}

/**
 * Creates a Map from keyed array for O(1) lookups.
 * This Map can be reused for multiple operations on the same array level.
 */
function createKeyToIndexMap<T>(state: KeyedArray<T>): Map<string, number> {
    const keyToIndex = new Map<string, number>();
    state.forEach((item, index) => keyToIndex.set(item.key, index));
    return keyToIndex;
}

function addToKeyedArray<T>(state: KeyedArray<T>, segmentPath: string[], keyPath: string[], key: string, immutableProps: ImmutableProps, keyToIndexMap?: Map<string, number>): KeyedArray<T> {
    if (segmentPath.length === 0) {
        if (keyPath.length !== 0) {
            throw new Error("Mismatched path length when setting state");
        }
        return [...state, { key, value: immutableProps as T }];
    }
    else {
        if (keyPath.length === 0) {
            throw new Error("Mismatched path length when setting state");
        }
        const parentKey = keyPath[0];
        const segment = segmentPath[0];
        
        // Use provided Map or create one for O(1) lookup
        // Note: Map creation is O(N), but batching reduces the number of state updates
        const keyToIndex = keyToIndexMap || createKeyToIndexMap(state);
        
        const existingItemIndex = keyToIndex.get(parentKey);
        if (existingItemIndex === undefined) {
            throw new Error("Path references unknown item when setting state");
        }
        const existingItem = state[existingItemIndex];
        // Dynamic property access: segment is used as a property key at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const value = existingItem.value as Record<string, any>;
        const existingArray = (value[segment] as KeyedArray<unknown>) || [];
        const modifiedArray = addToKeyedArray(existingArray, segmentPath.slice(1), keyPath.slice(1), key, immutableProps);
        const modifiedItem = {
            key: parentKey,
            value: {
                ...value,
                [segmentPath[0]]: modifiedArray
            } as T
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
}

function removeFromKeyedArray<T>(state: KeyedArray<T>, segmentPath: string[], keyPath: string[], key: string, keyToIndexMap?: Map<string, number>): KeyedArray<T> {
    if (segmentPath.length === 0) {
        if (keyPath.length !== 0) {
            throw new Error("Mismatched path length when removing from state");
        }
        return state.filter(item => item.key !== key);
    }
    else {
        if (keyPath.length === 0) {
            throw new Error("Mismatched path length when removing from state");
        }
        const parentKey = keyPath[0];
        const segment = segmentPath[0];
        
        // Use provided Map or create one for O(1) lookup
        // Note: Map creation is O(N), but batching reduces the number of state updates
        const keyToIndex = keyToIndexMap || createKeyToIndexMap(state);
        
        const existingItemIndex = keyToIndex.get(parentKey);
        if (existingItemIndex === undefined) {
            // Parent doesn't exist - item may have been removed already or never added
            // This can happen when batching operations, so we log a warning and skip
            console.warn(
                `Warning: Attempted to remove key "${key}" at segment path [${segmentPath.join(
                    "."
                )}] with parent key "${parentKey}", but parent was not found in state.`
            );
            return state;
        }
        const existingItem = state[existingItemIndex];
        // Dynamic property access: segment is used as a property key at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const value = existingItem.value as Record<string, any>;
        const existingArray = (value[segment] as KeyedArray<unknown>) || [];
        const modifiedArray = removeFromKeyedArray(existingArray, segmentPath.slice(1), keyPath.slice(1), key);
        const modifiedItem = {
            key: parentKey,
            value: {
                ...value,
                [segmentPath[0]]: modifiedArray
            } as T
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
}

function modifyInKeyedArray<T>(state: KeyedArray<T>, segmentPath: string[], keyPath: string[], key: string, name: string, value: unknown, keyToIndexMap?: Map<string, number>): KeyedArray<T> {
    if (segmentPath.length === 0) {
        if (keyPath.length !== 0) {
            throw new Error("Mismatched path length when modifying state");
        }
        
        // Use provided Map or create one for O(1) lookup
        // Note: Map creation is O(N), but batching reduces the number of state updates
        const keyToIndex = keyToIndexMap || createKeyToIndexMap(state);
        
        const existingItemIndex = keyToIndex.get(key);
        if (existingItemIndex === undefined) {
            // Item doesn't exist - may have been removed already or never added
            // This can happen when batching operations, so we log a warning and skip
            console.warn(
                `Warning: Attempted to modify missing item in KeyedArray. ` +
                `Key: ${key}, Path: [${segmentPath.join('.')}]`
            );
            return state;
        }
        const existingItem = state[existingItemIndex];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const existingValue = existingItem.value as Record<string, any>;
        const modifiedItem = {
            key: key,
            value: {
                ...existingValue,
                [name]: value
            } as T
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
    else {
        if (keyPath.length === 0) {
            throw new Error("Mismatched path length when modifying state");
        }
        const parentKey = keyPath[0];
        const segment = segmentPath[0];
        
        // Use provided Map or create one for O(1) lookup
        // Note: Map creation is O(N), but batching reduces the number of state updates
        const keyToIndex = keyToIndexMap || createKeyToIndexMap(state);
        
        const existingItemIndex = keyToIndex.get(parentKey);
        if (existingItemIndex === undefined) {
            // Parent doesn't exist - item may have been removed already or never added
            // This can happen when batching operations, so we log a warning and skip
            console.warn(
                `Warning: Parent item with key '${parentKey}' not found when modifying nested state at segment path [${segmentPath.join(
                    "."
                )}] and key path [${keyPath.join(".")}]. Modification skipped.`
            );
            return state;
        }
        const existingItem = state[existingItemIndex];
        // Dynamic property access: segment is used as a property key at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const existingValue = existingItem.value as Record<string, any>;
        const existingArray = (existingValue[segment] as KeyedArray<unknown>) || [];
        const modifiedArray = modifyInKeyedArray(existingArray, segmentPath.slice(1), keyPath.slice(1), key, name, value);
        const modifiedItem = {
            key: parentKey,
            value: {
                ...existingValue,
                [segmentPath[0]]: modifiedArray
            } as T
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
}

