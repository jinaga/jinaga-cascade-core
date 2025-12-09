import type { AddedHandler, ImmutableProps, ModifiedHandler, RemovedHandler, Step, TypeDescriptor } from '../pipeline.js';

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
    
    /** Whether the property being aggregated is mutable (auto-detected) */
    private isPropertyMutable: boolean = false;
    
    /** Maps parent key path hash to Map<itemKey, value> for tracking individual item values */
    private itemValues: Map<string, Map<string, number>> = new Map();
    
    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string,
        private aggregateFn: (values: number[]) => number
    ) {
        // Auto-detect if property is mutable from TypeDescriptor
        // Note: DefinePropertyStep and CommutativeAggregateStep add mutable properties
        // at the root level, not at the nested array level, so we check root-level mutableProperties
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
        
        // Parse new value
        const newNum = (newValue !== null && newValue !== undefined) ? Number(newValue) : NaN;
        
        // Update itemValues map
        if (!isNaN(newNum)) {
            itemValuesMap.set(itemKey, newNum);
        } else {
            itemValuesMap.delete(itemKey);
        }
        
        // Update valueStore
        let values = this.valueStore.get(parentKeyHash);
        if (values) {
            // Remove old value if it existed
            if (oldNumValue !== undefined) {
                const index = values.indexOf(oldNumValue);
                if (index >= 0) {
                    values.splice(index, 1);
                }
            }
            // Add new value
            if (!isNaN(newNum)) {
                values.push(newNum);
            }
            // Clean up if empty
            if (values.length === 0) {
                this.valueStore.delete(parentKeyHash);
            }
        } else if (!isNaN(newNum)) {
            // No values array yet, create one
            this.valueStore.set(parentKeyHash, [newNum]);
            values = this.valueStore.get(parentKeyHash);
        }
        
        // Compute new aggregate
        const currentValues = this.valueStore.get(parentKeyHash) || [];
        const oldAggregate = this.aggregateValues.get(parentKeyHash);
        const newAggregate = currentValues.length > 0 ? this.aggregateFn(currentValues) : undefined;
        
        if (currentValues.length === 0) {
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
        
        // Remove value from store
        if (valueToRemove !== undefined) {
            const values = this.valueStore.get(parentKeyHash);
            if (values) {
                const index = values.indexOf(valueToRemove);
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
