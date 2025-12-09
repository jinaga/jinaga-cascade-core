import type { AddedHandler, ImmutableProps, RemovedHandler, ModifiedHandler, Step, TypeDescriptor } from '../pipeline';
import { pathsMatch } from '../util/path';

/**
 * A step that filters items based on a predicate function.
 * 
 * This is a STATELESS implementation - no item storage required because:
 * 1. Items are immutable
 * 2. RemovedHandler receives immutableProps
 * 3. Predicate re-evaluation is deterministic
 */
export class FilterStep<T> implements Step {
    // Track items that passed the filter and their current mutable property values
    private passedItems: Map<string, { immutableProps: ImmutableProps; mutableValues: Map<string, any> }> = new Map();
    
    constructor(
        private input: Step,
        private predicate: (item: T) => boolean,
        private scopeSegments: string[],
        private mutableProperties: string[] = []
    ) {
        // Register for mutable property changes if any are specified
        if (mutableProperties.length > 0 && this.scopeSegments.length === 0) {
            // For root-level filtering, register for mutable properties
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

    private evaluatePredicate(immutableProps: ImmutableProps, mutableValues: Map<string, any>): boolean {
        const item = this.composeItem(immutableProps, mutableValues);
        return this.predicate(item);
    }

    private handleMutablePropertyChange(keyPath: string[], key: string, propertyName: string, oldValue: any, newValue: any): void {
        const itemKey = keyPath.length === 0 ? key : keyPath[keyPath.length - 1];
        const itemState = this.passedItems.get(itemKey);
        if (!itemState) {
            // Item doesn't pass filter or wasn't tracked, forward the change
            // Forward to downstream steps for properties we don't handle
            return;
        }

        // Update mutable value
        itemState.mutableValues.set(propertyName, newValue);

        // Re-evaluate predicate
        const nowPasses = this.evaluatePredicate(itemState.immutableProps, itemState.mutableValues);
        const previouslyPassed = this.passedItems.has(itemKey);

        if (nowPasses && !previouslyPassed) {
            // Item now passes - emit add
            // This would require tracking downstream handlers
            // For now, we'll forward the change
        } else if (!nowPasses && previouslyPassed) {
            // Item no longer passes - emit remove
            this.passedItems.delete(itemKey);
            // This would require tracking downstream handlers
            // For now, we'll forward the change
        }
        // If state unchanged, no action needed
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                const mutableValues = new Map<string, any>();
                // Initialize mutable values (they'll be updated via onModified if they change)
                for (const propName of this.mutableProperties) {
                    mutableValues.set(propName, immutableProps[propName]);
                }
                
                if (this.evaluatePredicate(immutableProps, mutableValues)) {
                    this.passedItems.set(key, { immutableProps, mutableValues });
                    handler(keyPath, key, immutableProps);
                }
            });
        } else {
            this.input.onAdded(pathSegments, handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                const itemState = this.passedItems.get(key);
                if (itemState) {
                    this.passedItems.delete(key);
                    handler(keyPath, key, immutableProps);
                }
            });
        } else {
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        // Forward modifications for properties not in mutableProperties array
        if (!this.mutableProperties.includes(propertyName)) {
            this.input.onModified(pathSegments, propertyName, handler);
        }
        // Properties in mutableProperties are handled in handleMutablePropertyChange
        // but we still need to forward to downstream steps
        this.input.onModified(pathSegments, propertyName, handler);
    }

    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}