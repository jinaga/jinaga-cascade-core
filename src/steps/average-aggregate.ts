import type { AddedHandler, ImmutableProps, ModifiedHandler, RemovedHandler, Step, TypeDescriptor } from '../pipeline';

/**
 * Computes a hash key for a key path (for map lookups).
 */
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

/**
 * Tracks sum and count separately for computing average incrementally.
 */
interface AverageState {
    sum: number;
    count: number;
    average: number | undefined;
}

/**
 * A step that computes the average of a numeric property over items in a nested array.
 *
 * - Returns undefined for empty arrays
 * - Tracks sum and count separately for incremental updates
 * - Handles null/undefined by excluding from both sum and count
 */
export class AverageAggregateStep<
    TInput,
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
    
    /** Maps parent key path hash to current average value (for oldValue tracking) */
    private aggregateValues: Map<string, number | undefined> = new Map();
    
    /** Whether the property being aggregated is mutable (auto-detected) */
    private isPropertyMutable: boolean = false;
    
    /** Maps parent key path hash to Map<itemKey, value> for tracking individual item values */
    private itemValues: Map<string, Map<string, number>> = new Map();
    
    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string
    ) {
        // Auto-detect if property is mutable from TypeDescriptor
        const inputDescriptor = input.getTypeDescriptor();
        const rootMutableProperties = inputDescriptor.mutableProperties || [];
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
    
    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        // Mark the aggregate property as mutable
        const mutableProperties = inputDescriptor.mutableProperties || [];
        if (!mutableProperties.includes(this.propertyName)) {
            return {
                ...inputDescriptor,
                mutableProperties: [...mutableProperties, this.propertyName]
            };
        }
        return inputDescriptor;
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
    
    /**
     * Handle when an item is added to the target array
     */
    private handleItemAdded(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Initialize itemValues map for this parent if needed
        if (!this.itemValues.has(parentKeyHash)) {
            this.itemValues.set(parentKeyHash, new Map());
        }
        
        // Extract numeric value (ignore null/undefined)
        const value = item[this.numericProperty];
        
        // If property is mutable and value is not available yet, wait for onModified
        if (this.isPropertyMutable && (value === null || value === undefined)) {
            // Track that this item exists but has no value yet
            // The value will come via handleItemPropertyChanged
            return;
        }
        
        if (value !== null && value !== undefined) {
            const numValue = Number(value);
            if (!isNaN(numValue)) {
                // Track individual item value
                this.itemValues.get(parentKeyHash)!.set(itemKey, numValue);
                
                // Update sum and count
                const state = this.averageStates.get(parentKeyHash) || { sum: 0, count: 0, average: undefined };
                state.sum += numValue;
                state.count += 1;
                state.average = state.sum / state.count;
                this.averageStates.set(parentKeyHash, state);
            }
        }
        
        // Compute new average
        const state = this.averageStates.get(parentKeyHash);
        const oldAverage = this.aggregateValues.get(parentKeyHash);
        const newAverage = (state && state.count > 0) ? state.average : undefined;
        this.aggregateValues.set(parentKeyHash, newAverage);
        
        // Emit modification event
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, oldAverage, newAverage);
            });
        } else {
            // Parent is at root level
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', oldAverage, newAverage);
            });
        }
    }
    
    /**
     * Handle when a mutable property of an aggregated item changes
     */
    private handleItemPropertyChanged(keyPath: string[], itemKey: string, oldValue: any, newValue: any): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Get or create itemValues map for this parent
        if (!this.itemValues.has(parentKeyHash)) {
            this.itemValues.set(parentKeyHash, new Map());
        }
        const itemValuesMap = this.itemValues.get(parentKeyHash)!;
        
        // Get old numeric value for this item (if it exists)
        const oldNumValue = itemValuesMap.get(itemKey);
        const hadOldValue = oldNumValue !== undefined;
        
        // Parse new value
        const newNum = (newValue !== null && newValue !== undefined) ? Number(newValue) : NaN;
        const hasNewValue = !isNaN(newNum);
        
        // Update itemValues map
        if (hasNewValue) {
            itemValuesMap.set(itemKey, newNum);
        } else {
            itemValuesMap.delete(itemKey);
        }
        
        // Get or create state
        let state = this.averageStates.get(parentKeyHash);
        if (!state) {
            state = { sum: 0, count: 0, average: undefined };
            this.averageStates.set(parentKeyHash, state);
        }
        
        const oldAverage = state.average;
        
        // Update sum and count based on what changed
        if (hadOldValue && hasNewValue) {
            // Value changed: sum = sum - oldValue + newValue (count stays same)
            state.sum = state.sum - oldNumValue! + newNum;
        } else if (!hadOldValue && hasNewValue) {
            // New value added: increment both sum and count
            state.sum += newNum;
            state.count += 1;
        } else if (hadOldValue && !hasNewValue) {
            // Value removed: decrement both sum and count
            state.sum -= oldNumValue!;
            state.count -= 1;
        }
        
        // Calculate new average
        if (state.count > 0) {
            state.average = state.sum / state.count;
        } else {
            state.average = undefined;
            this.averageStates.delete(parentKeyHash);
        }
        
        // Update aggregate values cache
        const newAverage = state.average;
        if (newAverage !== undefined) {
            this.aggregateValues.set(parentKeyHash, newAverage);
        } else {
            this.aggregateValues.delete(parentKeyHash);
        }
        
        // Emit modification event
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
     * Handle when an item is removed from the target array
     */
    private handleItemRemoved(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Get the value to remove - either from itemValues map (for mutable) or from item (for immutable)
        let valueToRemove: number | undefined;
        
        if (this.isPropertyMutable) {
            // For mutable properties, look up the tracked value
            const itemValuesMap = this.itemValues.get(parentKeyHash);
            if (itemValuesMap) {
                valueToRemove = itemValuesMap.get(itemKey);
                itemValuesMap.delete(itemKey);
                if (itemValuesMap.size === 0) {
                    this.itemValues.delete(parentKeyHash);
                }
            }
        } else {
            // For immutable properties, read from item
            const value = item[this.numericProperty];
            if (value !== null && value !== undefined) {
                const numValue = Number(value);
                if (!isNaN(numValue)) {
                    valueToRemove = numValue;
                }
            }
        }
        
        // Update sum and count if value was numeric
        if (valueToRemove !== undefined) {
            const state = this.averageStates.get(parentKeyHash);
            if (state) {
                state.sum -= valueToRemove;
                state.count -= 1;
                
                if (state.count === 0) {
                    state.average = undefined;
                    this.averageStates.delete(parentKeyHash);
                } else {
                    state.average = state.sum / state.count;
                    this.averageStates.set(parentKeyHash, state);
                }
            }
        }
        
        // Compute new average
        const state = this.averageStates.get(parentKeyHash);
        const oldAverage = this.aggregateValues.get(parentKeyHash);
        const newAverage = (state && state.count > 0) ? state.average : undefined;
        
        if (!state || state.count === 0) {
            this.aggregateValues.delete(parentKeyHash);
        } else {
            this.aggregateValues.set(parentKeyHash, newAverage);
        }
        
        // Emit modification event
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
}
