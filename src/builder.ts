import {
    getPathSegmentsFromDescriptor,
    type DescriptorNode,
    type ImmutableProps,
    type Pipeline,
    type PipelineInput,
    type PipelineSources,
    type PipelineRuntimeDiagnostic,
    type PipelineRuntimeDisposeOptions,
    type PipelineRuntimeOptions,
    type StepBuilder,
    type TypeDescriptor
} from './pipeline.js';
import { type AddOperator, type SubtractOperator } from './steps/commutative-aggregate.js';
import { NavigateToPath, TransformAtPath } from './types/path.js';
import {
    AverageAggregateBuilder,
    CommutativeAggregateBuilder,
    CumulativeSumBuilder,
    DefinePropertyBuilder,
    DropPropertyBuilder,
    EnrichBuilder,
    FilterBuilder,
    FlattenBuilder,
    GroupByBuilder,
    MinMaxAggregateBuilder,
    PickByMinMaxBuilder,
    ReplaceToDeltaBuilder,
    buildStepGraph
} from './step-builders.js';

// Public types
export type KeyedArray<T> = { key: string, value: T }[];
export type Transform<T> = (state: T) => T;

/**
 * Recursively replaces each {@link KeyedArray} with a plain array of the item type.
 * Use {@link PipelinePlainOutput} to apply this to a builder; see also {@link PipelineOutput}.
 *
 * Ordinary arrays/tuples (not {@link KeyedArray}) recurse element-wise only so we do not map
 * them as objects (which would turn e.g. `string[]` into a `{ length; [n]: ... }` shape).
 */
type KeyedRecursivePlain<T> =
    T extends KeyedArray<infer U>
        ? KeyedRecursivePlain<U>[]
        : T extends readonly (infer U)[]
            ? readonly KeyedRecursivePlain<U>[]
            : T extends object
                ? {
                      [K in keyof T]: T[K] extends KeyedArray<infer V>
                          ? KeyedRecursivePlain<V>[]
                          : KeyedRecursivePlain<T[K]>
                  }
                : T;

/**
 * Root item shape produced by a pipeline: the `T` in `KeyedArray<T>` passed to `.build(setState)`.
 * Nested groups and aggregates appear as {@link KeyedArray} properties in this shape.
 *
 * @example
 * const builder = createPipeline<{ category: string; value: number }>().groupBy(['category'], 'items');
 * type Row = PipelineOutput<typeof builder>;
 */
export type PipelineOutput<TBuilder> =
    TBuilder extends PipelineBuilder<infer T, infer _S, infer _Path, infer _Root, infer _Sources> ? T : never;

type PreserveStringLiterals<T extends readonly string[]> = T;

/**
 * Property type after {@link PipelineBuilder.enrich}: omitting `whenMissing` (or passing
 * `undefined`) allows `undefined` when there is no matching secondary row; passing a `TSecondary`
 * object uses that value whenever unmatched.
 */
export type EnrichedAs<TSecondary extends object, TWhenMissing extends TSecondary | undefined> = [
    TWhenMissing
] extends [undefined]
    ? TSecondary | undefined
    : TSecondary;

/**
 * Same structure as {@link PipelineOutput} but with every {@link KeyedArray} replaced by a plain array.
 * Useful for snapshot tests and for UI models that use arrays instead of keyed rows.
 */
export type PipelinePlainOutput<TBuilder> = KeyedRecursivePlain<PipelineOutput<TBuilder>>;

/**
 * Plain row shape for a given pipeline output row type `T` (the same mapping as {@link PipelinePlainOutput}
 * applied to {@link PipelineOutput}). Used as the return type of {@link toPipelinePlainOutput}.
 */
export type PipelinePlainOutputShape<T> = KeyedRecursivePlain<T>;

