import type { AddedHandler, BuildContext, BuiltStepGraph, ImmutableProps, ModifiedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';

/**
 * Computes a hash key for a key path (for map lookups).
 */
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

function transformAverageAggregateDescriptor(
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
 * Tracks sum and count for computing average incrementally.
 * Average is derived as sum/count on read; not stored separately.
 */
interface AverageState {
    sum: number;
    count: number;
}

function averageFromState(state: AverageState): number | undefined {
    return state.count > 0 ? state.sum / state.count : undefined;
}

/**
 * A step that computes the average of a numeric property over items in a nested array.
 *
 * - Returns undefined for empty arrays
 * - Tracks sum and count separately for incremental updates
 * - Handles null/undefined by excluding from both sum and count
 */
export class AverageAggregateStep<
    _TInput,
    TPath extends string[],
    TPropertyName extends string
> implements Step {

    /** Maps parent key path hash to average state (sum and count) */
    private averageStates: Map<string, AverageState> = new Map();

    /** Handlers for modified events at various levels */
    private modifiedHandlers: Array<{
        pathSegments: string[];
        propertyName: string;
        handler: ModifiedHandler;
    }> = [];

    /** Whether the property being aggregated is mutable (auto-detected) */
    private isPropertyMutable: boolean = false;

    /** Maps parent key path hash to Map<itemKey, value> for tracking individual item values */
    private itemValues: Map<string, Map<string, number>> = new Map();
    
    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string,
        inputDescriptor: TypeDescriptor
    ) {
        // Auto-detect if property is mutable from TypeDescriptor
        const rootMutableProperties = inputDescriptor.mutableProperties;
        if (rootMutableProperties.includes(numericProperty)) {
            this.isPropertyMutable = true;
        }
        
        // Register with input step to receive item add/remove events at the target array level
        this.input.onAdded(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemAdded(keyPath, itemKey, immutableProps);
        });
        
        this.input.onRemoved(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemRemoved(keyPath, itemKey, immutableProps);
        });
        
        // Register for property changes if mutable
        if (this.isPropertyMutable) {
            this.input.onModified(this.segmentPath, numericProperty, (keyPath, itemKey, oldValue, newValue) => {
                this.handleItemPropertyChanged(keyPath, itemKey, oldValue, newValue);
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
            // Handler wants modification events at parent level for this aggregate property
            // This is the channel for receiving aggregate values
            this.modifiedHandlers.push({
                pathSegments,
                propertyName,
                handler
            });
        }
        // Always pass through to input for other property modifications
        this.input.onModified(pathSegments, propertyName, handler);
    }
    
    /**
     * Checks if the given path segments represent the parent level (where aggregate property lives)
     */
    private isParentPath(pathSegments: string[]): boolean {
        // Parent path segments are segmentPath without the last element
        const parentSegments = this.segmentPath.slice(0, -1);
        
        if (pathSegments.length !== parentSegments.length) {
            return false;
        }
        
        return pathSegments.every((segment, i) => segment === parentSegments[i]);
    }
    
    private emitModified(parentKeyPath: string[], oldAverage: number | undefined, newAverage: number | undefined): void {
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, oldAverage, newAverage);
            });
        } else {
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', oldAverage, newAverage);
            });
        }
    }

    /**
     * Handle when an item is added to the target array
     */
    private handleItemAdded(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);

        if (!this.itemValues.has(parentKeyHash)) {
            this.itemValues.set(parentKeyHash, new Map());
        }

        const value = item[this.numericProperty];

        // If property is mutable and value is not available yet, wait for onModified
        if (this.isPropertyMutable && (value === null || value === undefined)) {
            return;
        }

        const oldAverage = averageFromState(this.averageStates.get(parentKeyHash) ?? { sum: 0, count: 0 });

        if (value !== null && value !== undefined) {
            const numValue = Number(value);
            if (Number.isFinite(numValue)) {
                this.itemValues.get(parentKeyHash)!.set(itemKey, numValue);
                const state = this.averageStates.get(parentKeyHash) ?? { sum: 0, count: 0 };
                state.sum += numValue;
                state.count += 1;
                this.averageStates.set(parentKeyHash, state);
            }
        }

        const newAverage = averageFromState(this.averageStates.get(parentKeyHash) ?? { sum: 0, count: 0 });
        this.emitModified(parentKeyPath, oldAverage, newAverage);
    }
    
    /**
     * Handle when a mutable property of an aggregated item changes
     */
    private handleItemPropertyChanged(keyPath: string[], itemKey: string, _oldValue: unknown, newValue: unknown): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);

        if (!this.itemValues.has(parentKeyHash)) {
            this.itemValues.set(parentKeyHash, new Map());
        }
        const itemValuesMap = this.itemValues.get(parentKeyHash)!;

        const oldNumValue = itemValuesMap.get(itemKey);
        const hadOldValue = oldNumValue !== undefined;

        const newNum = (newValue !== null && newValue !== undefined) ? Number(newValue) : NaN;
        const hasNewValue = Number.isFinite(newNum);

        if (hasNewValue) {
            itemValuesMap.set(itemKey, newNum);
        } else {
            itemValuesMap.delete(itemKey);
        }

        let state = this.averageStates.get(parentKeyHash);
        if (!state) {
            state = { sum: 0, count: 0 };
            this.averageStates.set(parentKeyHash, state);
        }

        const oldAverage = averageFromState(state);

        if (hadOldValue && hasNewValue) {
            state.sum = state.sum - oldNumValue + newNum;
        } else if (!hadOldValue && hasNewValue) {
            state.sum += newNum;
            state.count += 1;
        } else if (hadOldValue && !hasNewValue) {
            state.sum -= oldNumValue;
            state.count -= 1;
        }

        if (state.count === 0) {
            this.averageStates.delete(parentKeyHash);
        }

        const newAverage = averageFromState(state);
        this.emitModified(parentKeyPath, oldAverage, newAverage);
    }
    
    /**
     * Handle when an item is removed from the target array
     */
    private handleItemRemoved(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);

        let valueToRemove: number | undefined;

        if (this.isPropertyMutable) {
            const itemValuesMap = this.itemValues.get(parentKeyHash);
            if (itemValuesMap) {
                valueToRemove = itemValuesMap.get(itemKey);
                itemValuesMap.delete(itemKey);
                if (itemValuesMap.size === 0) {
                    this.itemValues.delete(parentKeyHash);
                }
            }
        } else {
            const value = item[this.numericProperty];
            if (value !== null && value !== undefined) {
                const numValue = Number(value);
                if (Number.isFinite(numValue)) {
                    valueToRemove = numValue;
                }
            }
        }

        const stateBefore = this.averageStates.get(parentKeyHash);
        const oldAverage = averageFromState(stateBefore ?? { sum: 0, count: 0 });

        if (valueToRemove !== undefined && stateBefore) {
            stateBefore.sum -= valueToRemove;
            stateBefore.count -= 1;
            if (stateBefore.count === 0) {
                this.averageStates.delete(parentKeyHash);
            }
        }

        const stateAfter = this.averageStates.get(parentKeyHash);
        const newAverage = averageFromState(stateAfter ?? { sum: 0, count: 0 });
        this.emitModified(parentKeyPath, oldAverage, newAverage);
    }
}

export class AverageAggregateBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private numericProperty: string
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformAverageAggregateDescriptor(this.upstream.getTypeDescriptor(), this.propertyName);
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new AverageAggregateStep(
                up.lastStep,
                this.segmentPath,
                this.propertyName,
                this.numericProperty,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}
