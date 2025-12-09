import type { ImmutableProps, Step } from '../pipeline';
import { type TypeDescriptor } from '../pipeline';
import { pathsMatch } from '../util/path';

export class DefinePropertyStep<T, K extends string, U> implements Step {
    // Track items and their mutable property values
    private itemStates: Map<string, { immutableProps: ImmutableProps; mutableValues: Map<string, any> }> = new Map();
    // Track downstream handlers for emitting recomputed properties
    private addedHandlers: Array<{ pathSegments: string[]; handler: (keyPath: string[], key: string, immutableProps: ImmutableProps) => void }> = [];
    
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
        return this.input.getTypeDescriptor();
    }
    
    private composeItem(immutableProps: ImmutableProps, mutableValues: Map<string, any>): T {
        const mutableProps: Record<string, any> = {};
        for (const propName of this.mutableProperties) {
            mutableProps[propName] = mutableValues.get(propName);
        }
        return { ...immutableProps, ...mutableProps } as T;
    }
    
    private handleMutablePropertyChange(keyPath: string[], key: string, propertyName: string, oldValue: any, newValue: any): void {
        const itemKey = keyPath.length === 0 ? key : keyPath[keyPath.length - 1];
        const itemState = this.itemStates.get(itemKey);
        if (!itemState) {
            return; // Item not tracked
        }

        // Update mutable value
        itemState.mutableValues.set(propertyName, newValue);

        // Recompute defined property
        const composedItem = this.composeItem(itemState.immutableProps, itemState.mutableValues);
        const newComputedValue = this.compute(composedItem);
        
        // Get old computed value (we'd need to track this, but for now emit the change)
        // Emit onModified for the defined property
        const parentKeyPath = keyPath.length > 0 ? keyPath.slice(0, -1) : [];
        const parentKey = keyPath.length > 0 ? keyPath[keyPath.length - 1] : key;
        
        // Find handlers registered for this property at this path
        this.addedHandlers.forEach(({ pathSegments, handler }) => {
            if (pathsMatch(pathSegments, this.scopeSegments)) {
                // This handler is at our scope level - we need to emit onModified
                // But we don't have direct access to onModified handlers
                // For now, we'll need to track them separately
            }
        });
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
                
                // Store item state
                this.itemStates.set(key, { immutableProps, mutableValues });
                
                // Compose item and compute property
                const composedItem = this.composeItem(immutableProps, mutableValues);
                const computedValue = this.compute(composedItem);
                
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
        // Forward modifications for properties not in mutableProperties array
        if (!this.mutableProperties.includes(propertyName)) {
            this.input.onModified(pathSegments, propertyName, handler);
        } else {
            // For mutable properties we track, we handle them internally
            // but still need to forward to downstream steps
            this.input.onModified(pathSegments, propertyName, handler);
        }
        
        // Also register for modifications to the defined property itself
        if (propertyName === this.propertyName && pathsMatch(pathSegments, this.scopeSegments)) {
            // Handler wants modifications to the defined property
            // We'll need to track these and emit when we recompute
            // For now, forward to input (though input won't have this property)
            this.input.onModified(pathSegments, propertyName, handler);
        }
    }
    
    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}

