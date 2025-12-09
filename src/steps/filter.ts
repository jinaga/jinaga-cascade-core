import type { AddedHandler, ImmutableProps, RemovedHandler, ModifiedHandler, Step, TypeDescriptor } from '../pipeline';
import { pathsMatch, pathStartsWith } from '../util/path';

/**
 * State tracked for each item seen by the filter step.
 */
interface ItemState {
    immutableProps: ImmutableProps;
    mutableValues: Map<string, any>;
    keyPath: string[];
    passed: boolean;
}

/**
 * A step that filters items based on a predicate function.
 *
 * For filter re-evaluation on mutable property changes, this step tracks:
 * - All items (not just those that passed) with their state
 * - Handlers for add/remove events to emit during re-evaluation
 *
 * When a mutable property changes:
 * - Re-evaluate the predicate with the new value
 * - If result changes from false->true: emit onAdded
 * - If result changes from true->false: emit onRemoved
 *
 * IMPORTANT: When a parent item is blocked by the filter, all nested operations
 * for that parent must also be blocked until/unless the parent passes.
 */
export class FilterStep<T> implements Step {
    // Track ALL items (passed or not) with their state
    private itemStates: Map<string, ItemState> = new Map();
    
    // Store handlers for re-evaluation (registered via onAdded/onRemoved)
    private addedHandler: AddedHandler | null = null;
    private removedHandler: RemovedHandler | null = null;
    
    // Track pending nested operations for items that don't pass the filter yet
    // key -> Map of pendingPath -> Array of pending operations
    private pendingNestedAdds: Map<string, Array<{ pathSegments: string[], keyPath: string[], key: string, immutableProps: ImmutableProps }>> = new Map();
    private pendingNestedModifications: Map<string, Array<{ pathSegments: string[], propertyName: string, keyPath: string[], key: string, oldValue: any, newValue: any }>> = new Map();
    
    // Store nested handlers for replaying when parent passes
    private nestedAddedHandlers: Map<string, AddedHandler> = new Map();
    private nestedRemovedHandlers: Map<string, RemovedHandler> = new Map();
    private nestedModifiedHandlers: Map<string, Map<string, ModifiedHandler>> = new Map();
    
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

    /**
     * Gets the parent key from a keyPath for nested operations.
     * For root-level filtering (scopeSegments = []), the parent key is the first element of keyPath.
     */
    private getParentKeyFromKeyPath(keyPath: string[]): string | undefined {
        if (this.scopeSegments.length === 0 && keyPath.length > 0) {
            return keyPath[0];
        }
        return undefined;
    }

    /**
     * Checks if a path is nested under the filter's scope level.
     */
    private isNestedPath(pathSegments: string[]): boolean {
        return pathSegments.length > this.scopeSegments.length &&
               pathStartsWith(pathSegments, this.scopeSegments);
    }

    private handleMutablePropertyChange(keyPath: string[], key: string, propertyName: string, oldValue: any, newValue: any): void {
        const itemState = this.itemStates.get(key);
        if (!itemState) {
            // Item not tracked (shouldn't happen if properly added first)
            return;
        }

        // Update mutable value
        itemState.mutableValues.set(propertyName, newValue);

        // Re-evaluate predicate
        const nowPasses = this.evaluatePredicate(itemState.immutableProps, itemState.mutableValues);
        const previouslyPassed = itemState.passed;

        if (nowPasses && !previouslyPassed) {
            // Item now passes - emit onAdded, then replay pending nested operations
            itemState.passed = true;
            if (this.addedHandler) {
                const composedItem = this.composeItem(itemState.immutableProps, itemState.mutableValues);
                this.addedHandler(itemState.keyPath, key, composedItem as ImmutableProps);
            }
            
            // Replay pending nested adds for this parent
            this.replayPendingNestedOperations(key);
        } else if (!nowPasses && previouslyPassed) {
            // Item no longer passes - emit onRemoved
            itemState.passed = false;
            if (this.removedHandler) {
                const composedItem = this.composeItem(itemState.immutableProps, itemState.mutableValues);
                this.removedHandler(itemState.keyPath, key, composedItem as ImmutableProps);
            }
        }
        // If state unchanged, no action needed
    }

