import type { ImmutableProps, ModifiedHandler, Step } from '../pipeline';
import { type TypeDescriptor } from '../pipeline';
import { pathsMatch } from '../util/path';

export class DefinePropertyStep<T, K extends string, U> implements Step {
    // Track items and their mutable property values + computed property value
    private itemStates: Map<string, {
        immutableProps: ImmutableProps;
        mutableValues: Map<string, any>;
        computedValue: U;
        keyPath: string[];
    }> = new Map();
    // Track downstream handlers for emitting recomputed properties
    private addedHandlers: Array<{ pathSegments: string[]; handler: (keyPath: string[], key: string, immutableProps: ImmutableProps) => void }> = [];
    // Track handlers for onModified events on the defined property
    private modifiedHandlers: Array<{
        pathSegments: string[];
        propertyName: string;
        handler: ModifiedHandler;
    }> = [];
    
    constructor(
        private input: Step,
        private propertyName: K,
        private compute: (item: T) => U,
        private scopeSegments: string[],
        private mutableProperties: string[] = []
    ) {
        // Register for mutable property changes
        if (mutableProperties.length > 0) {
            mutableProperties.forEach(propName => {
                this.input.onModified(this.scopeSegments, propName, (keyPath, key, oldValue, newValue) => {
                    this.handleMutablePropertyChange(keyPath, key, propName, oldValue, newValue);
                });
            });
        }
    }
    
    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        // If this property depends on mutable properties, mark it as mutable too
        if (this.mutableProperties.length > 0) {
            const existingMutableProps = inputDescriptor.mutableProperties || [];
            if (!existingMutableProps.includes(this.propertyName)) {
                return {
                    ...inputDescriptor,
                    mutableProperties: [...existingMutableProps, this.propertyName]
                };
            }
        }
        return inputDescriptor;
    }
    
    private composeItem(immutableProps: ImmutableProps, mutableValues: Map<string, any>): T {
        const mutableProps: Record<string, any> = {};
        for (const propName of this.mutableProperties) {
            mutableProps[propName] = mutableValues.get(propName);
        }
        return { ...immutableProps, ...mutableProps } as T;
    }
    
    private handleMutablePropertyChange(keyPath: string[], key: string, propertyName: string, oldValue: any, newValue: any): void {
        // The key parameter is the item key - use it directly for lookup
        const itemState = this.itemStates.get(key);
        if (!itemState) {
            return; // Item not tracked
        }

        // Update mutable value
        itemState.mutableValues.set(propertyName, newValue);

        // Recompute defined property
        const composedItem = this.composeItem(itemState.immutableProps, itemState.mutableValues);
        const newComputedValue = this.compute(composedItem);
        
        // Get old computed value and check if it changed
        const oldComputedValue = itemState.computedValue;
        
        // Update stored computed value
        itemState.computedValue = newComputedValue;
        
        // Only emit if the computed value actually changed
        if (oldComputedValue !== newComputedValue) {
            // Emit onModified for the defined property
            // keyPath is the path to the parent, key is the item key
            // This matches the pattern used by other steps (e.g., CommutativeAggregateStep)
            
            // Notify all handlers registered for this property at the scope level
            this.modifiedHandlers.forEach(({ pathSegments, propertyName: propName, handler }) => {
                if (propName === this.propertyName && pathsMatch(pathSegments, this.scopeSegments)) {
                    handler(keyPath, key, oldComputedValue, newComputedValue);
                }
            });
        }
    }
    
    onAdded(pathSegments: string[], handler: (keyPath: string[], key: string, immutableProps: ImmutableProps) => void): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // Store handler for later use
            this.addedHandlers.push({ pathSegments, handler });
            
            // Apply the property transformation at the scoped level
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                const mutableValues = new Map<string, any>();
                // Initialize mutable values from immutableProps (they might be there initially)
                for (const propName of this.mutableProperties) {
                    mutableValues.set(propName, immutableProps[propName]);
                }
                
                // Compose item and compute property
                const composedItem = this.composeItem(immutableProps, mutableValues);
                const computedValue = this.compute(composedItem);
                
                // Store item state including computed value and keyPath
                this.itemStates.set(key, { immutableProps, mutableValues, computedValue, keyPath });
                
                handler(keyPath, key, { ...immutableProps, [this.propertyName]: computedValue } as T & Record<K, U>);
            });
        } else {
            // Pass through unchanged when not at scope segments
            this.input.onAdded(pathSegments, handler);
        }
    }
    
    onRemoved(pathSegments: string[], handler: (keyPath: string[], key: string, immutableProps: ImmutableProps) => void): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // Apply the property transformation at the scoped level (for removal too)
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                const itemState = this.itemStates.get(key);
                if (itemState) {
                    const composedItem = this.composeItem(immutableProps, itemState.mutableValues);
                    const computedValue = this.compute(composedItem);
                    handler(keyPath, key, { ...immutableProps, [this.propertyName]: computedValue } as T & Record<K, U>);
                    this.itemStates.delete(key);
                } else {
                    // Fallback if state not tracked
                    handler(keyPath, key, { ...immutableProps, [this.propertyName]: this.compute(immutableProps as T) } as T & Record<K, U>);
                }
            });
        } else {
            // Pass through unchanged when not at scope segments
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], propertyName: string, handler: (keyPath: string[], key: string, oldValue: any, newValue: any) => void): void {
        // If handler is requesting modifications to the defined property at our scope
        if (propertyName === this.propertyName && pathsMatch(pathSegments, this.scopeSegments)) {
            // Store this handler to call when the computed property changes
            this.modifiedHandlers.push({ pathSegments, propertyName, handler });
            return;
        }
        
        // Forward all other modification requests to input
        this.input.onModified(pathSegments, propertyName, handler);
    }
    
    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}

