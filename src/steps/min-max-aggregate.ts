import type { AddedHandler, ImmutableProps, ModifiedHandler, RemovedHandler, Step, TypeDescriptor } from '../pipeline';

/**
 * Computes a hash key for a key path (for map lookups).
 */
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

/**
 * A step that computes the minimum or maximum value of a property over items in a nested array.
 * 
 * - Returns undefined for empty arrays
 * - Ignores null/undefined values in comparison
 * - Handles removal by tracking all values and recalculating
 */
export class MinMaxAggregateStep<
    TInput,
    TPath extends string[],
    TPropertyName extends string
> implements Step {
    
    /** Maps parent key path hash to array of numeric values (excluding null/undefined) */
    private valueStore: Map<string, number[]> = new Map();
    
    /** Handlers for modified events at various levels */
    private modifiedHandlers: Array<{
        pathSegments: string[];
        propertyName: string;
        handler: ModifiedHandler;
    }> = [];
    
    /** Maps parent key path hash to current aggregate value (for oldValue tracking) */
    private aggregateValues: Map<string, number | undefined> = new Map();
    
    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string,
        private aggregateFn: (values: number[]) => number
    ) {
        // Register with input step to receive item add/remove events at the target array level
        this.input.onAdded(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemAdded(keyPath, itemKey, immutableProps);
        });
        
        this.input.onRemoved(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemRemoved(keyPath, itemKey, immutableProps);
        });
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
        
        // Extract numeric value (ignore null/undefined)
        const value = item[this.numericProperty];
        if (value !== null && value !== undefined) {
            const numValue = Number(value);
            if (!isNaN(numValue)) {
                // Add to value store
                const values = this.valueStore.get(parentKeyHash) || [];
                values.push(numValue);
                this.valueStore.set(parentKeyHash, values);
            }
        }
        
        // Compute new aggregate using the provided function
        const values = this.valueStore.get(parentKeyHash) || [];
        const oldAggregate = this.aggregateValues.get(parentKeyHash);
        const newAggregate = values.length > 0 ? this.aggregateFn(values) : undefined;
        this.aggregateValues.set(parentKeyHash, newAggregate);
        
        // Emit modification event
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, oldAggregate, newAggregate);
            });
        } else {
            // Parent is at root level
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', oldAggregate, newAggregate);
            });
        }
    }
    
    /**
     * Handle when an item is removed from the target array
     */
    private handleItemRemoved(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Remove value from store if it was numeric
        const value = item[this.numericProperty];
        if (value !== null && value !== undefined) {
            const numValue = Number(value);
            if (!isNaN(numValue)) {
                const values = this.valueStore.get(parentKeyHash);
                if (values) {
                    const index = values.indexOf(numValue);
                    if (index >= 0) {
                        values.splice(index, 1);
                        if (values.length === 0) {
                            this.valueStore.delete(parentKeyHash);
                        } else {
                            this.valueStore.set(parentKeyHash, values);
                        }
                    }
                }
            }
        }
        
        // Compute new aggregate using the provided function
        const values = this.valueStore.get(parentKeyHash) || [];
        const oldAggregate = this.aggregateValues.get(parentKeyHash);
        const newAggregate = values.length > 0 ? this.aggregateFn(values) : undefined;
        
        if (values.length === 0) {
            this.aggregateValues.delete(parentKeyHash);
        } else {
            this.aggregateValues.set(parentKeyHash, newAggregate);
        }
        
        // Emit modification event
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, oldAggregate, newAggregate);
            });
        } else {
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', oldAggregate, newAggregate);
            });
        }
    }
}