/** Cell value contribution for sum: null/undefined → 0; finite numbers → value; NaN/Infinity/non-numeric → 0. */
function finiteNumericContribution(value: unknown): number {
    if (value === null || value === undefined) {
        return 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function getArrayItemDescriptorAtPath(descriptor: TypeDescriptor, segmentPath: string[]): DescriptorNode | undefined {
    let current: DescriptorNode = descriptor;
    for (const segment of segmentPath) {
        const nextArray = current.arrays.find(array => array.name === segment);
        if (!nextArray) {
            return undefined;
        }
        current = nextArray.type;
    }
    return current;
}

function assertCumulativeSumConfiguration(
    descriptor: TypeDescriptor,
    segmentPath: string[],
    orderBy: readonly string[],
    properties: readonly string[]
): void {
    const itemDescriptor = getArrayItemDescriptorAtPath(descriptor, segmentPath);
    if (!itemDescriptor) {
        throw new Error(`cumulativeSum validation error: array path "${segmentPath.join('.')}" not found in current scope`);
    }
    if (orderBy.length === 0) {
        throw new Error('cumulativeSum validation error: orderBy must include at least one scalar property');
    }
    if (properties.length === 0) {
        throw new Error('cumulativeSum validation error: properties must include at least one mutable scalar property');
    }

    const scalarNames = new Set(itemDescriptor.scalars.map(scalar => scalar.name));
    orderBy.forEach(propertyName => {
        if (!scalarNames.has(propertyName)) {
            throw new Error(`cumulativeSum validation error: orderBy property "${propertyName}" is not a scalar on the target array item type`);
        }
    });

    const mutableProperties = new Set(descriptor.mutableProperties);
    properties.forEach(propertyName => {
        if (!scalarNames.has(propertyName)) {
            throw new Error(`cumulativeSum validation error: property "${propertyName}" is not a scalar on the target array item type`);
        }
        if (!mutableProperties.has(propertyName)) {
            throw new Error(`cumulativeSum validation error: property "${propertyName}" must be mutable`);
        }
    });
}

type PendingOperation =
    | { type: 'add', epoch: number, segmentPath: string[], keyPath: string[], key: string, immutableProps: ImmutableProps }
    | { type: 'remove', epoch: number, segmentPath: string[], keyPath: string[], key: string }
    | { type: 'modify', epoch: number, segmentPath: string[], keyPath: string[], key: string, name: string, value: unknown };

interface RuntimeApplyContext {
    epoch: number;
    emitDiagnostic: (diagnostic: PipelineRuntimeDiagnostic) => void;
}

class PipelineRuntimeSessionImpl<TState extends object, TStart, TSources extends Record<string, unknown> = Record<never, never>>
    implements Pipeline<TStart, TSources> {
    private readonly setState: (transform: Transform<KeyedArray<TState>>) => void;
    private readonly inputPipeline: PipelineInput<TStart, TSources>;
    readonly sources: PipelineSources<TSources>;
    private readonly runtimeOptions: Required<Pick<PipelineRuntimeOptions, 'batchSize' | 'flushDelayMs'>> &
        Pick<PipelineRuntimeOptions, 'onDiagnostic'>;
    private pendingOperations: PendingOperation[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private epoch = 1;

    constructor(
        pipeline: PipelineInput<TStart, TSources>,
        setState: (transform: Transform<KeyedArray<TState>>) => void,
        runtimeOptions: PipelineRuntimeOptions
    ) {
        this.inputPipeline = pipeline;
        this.sources = pipeline.sources;
        this.setState = setState;
        this.runtimeOptions = {
            batchSize: runtimeOptions.batchSize ?? 50,
            flushDelayMs: runtimeOptions.flushDelayMs ?? 16,
            onDiagnostic: runtimeOptions.onDiagnostic
        };
    }

    add(key: string, immutableProps: TStart): void {
        const operationEpoch = this.epoch;
        if (this.closed) {
            this.emitDiagnostic({
                code: 'operation_after_dispose',
                message: 'Dropping operation because the runtime session has been disposed.',
                operationType: 'add',
                key,
                epoch: operationEpoch
            });
            return;
        }

        if (operationEpoch !== this.epoch) {
            this.emitDiagnostic({
                code: 'stale_epoch_operation_dropped',
                message: 'Dropping stale operation from a previous runtime epoch.',
                operationType: 'add',
                key,
                epoch: operationEpoch
            });
            return;
        }

        this.inputPipeline.add(key, immutableProps);
    }

    remove(key: string, immutableProps: TStart): void {
        const operationEpoch = this.epoch;
        if (this.closed) {
            this.emitDiagnostic({
                code: 'operation_after_dispose',
                message: 'Dropping operation because the runtime session has been disposed.',
                operationType: 'remove',
                key,
                epoch: operationEpoch
            });
            return;
        }

        if (operationEpoch !== this.epoch) {
            this.emitDiagnostic({
                code: 'stale_epoch_operation_dropped',
                message: 'Dropping stale operation from a previous runtime epoch.',
                operationType: 'remove',
                key,
                epoch: operationEpoch
            });
            return;
        }

        this.inputPipeline.remove(key, immutableProps);
    }

    enqueueAdd(segmentPath: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        this.enqueueOperation({ type: 'add', epoch: this.epoch, segmentPath, keyPath, key, immutableProps });
    }

    enqueueRemove(segmentPath: string[], keyPath: string[], key: string): void {
        this.enqueueOperation({ type: 'remove', epoch: this.epoch, segmentPath, keyPath, key });
    }

    enqueueModify(segmentPath: string[], keyPath: string[], key: string, name: string, value: unknown): void {
        this.enqueueOperation({ type: 'modify', epoch: this.epoch, segmentPath, keyPath, key, name, value });
    }

    flush(): void {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.pendingOperations.length === 0 || this.closed) {
            return;
        }

        const operationsToApply = this.pendingOperations;
        this.pendingOperations = [];

        this.setState(state => {
            let result = state;

            for (const op of operationsToApply) {
                if (!this.shouldAcceptOperation(op)) {
                    continue;
                }

                const applyContext: RuntimeApplyContext = {
                    emitDiagnostic: diagnostic => this.emitDiagnostic(diagnostic),
                    epoch: op.epoch
                };

                switch (op.type) {
                    case 'add':
                        result = addToKeyedArray(result, op.segmentPath, op.keyPath, op.key, op.immutableProps, undefined, applyContext);
                        break;
                    case 'remove':
                        result = removeFromKeyedArray(result, op.segmentPath, op.keyPath, op.key, undefined, applyContext);
                        break;
                    case 'modify':
                        result = modifyInKeyedArray(result, op.segmentPath, op.keyPath, op.key, op.name, op.value, undefined, applyContext);
                        break;
                }
            }
            return result;
        });
    }

    dispose(options: PipelineRuntimeDisposeOptions = {}): void {
        if (this.closed) {
            return;
        }

        if (options.flush) {
            this.flush();
        }

        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        this.pendingOperations = [];
        this.closed = true;
        this.epoch += 1;
    }

    isDisposed(): boolean {
        return this.closed;
    }

    private enqueueOperation(operation: PendingOperation): void {
        if (!this.shouldAcceptOperation(operation)) {
            return;
        }

        this.pendingOperations.push(operation);
        this.scheduleFlush();
    }

    private shouldAcceptOperation(operation: PendingOperation): boolean {
        if (this.closed) {
            this.emitDiagnostic({
                code: 'operation_after_dispose',
                message: 'Dropping operation because the runtime session has been disposed.',
                operationType: operation.type,
                segmentPath: operation.segmentPath,
                keyPath: operation.keyPath,
                key: operation.key,
                epoch: operation.epoch
            });
            return false;
        }

        if (operation.epoch !== this.epoch) {
            this.emitDiagnostic({
                code: 'stale_epoch_operation_dropped',
                message: 'Dropping stale operation from a previous runtime epoch.',
                operationType: operation.type,
                segmentPath: operation.segmentPath,
                keyPath: operation.keyPath,
                key: operation.key,
                epoch: operation.epoch
            });
            return false;
        }

        return true;
    }

    private scheduleFlush(): void {
        if (this.pendingOperations.length >= this.runtimeOptions.batchSize) {
            this.flush();
            return;
        }

        if (this.flushTimer === null) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush();
            }, this.runtimeOptions.flushDelayMs);
        }
    }

    private emitDiagnostic(diagnostic: PipelineRuntimeDiagnostic): void {
        if (this.runtimeOptions.onDiagnostic) {
            this.runtimeOptions.onDiagnostic(diagnostic);
            return;
        }
        console.warn(`Warning: ${diagnostic.message}`);
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

type ArrayPropertyNameOn<T> = {
    [K in keyof T]-?: T[K] extends KeyedArray<unknown> ? K : never
}[keyof T] & string;

type ArrayItemAtPropertyOn<
    T,
    ArrayName extends ArrayPropertyNameOn<T>
> = T[ArrayName] extends KeyedArray<infer ItemType>
    ? ItemType
    : never;

type AddNumericProperties<
    T,
    OutputProps extends readonly string[]
> = Expand<T & Record<OutputProps[number], number>>;

type ReplaceToDeltaAtScope<
    TScope,
    EntityArrayName extends string,
    EventArrayName extends string,
    OutputProps extends readonly string[]
> = EntityArrayName extends keyof TScope
    ? TScope[EntityArrayName] extends KeyedArray<infer EntityItem>
        ? Expand<Omit<TScope, EntityArrayName> & {
            [K in EntityArrayName]: KeyedArray<
                EventArrayName extends keyof EntityItem
                    ? EntityItem[EventArrayName] extends KeyedArray<infer EventItem>
                        ? Expand<Omit<EntityItem, EventArrayName> & {
                            [E in EventArrayName]: KeyedArray<AddNumericProperties<EventItem, OutputProps>>
                        }>
                        : EntityItem
                    : EntityItem
            >
        }>
        : TScope
    : TScope;

type ArrayPropertyName<T> = {
    [K in keyof T]-?: T[K] extends KeyedArray<unknown> ? K : never
}[keyof T] & string;

type ParentNonArrayProps<ParentItem> = {
    [K in keyof ParentItem as ParentItem[K] extends KeyedArray<unknown> ? never : K]: ParentItem[K]
};

type FlattenMergedItem<ParentItem, ChildArrayName extends string> =
    ChildArrayName extends keyof ParentItem
        ? ParentItem[ChildArrayName] extends KeyedArray<infer ChildItem>
            ? Expand<Omit<ParentNonArrayProps<ParentItem>, keyof ChildItem> & ChildItem>
            : never
        : never;

type TransformWithFlatten<
    T,
    Path extends string[],
    ParentArrayName extends string,
    OutputArrayName extends string,
    FlattenedItem
> = Path extends []
    ? Expand<Omit<T, ParentArrayName> & Record<OutputArrayName, KeyedArray<FlattenedItem>>>
    : Expand<
          TransformAtPath<
              T,
              Path,
              Expand<
                  Omit<NavigateToPath<T, Path>, ParentArrayName> &
                  Record<OutputArrayName, KeyedArray<FlattenedItem>>
              >
          >
      >;

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

type DeferredDiagnosticBridge = {
    emit?: (diagnostic: PipelineRuntimeDiagnostic) => void;
    pending: PipelineRuntimeDiagnostic[];
};

function createDeferredDiagnosticBridge(): DeferredDiagnosticBridge {
    return {
        pending: []
    };
}

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

export class PipelineBuilder<
    T extends object,
    TStart,
    Path extends string[] = [],
    RootScopeName extends string = 'items',
    TSources extends Record<string, unknown> = Record<never, never>
> {
    constructor(
        private rootBuilder: StepBuilder,
        private lastBuilder: StepBuilder,
        private scopeSegments: Path = [] as unknown as Path,
        private diagnosticBridge: DeferredDiagnosticBridge = createDeferredDiagnosticBridge()
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
        RootScopeName,
        TSources
    > {
        const newBuilder = new DefinePropertyBuilder(
            this.lastBuilder,
            propertyName,
            compute as (item: unknown) => U,
            this.scopeSegments as string[],
            mutableProperties
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
    }

    dropProperty<K extends keyof NavigateToPath<T, Path>>(propertyName: K): PipelineBuilder<
        Path extends []
            ? Expand<Omit<T, K>>
            : Expand<TransformAtPath<T, Path, Expand<Omit<NavigateToPath<T, Path>, K>>>>,
        TStart,
        Path,
        RootScopeName,
        TSources
    > {
        const newBuilder = new DropPropertyBuilder(
            this.lastBuilder,
            propertyName as string,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
        Path extends [] ? ArrayName : RootScopeName,
        TSources
    > {
        const descriptor = this.lastBuilder.getTypeDescriptor();
        const inferredChildArrayName = this.scopeSegments.length > 0
            ? this.scopeSegments[this.scopeSegments.length - 1]
            : descriptor.rootCollectionName;

        const newBuilder = new GroupByBuilder(
            this.lastBuilder,
            groupingProperties as string[],
            arrayName,
            inferredChildArrayName,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
    }

    flatten<
        ParentArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        ParentItem extends ArrayItemAtCurrentPath<T, Path, ParentArrayName> = ArrayItemAtCurrentPath<T, Path, ParentArrayName>,
        ChildArrayName extends ArrayPropertyName<ParentItem> = ArrayPropertyName<ParentItem>,
        OutputArrayName extends string = string,
        FlattenedItem extends FlattenMergedItem<ParentItem, ChildArrayName> = FlattenMergedItem<ParentItem, ChildArrayName>
    >(
        parentArrayName: ParentArrayName,
        childArrayName: ChildArrayName,
        outputArrayName: OutputArrayName &
            (OutputArrayName extends keyof NavigateToPath<T, Path> ? never : unknown)
    ): PipelineBuilder<
        TransformWithFlatten<T, Path, ParentArrayName, OutputArrayName, FlattenedItem>,
        TStart,
        Path,
        RootScopeName,
        TSources
    > {
        const parentPath = [...this.scopeSegments, parentArrayName];
        const childPath = [...parentPath, childArrayName];
        const outputPath = [...this.scopeSegments, outputArrayName];
        const newBuilder = new FlattenBuilder(this.lastBuilder, parentPath, childPath, outputPath);
        // Preserve definition-time validation semantics for invalid flatten configurations.
        newBuilder.getTypeDescriptor();
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
        RootScopeName,
        TSources
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newBuilder = new CommutativeAggregateBuilder(
            this.lastBuilder,
            fullSegmentPath,
            propertyName,
            {
                add: add as AddOperator<ImmutableProps, TAggregate>,
                subtract: subtract as SubtractOperator<ImmutableProps, TAggregate>
            },
            propertyToAggregate
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
    }

    cumulativeSum<
        ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        TOrderBy extends keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string,
        TProperty extends keyof ArrayItemAtCurrentPath<T, Path, ArrayName> & string
    >(
        arrayName: ArrayName,
        orderBy: readonly TOrderBy[],
        properties: readonly TProperty[]
    ): PipelineBuilder<T, TStart, Path, RootScopeName, TSources> {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const inputDescriptor = this.lastBuilder.getTypeDescriptor();
        assertCumulativeSumConfiguration(inputDescriptor, fullSegmentPath, orderBy, properties);

        const newBuilder = new CumulativeSumBuilder(
            this.lastBuilder,
            fullSegmentPath,
            [...orderBy],
            [...properties]
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, this.scopeSegments, this.diagnosticBridge);
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
        RootScopeName,
        TSources
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
        RootScopeName,
        TSources
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
        RootScopeName,
        TSources
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newBuilder = new MinMaxAggregateBuilder(
            this.lastBuilder,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (left, right) => left - right
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
        RootScopeName,
        TSources
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newBuilder = new MinMaxAggregateBuilder(
            this.lastBuilder,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (left, right) => right - left
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
    }

    replaceToDelta<
        EntityArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
        EventArrayName extends ArrayPropertyNameOn<ArrayItemAtCurrentPath<T, Path, EntityArrayName>>,
        EventItem extends ArrayItemAtPropertyOn<ArrayItemAtCurrentPath<T, Path, EntityArrayName>, EventArrayName>,
        OutputProps extends readonly string[]
    >(
        entityArrayName: EntityArrayName,
        eventArrayName: EventArrayName,
        orderBy: readonly (keyof EventItem & string)[],
        properties: readonly (keyof EventItem & string)[],
        outputProperties: OutputProps
    ): PipelineBuilder<
        Path extends []
            ? ReplaceToDeltaAtScope<T, EntityArrayName, EventArrayName, OutputProps>
            : Expand<
                TransformAtPath<
                    T,
                    Path,
                    ReplaceToDeltaAtScope<
                        NavigateToPath<T, Path>,
                        EntityArrayName,
                        EventArrayName,
                        OutputProps
                    >
                >
            >,
        TStart,
        Path,
        RootScopeName,
        TSources
    > {
        const fullEntitySegmentPath = [...this.scopeSegments, entityArrayName];
        const newBuilder = new ReplaceToDeltaBuilder(
            this.lastBuilder,
            fullEntitySegmentPath,
            eventArrayName,
            [...orderBy],
            [...properties],
            [...outputProperties]
        );
        // Preserve definition-time validation semantics for invalid replaceToDelta configuration.
        newBuilder.getTypeDescriptor();
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
        RootScopeName,
        TSources
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newBuilder = new AverageAggregateBuilder(
            this.lastBuilder,
            fullSegmentPath,
            outputProperty,
            propertyName
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
        RootScopeName,
        TSources
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newBuilder = new PickByMinMaxBuilder(
            this.lastBuilder,
            fullSegmentPath,
            outputProperty,
            propertyName,
            compareMixedPrimitiveValues
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
        RootScopeName,
        TSources
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newBuilder = new PickByMinMaxBuilder(
            this.lastBuilder,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (left, right) => compareMixedPrimitiveValues(right, left)
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
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
    ): PipelineBuilder<T, TStart, [...Path, ...NewPath], RootScopeName, TSources> {
        return new PipelineBuilder<T, TStart, [...Path, ...NewPath], RootScopeName, TSources>(
            this.rootBuilder,
            this.lastBuilder,
            [...this.scopeSegments, ...pathSegments] as [...Path, ...NewPath],
            this.diagnosticBridge
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
    ): PipelineBuilder<T, TStart, Path, RootScopeName, TSources> {
        const newBuilder = new FilterBuilder(
            this.lastBuilder,
            predicate as (item: unknown) => boolean,
            this.scopeSegments as string[],
            mutableProperties
        );
        return new PipelineBuilder(this.rootBuilder, newBuilder, this.scopeSegments, this.diagnosticBridge);
    }

    enrich<
        TSourceName extends string,
        TSecondary extends object,
        TSecondaryStart extends object,
        TSecondaryRootScopeName extends string,
        TSecondarySources extends Record<string, unknown>,
        TPrimaryKey extends keyof NavigateToPath<T, Path> & string,
        TAs extends string,
        TWhenMissing extends TSecondary | undefined = undefined
    >(
        sourceName: TSourceName,
        secondaryPipeline: PipelineBuilder<TSecondary, TSecondaryStart, [], TSecondaryRootScopeName, TSecondarySources>,
        primaryKey: PreserveStringLiterals<readonly TPrimaryKey[]>,
        as: TAs,
        whenMissing?: TWhenMissing
    ): PipelineBuilder<
        Path extends []
            ? Expand<T & Record<TAs, EnrichedAs<TSecondary, TWhenMissing>>>
            : Expand<
                  TransformAtPath<
                      T,
                      Path,
                      NavigateToPath<T, Path> & Record<TAs, EnrichedAs<TSecondary, TWhenMissing>>
                  >
              >,
        TStart,
        Path,
        RootScopeName,
        TSources & Record<TSourceName, { primary: TSecondaryStart; sources: TSecondarySources }>
    > {
        type NewSources = TSources & Record<TSourceName, { primary: TSecondaryStart; sources: TSecondarySources }>;
        const newBuilder = new EnrichBuilder(
            this.lastBuilder,
            sourceName,
            secondaryPipeline.lastBuilder,
            this.scopeSegments as string[],
            [...primaryKey],
            as,
            whenMissing as ImmutableProps | undefined
        );

        return new PipelineBuilder<
            Path extends []
                ? Expand<T & Record<TAs, EnrichedAs<TSecondary, TWhenMissing>>>
                : Expand<
                      TransformAtPath<
                          T,
                          Path,
                          NavigateToPath<T, Path> & Record<TAs, EnrichedAs<TSecondary, TWhenMissing>>
                      >
                  >,
            TStart,
            Path,
            RootScopeName,
            NewSources
        >(this.rootBuilder, newBuilder, this.scopeSegments, this.diagnosticBridge);
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.lastBuilder.getTypeDescriptor();
    }

    /**
     * Build an isolated runtime session for this pipeline.
     * The session owns batching, flush, and dispose lifecycle behavior.
     */
    build(
        setState: (transform: Transform<KeyedArray<T>>) => void,
        runtimeOptions: PipelineRuntimeOptions = {}
    ): Pipeline<TStart, TSources> {
        this.diagnosticBridge.emit = diagnostic => {
            if (runtimeOptions.onDiagnostic) {
                runtimeOptions.onDiagnostic(diagnostic);
                return;
            }
            console.warn(`Warning: ${diagnostic.message}`);
        };
        if (this.diagnosticBridge.pending.length > 0) {
            for (const diagnostic of this.diagnosticBridge.pending) {
                this.diagnosticBridge.emit(diagnostic);
            }
            this.diagnosticBridge.pending = [];
        }

        const builtGraph = buildStepGraph(this.lastBuilder, diagnostic => {
            if (this.diagnosticBridge.emit) {
                this.diagnosticBridge.emit({
                    ...diagnostic,
                    operationType: 'modify'
                });
                return;
            }
            this.diagnosticBridge.pending.push({
                ...diagnostic,
                operationType: 'modify'
            });
        });
        const runtimeDescriptor = builtGraph.lastStep.getTypeDescriptor();
        const pathSegments = getPathSegmentsFromDescriptor(runtimeDescriptor);
        const session = new PipelineRuntimeSessionImpl<T, TStart, TSources>(
            builtGraph.rootInput as PipelineInput<TStart, TSources>,
            setState,
            runtimeOptions
        );

        // Register handlers for each path the step will emit
        pathSegments.forEach(segmentPath => {
            builtGraph.lastStep.onAdded(segmentPath, (keyPath, key, immutableProps) => {
                session.enqueueAdd(segmentPath, keyPath, key, immutableProps);
            });
            
            builtGraph.lastStep.onRemoved(segmentPath, (keyPath, key, _immutableProps) => {
                session.enqueueRemove(segmentPath, keyPath, key);
            });
            
            // Register for mutable properties
            // Collect all mutable properties from the entire type descriptor tree
            // This handles cases where aggregates add mutable properties at root level
            // even when they semantically belong at nested levels
            const mutableProperties = collectAllMutableProperties(runtimeDescriptor);
            
            if (mutableProperties.length > 0) {
                // Register for each mutable property at this path level
                // Note: Aggregates emit modifications at the parent level of their array,
                // so we register at both the current path and parent paths
                mutableProperties.forEach(propertyName => {
                    // Register at current path level
                    builtGraph.lastStep.onModified(segmentPath, propertyName, (keyPath, key, _oldValue, newValue) => {
                        session.enqueueModify(segmentPath, keyPath, key, propertyName, newValue);
                    });
                    
                    // Also register at parent level (for aggregates that emit at parent level)
                    if (segmentPath.length > 0) {
                        const parentPath = segmentPath.slice(0, -1);
                        builtGraph.lastStep.onModified(parentPath, propertyName, (keyPath, key, _oldValue, newValue) => {
                            session.enqueueModify(parentPath, keyPath, key, propertyName, newValue);
                        });
                    }
                });
            }
            // If no mutable properties, modifications won't be tracked (this is expected for immutable-only pipelines)
        });

        return session;
    }
}

/**
 * Collects all mutable properties from the entire type descriptor tree.
 * Returns a flat array of all mutable property names found at any level.
 */
function collectAllMutableProperties(descriptor: DescriptorNode): string[] {
    const mutableProps = new Set<string>();
    
    // Add mutable properties at this level
    for (const prop of descriptor.mutableProperties) {
        mutableProps.add(prop);
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

function addToKeyedArray<T>(
    state: KeyedArray<T>,
    segmentPath: string[],
    keyPath: string[],
    key: string,
    immutableProps: ImmutableProps,
    keyToIndexMap?: Map<string, number>,
    runtimeApplyContext?: RuntimeApplyContext
): KeyedArray<T> {
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
            runtimeApplyContext?.emitDiagnostic({
                code: 'missing_parent_add_dropped',
                message: `Attempted to add key "${key}" at segment path [${segmentPath.join(".")}] with parent key "${parentKey}", but parent was not found in state. Operation dropped.`,
                operationType: 'add',
                segmentPath,
                keyPath,
                key,
                parentKey,
                epoch: runtimeApplyContext?.epoch
            });
            return state;
        }
        const existingItem = state[existingItemIndex];
        // Dynamic property access: segment is used as a property key at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const value = existingItem.value as Record<string, any>;
        const existingArray = (value[segment] as KeyedArray<unknown>) || [];
        const modifiedArray = addToKeyedArray(
            existingArray,
            segmentPath.slice(1),
            keyPath.slice(1),
            key,
            immutableProps,
            undefined,
            runtimeApplyContext
        );
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

function removeFromKeyedArray<T>(
    state: KeyedArray<T>,
    segmentPath: string[],
    keyPath: string[],
    key: string,
    keyToIndexMap?: Map<string, number>,
    runtimeApplyContext?: RuntimeApplyContext
): KeyedArray<T> {
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
            runtimeApplyContext?.emitDiagnostic({
                code: 'missing_parent_remove_dropped',
                message: `Attempted to remove key "${key}" at segment path [${segmentPath.join(".")}] with parent key "${parentKey}", but parent was not found in state. Operation dropped.`,
                operationType: 'remove',
                segmentPath,
                keyPath,
                key,
                parentKey,
                epoch: runtimeApplyContext?.epoch
            });
            return state;
        }
        const existingItem = state[existingItemIndex];
        // Dynamic property access: segment is used as a property key at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const value = existingItem.value as Record<string, any>;
        const existingArray = (value[segment] as KeyedArray<unknown>) || [];
        const modifiedArray = removeFromKeyedArray(
            existingArray,
            segmentPath.slice(1),
            keyPath.slice(1),
            key,
            undefined,
            runtimeApplyContext
        );
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

function modifyInKeyedArray<T>(
    state: KeyedArray<T>,
    segmentPath: string[],
    keyPath: string[],
    key: string,
    name: string,
    value: unknown,
    keyToIndexMap?: Map<string, number>,
    runtimeApplyContext?: RuntimeApplyContext
): KeyedArray<T> {
    if (segmentPath.length === 0) {
        if (keyPath.length !== 0) {
            throw new Error("Mismatched path length when modifying state");
        }
        
        // Use provided Map or create one for O(1) lookup
        // Note: Map creation is O(N), but batching reduces the number of state updates
        const keyToIndex = keyToIndexMap || createKeyToIndexMap(state);
        
        const existingItemIndex = keyToIndex.get(key);
        if (existingItemIndex === undefined) {
            runtimeApplyContext?.emitDiagnostic({
                code: 'missing_item_modify_dropped',
                message: `Attempted to modify missing item in KeyedArray. Key: ${key}, Path: [${segmentPath.join('.')}]`,
                operationType: 'modify',
                segmentPath,
                keyPath,
                key,
                epoch: runtimeApplyContext?.epoch
            });
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
            runtimeApplyContext?.emitDiagnostic({
                code: 'missing_parent_modify_dropped',
                message: `Parent item with key '${parentKey}' not found when modifying nested state at segment path [${segmentPath.join(".")}] and key path [${keyPath.join(".")}]. Modification dropped.`,
                operationType: 'modify',
                segmentPath,
                keyPath,
                key,
                parentKey,
                epoch: runtimeApplyContext?.epoch
            });
            return state;
        }
        const existingItem = state[existingItemIndex];
        // Dynamic property access: segment is used as a property key at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime hierarchical structure manipulation
        const existingValue = existingItem.value as Record<string, any>;
        const existingArray = (existingValue[segment] as KeyedArray<unknown>) || [];
        const modifiedArray = modifyInKeyedArray(
            existingArray,
            segmentPath.slice(1),
            keyPath.slice(1),
            key,
            name,
            value,
            undefined,
            runtimeApplyContext
        );
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

