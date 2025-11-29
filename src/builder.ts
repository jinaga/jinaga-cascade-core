import { getPathSegmentsFromDescriptor, type ImmutableProps, type Pipeline, type Step, type TypeDescriptor } from './pipeline';
import { CommutativeAggregateStep, type AddOperator, type SubtractOperator } from './steps/commutative-aggregate';
import { DefinePropertyStep } from './steps/define-property';
import { DropPropertyStep } from './steps/drop-property';
import { FilterStep } from './steps/filter';
import { GroupByStep } from './steps/group-by';
import { NavigateToPath, TransformAtPath } from './types/path';
import { MinMaxAggregateStep } from './steps/min-max-aggregate';
import { AverageAggregateStep } from './steps/average-aggregate';
import { PickByMinMaxStep } from './steps/pick-by-min-max';

// Public types (exported for use in build() signature)
export type KeyedArray<T> = { key: string, value: T }[];
export type Transform<T> = (state: T) => T;

// Type utility to expand intersection types into a single object type for better IDE display
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

// Type utilities for commutativeAggregate

/**
 * Navigates through a type following a path of array property names.
 * Returns the item type of the final array in the path.
 */
type NavigateToArrayItem<T, Path extends string[]> =
    Path extends [infer First extends string, ...infer Rest extends string[]]
        ? First extends keyof T
            ? T[First] extends KeyedArray<infer ItemType>
                ? Rest extends []
                    ? ItemType  // Reached the target array
                    : NavigateToArrayItem<ItemType, Rest>  // Continue navigating
                : never  // Property is not an array
            : never  // Property doesn't exist
        : never;  // Empty path

/**
 * Replaces an array property with an aggregate property at a specific level.
 */
type ReplaceArrayWithAggregate<
    T,
    ArrayName extends string,
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

/**
 * Removes an array at the specified path from the type.
 */

export class PipelineBuilder<T extends {}, TStart, Path extends string[] = []> {
    constructor(
        private input: Pipeline<TStart>,
        private lastStep: Step,
        private scopeSegments: Path = [] as unknown as Path
    ) {}

    defineProperty<K extends string, U>(propertyName: K, compute: (item: NavigateToPath<T, Path>) => U): PipelineBuilder<
        Path extends []
            ? Expand<T & Record<K, U>>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<K, U>>>,
        TStart
    > {
        const newStep = new DefinePropertyStep(
            this.lastStep,
            propertyName,
            compute as (item: unknown) => U,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.input, newStep) as any;
    }

    dropProperty<K extends keyof NavigateToPath<T, Path>>(propertyName: K): PipelineBuilder<
        Path extends []
            ? Expand<Omit<T, K>>
            : Expand<TransformAtPath<T, Path, Expand<Omit<NavigateToPath<T, Path>, K>>>>,
        TStart
    > {
        const newStep = new DropPropertyStep<NavigateToPath<T, Path>, K>(
            this.lastStep,
            propertyName,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.input, newStep) as any;
    }