    /**
     * Replay any pending nested operations when a parent passes the filter.
     */
    private replayPendingNestedOperations(parentKey: string): void {
        // Replay nested adds
        const pendingAdds = this.pendingNestedAdds.get(parentKey);
        if (pendingAdds) {
            for (const pending of pendingAdds) {
                const pathKey = JSON.stringify(pending.pathSegments);
                const handler = this.nestedAddedHandlers.get(pathKey);
                if (handler) {
                    handler(pending.keyPath, pending.key, pending.immutableProps);
                }
            }
            this.pendingNestedAdds.delete(parentKey);
        }

        // Replay nested modifications (property updates that occurred while parent was blocked)
        const pendingMods = this.pendingNestedModifications.get(parentKey);
        if (pendingMods) {
            for (const pending of pendingMods) {
                const pathKey = JSON.stringify(pending.pathSegments);
                const handlersForPath = this.nestedModifiedHandlers.get(pathKey);
                if (handlersForPath) {
                    const handler = handlersForPath.get(pending.propertyName);
                    if (handler) {
                        handler(pending.keyPath, pending.key, pending.oldValue, pending.newValue);
                    }
                }
            }
            this.pendingNestedModifications.delete(parentKey);
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // Store handler for re-evaluation
            this.addedHandler = handler;
            
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                const mutableValues = new Map<string, any>();
                // Initialize mutable values (they'll be updated via onModified if they change)
                for (const propName of this.mutableProperties) {
                    mutableValues.set(propName, immutableProps[propName]);
                }
                
                const passes = this.evaluatePredicate(immutableProps, mutableValues);
                
                // Track ALL items with their state
                this.itemStates.set(key, {
                    immutableProps,
                    mutableValues,
                    keyPath,
                    passed: passes
                });
                
                if (passes) {
                    handler(keyPath, key, immutableProps);
                }
            });
        } else if (this.isNestedPath(pathSegments)) {
            // Store handler for potential replay
            const pathKey = JSON.stringify(pathSegments);
            this.nestedAddedHandlers.set(pathKey, handler);
            
            // For nested paths, only forward if parent passes the filter
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                const parentKey = this.getParentKeyFromKeyPath(keyPath);
                if (parentKey) {
                    const parentState = this.itemStates.get(parentKey);
                    if (parentState && parentState.passed) {
                        // Parent passes, forward the nested add
                        handler(keyPath, key, immutableProps);
                    } else {
                        // Parent doesn't pass (or doesn't exist yet), queue the add
                        if (!this.pendingNestedAdds.has(parentKey)) {
                            this.pendingNestedAdds.set(parentKey, []);
                        }
                        this.pendingNestedAdds.get(parentKey)!.push({ pathSegments, keyPath, key, immutableProps });
                    }
                } else {
                    // No parent key derivable, pass through
                    handler(keyPath, key, immutableProps);
                }
            });
        } else {
            this.input.onAdded(pathSegments, handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // Store handler for re-evaluation
            this.removedHandler = handler;
            
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                const itemState = this.itemStates.get(key);
                if (itemState && itemState.passed) {
                    handler(keyPath, key, immutableProps);
                }
                // Remove from tracking and clean up pending operations
                this.itemStates.delete(key);
                this.pendingNestedAdds.delete(key);
                this.pendingNestedModifications.delete(key);
            });
        } else if (this.isNestedPath(pathSegments)) {
            // Store handler for potential replay
            const pathKey = JSON.stringify(pathSegments);
            this.nestedRemovedHandlers.set(pathKey, handler);
            
            // For nested paths, only forward if parent passes
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                const parentKey = this.getParentKeyFromKeyPath(keyPath);
                if (parentKey) {
                    const parentState = this.itemStates.get(parentKey);
                    if (parentState && parentState.passed) {
                        handler(keyPath, key, immutableProps);
                    }
                    // If parent doesn't pass, the remove is silently ignored
                    // (the item was never added to downstream, so no need to remove)
                } else {
                    handler(keyPath, key, immutableProps);
                }
            });
        } else {
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // For mutable properties we're tracking at the scope level
            if (this.mutableProperties.includes(propertyName)) {
                // Only forward if item passes
                this.input.onModified(pathSegments, propertyName, (keyPath, key, oldValue, newValue) => {
                    const itemState = this.itemStates.get(key);
                    if (itemState && itemState.passed) {
                        handler(keyPath, key, oldValue, newValue);
                    }
                });
            } else {
                // For non-mutable properties at scope level, only forward if passes
                this.input.onModified(pathSegments, propertyName, (keyPath, key, oldValue, newValue) => {
                    const itemState = this.itemStates.get(key);
                    if (itemState && itemState.passed) {
                        handler(keyPath, key, oldValue, newValue);
                    }
                });
            }
        } else if (this.isNestedPath(pathSegments)) {
            // Store handler for potential replay
            const pathKey = JSON.stringify(pathSegments);
            if (!this.nestedModifiedHandlers.has(pathKey)) {
                this.nestedModifiedHandlers.set(pathKey, new Map());
            }
            this.nestedModifiedHandlers.get(pathKey)!.set(propertyName, handler);
            
            // For nested paths, only forward if parent passes
            this.input.onModified(pathSegments, propertyName, (keyPath, key, oldValue, newValue) => {
                const parentKey = this.getParentKeyFromKeyPath(keyPath);
                if (parentKey) {
                    const parentState = this.itemStates.get(parentKey);
                    if (parentState && parentState.passed) {
                        handler(keyPath, key, oldValue, newValue);
                    } else {
                        // Queue modification for replay
                        if (!this.pendingNestedModifications.has(parentKey)) {
                            this.pendingNestedModifications.set(parentKey, []);
                        }
                        this.pendingNestedModifications.get(parentKey)!.push({
                            pathSegments, propertyName, keyPath, key, oldValue, newValue
                        });
                    }
                } else {
                    handler(keyPath, key, oldValue, newValue);
                }
            });
        } else {
            // Forward all other modifications
            this.input.onModified(pathSegments, propertyName, handler);
        }
    }

    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}