    groupBy<K extends keyof NavigateToPath<T, Path>, ArrayName extends string>(
        groupingProperties: K[],
        arrayName: ArrayName
    ): PipelineBuilder<
        Path extends []
            ? Expand<{ [P in K]: NavigateToPath<T, Path>[P] } & { [P in ArrayName]: KeyedArray<{ [Q in Exclude<keyof NavigateToPath<T, Path>, K>]: NavigateToPath<T, Path>[Q] }> }>
            : Expand<TransformAtPath<T, Path, { [P in K]: NavigateToPath<T, Path>[P] } & { [P in ArrayName]: KeyedArray<{ [Q in Exclude<keyof NavigateToPath<T, Path>, K>]: NavigateToPath<T, Path>[Q] }> }>>,
        TStart
    > {
        const newStep = new GroupByStep<NavigateToPath<T, Path> & {}, K, ArrayName>(
            this.lastStep,
            groupingProperties as K[],
            arrayName,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.input, newStep) as any;
    }

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
        ArrayName extends string,
        PropName extends string,
        TAggregate
    >(
        arrayName: ArrayName,
        propertyName: PropName,
        add: AddOperator<NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]>, TAggregate>,
        subtract: SubtractOperator<NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]>, TAggregate>
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], PropName, TAggregate>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<PropName, TAggregate>>>,
        TStart
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new CommutativeAggregateStep(
            this.lastStep,
            fullSegmentPath,
            propertyName,
            { 
                add: add as AddOperator<ImmutableProps, any>, 
                subtract: subtract as SubtractOperator<ImmutableProps, any> 
            }
        );
        return new PipelineBuilder(this.input, newStep) as any;
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number>>>,
        TStart
    > {
        return this.commutativeAggregate(
            arrayName,
            outputProperty,
            (acc: number | undefined, item: any) => {
                const value = (item as any)[propertyName];
                const numValue = (value === null || value === undefined) ? 0 : Number(value);
                return (acc ?? 0) + numValue;
            },
            (acc: number, item: any) => {
                const value = (item as any)[propertyName];
                const numValue = (value === null || value === undefined) ? 0 : Number(value);
                return acc - numValue;
            }
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number>>>,
        TStart
    > {
        return this.commutativeAggregate(
            arrayName,
            outputProperty,
            (acc: number | undefined, _item: any) => (acc ?? 0) + 1,
            (acc: number, _item: any) => acc - 1
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number | undefined>>>,
        TStart
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new MinMaxAggregateStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (values) => Math.min(...values)
        );
        return new PipelineBuilder(this.input, newStep) as any;
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number | undefined>>>,
        TStart
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new MinMaxAggregateStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (values) => Math.max(...values)
        );
        return new PipelineBuilder(this.input, newStep) as any;
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, number | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, number | undefined>>>,
        TStart
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new AverageAggregateStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName
        );
        return new PipelineBuilder(this.input, newStep) as any;
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> | undefined>>>,
        TStart
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new PickByMinMaxStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (value1, value2) => {
                // For min: value1 < value2
                if (typeof value1 === 'number' && typeof value2 === 'number') {
                    return value1 < value2;
                }
                if (typeof value1 === 'string' && typeof value2 === 'string') {
                    return value1 < value2;
                }
                return String(value1) < String(value2);
            }
        );
        return new PipelineBuilder(this.input, newStep) as any;
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
        ArrayName extends string,
        TPropName extends string
    >(
        arrayName: ArrayName,
        propertyName: keyof NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> & string,
        outputProperty: TPropName
    ): PipelineBuilder<
        Path extends []
            ? TransformWithAggregate<T, [ArrayName], TPropName, NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> | undefined>
            : Expand<TransformAtPath<T, Path, NavigateToPath<T, Path> & Record<TPropName, NavigateToArrayItem<NavigateToPath<T, Path>, [ArrayName]> | undefined>>>,
        TStart
    > {
        const fullSegmentPath = [...this.scopeSegments, arrayName];
        const newStep = new PickByMinMaxStep(
            this.lastStep,
            fullSegmentPath,
            outputProperty,
            propertyName,
            (value1, value2) => {
                // For max: value1 > value2
                if (typeof value1 === 'number' && typeof value2 === 'number') {
                    return value1 > value2;
                }
                if (typeof value1 === 'string' && typeof value2 === 'string') {
                    return value1 > value2;
                }
                return String(value1) > String(value2);
            }
        );
        return new PipelineBuilder(this.input, newStep) as any;
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
    ): PipelineBuilder<T, TStart, [...Path, ...NewPath]> {
        return new PipelineBuilder<T, TStart, [...Path, ...NewPath]>(
            this.input,
            this.lastStep,
            [...this.scopeSegments, ...pathSegments] as [...Path, ...NewPath]
        );
    }

    /**
     * Filters items based on a predicate function.
     * Only items that pass the predicate will be included in the output.
     *
     * This is a stateless implementation - no item storage required because:
     * 1. Items are immutable
     * 2. RemovedHandler receives immutableProps
     * 3. Predicate re-evaluation is deterministic
     *
     * @param predicate - Function that returns true for items to include
     * @returns A PipelineBuilder with the same type (filtering doesn't change shape)
     *
     * @example
     * // Filter to only include items with price > 50
     * .filter(item => item.price > 50)
     *
     * @example
     * // Filter nested items within a scoped path
     * .in('employees').filter(emp => emp.salary >= 50000)
     */
    filter(
        predicate: (item: NavigateToPath<T, Path>) => boolean
    ): PipelineBuilder<T, TStart, Path> {
        const newStep = new FilterStep<NavigateToPath<T, Path>>(
            this.lastStep,
            predicate as (item: unknown) => boolean,
            this.scopeSegments as string[]
        );
        return new PipelineBuilder(this.input, newStep, this.scopeSegments) as any;
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.lastStep.getTypeDescriptor();
    }

    build(setState: (transform: Transform<KeyedArray<T>>) => void, typeDescriptor: TypeDescriptor): Pipeline<TStart> {
        const pathSegments = getPathSegmentsFromDescriptor(typeDescriptor);
        
        // Register handlers for each path the step will emit
        pathSegments.forEach(segmentPath => {
            this.lastStep.onAdded(segmentPath, (keyPath, key, immutableProps) => {
                setState(state => addToKeyedArray(state, segmentPath, keyPath, key, immutableProps) as KeyedArray<T>);
            });
            
            this.lastStep.onRemoved(segmentPath, (keyPath, key, immutableProps) => {
                setState(state => removeFromKeyedArray(state, segmentPath, keyPath, key) as KeyedArray<T>);
            });
            
            this.lastStep.onModified(segmentPath, (keyPath, key, name, value) => {
                setState(state => modifyInKeyedArray(state, segmentPath, keyPath, key, name, value) as KeyedArray<T>);
            });
        });
        
        return this.input;
    }
}

function addToKeyedArray(state: KeyedArray<any>, segmentPath: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): KeyedArray<any> {
    if (segmentPath.length === 0) {
        if (keyPath.length !== 0) {
            throw new Error("Mismatched path length when setting state");
        }
        return [...state, { key, value: immutableProps }];
    }
    else {
        if (keyPath.length === 0) {
            throw new Error("Mismatched path length when setting state");
        }
        const parentKey = keyPath[0];
        const segment = segmentPath[0];
        const existingItemIndex = state.findIndex(item => item.key === parentKey);
        if (existingItemIndex < 0) {
            throw new Error("Path references unknown item when setting state");
        }
        const existingItem = state[existingItemIndex];
        const existingArray = existingItem.value[segment] as KeyedArray<any> || [];
        const modifiedArray = addToKeyedArray(existingArray, segmentPath.slice(1), keyPath.slice(1), key, immutableProps);
        const modifiedItem = {
            key: parentKey,
            value: {
                ...existingItem.value,
                [segmentPath[0]]: modifiedArray
            }
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
}

function removeFromKeyedArray(state: KeyedArray<any>, segmentPath: string[], keyPath: string[], key: string): KeyedArray<any> {
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
        const existingItemIndex = state.findIndex(item => item.key === parentKey);
        if (existingItemIndex < 0) {
            throw new Error("Path references unknown item when removing from state");
        }
        const existingItem = state[existingItemIndex];
        const existingArray = existingItem.value[segment] as KeyedArray<any> || [];
        const modifiedArray = removeFromKeyedArray(existingArray, segmentPath.slice(1), keyPath.slice(1), key);
        const modifiedItem = {
            key: parentKey,
            value: {
                ...existingItem.value,
                [segmentPath[0]]: modifiedArray
            }
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
}

function modifyInKeyedArray(state: KeyedArray<any>, segmentPath: string[], keyPath: string[], key: string, name: string, value: any): KeyedArray<any> {
    if (segmentPath.length === 0) {
        if (keyPath.length !== 0) {
            throw new Error("Mismatched path length when modifying state");
        }
        const existingItemIndex = state.findIndex(item => item.key === key);
        if (existingItemIndex < 0) {
            throw new Error("Path references unknown item when modifying state");
        }
        const existingItem = state[existingItemIndex];
        const modifiedItem = {
            key: key,
            value: {
                ...existingItem.value,
                [name]: value
            }
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
        const existingItemIndex = state.findIndex(item => item.key === parentKey);
        if (existingItemIndex < 0) {
            throw new Error("Path references unknown item when modifying state");
        }
        const existingItem = state[existingItemIndex];
        const existingArray = existingItem.value[segment] as KeyedArray<any> || [];
        const modifiedArray = modifyInKeyedArray(existingArray, segmentPath.slice(1), keyPath.slice(1), key, name, value);
        const modifiedItem = {
            key: parentKey,
            value: {
                ...existingItem.value,
                [segmentPath[0]]: modifiedArray
            }
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex+1)
        ];
    }
}

