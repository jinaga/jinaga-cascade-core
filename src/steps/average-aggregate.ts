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
        handler: ModifiedHandler;
    }> = [];
    
    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string
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
        return this.input.getTypeDescriptor();
    }
    
    onAdded(pathSegments: string[], handler: AddedHandler): void {
        this.input.onAdded(pathSegments, handler);
    }
    
    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        this.input.onRemoved(pathSegments, handler);
    }
    
    onModified(pathSegments: string[], handler: ModifiedHandler): void {
        if (this.isParentPath(pathSegments)) {
            // Handler wants modification events at parent level
            // This is the channel for receiving aggregate values
            this.modifiedHandlers.push({
                pathSegments,
                handler
            });
        }
        // Always pass through to input for other property modifications
        this.input.onModified(pathSegments, handler);
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
                // Update sum and count
                const state = this.averageStates.get(parentKeyHash) || { sum: 0, count: 0 };
                state.sum += numValue;
                state.count += 1;
                this.averageStates.set(parentKeyHash, state);
            }
        }
        
        // Compute new average
        const state = this.averageStates.get(parentKeyHash);
        const newAverage = (state && state.count > 0) ? state.sum / state.count : undefined;
        
        // Emit modification event
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, this.propertyName, newAverage);
            });
        } else {
            // Parent is at root level
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', this.propertyName, newAverage);
            });
        }
    }
    
    /**
     * Handle when an item is removed from the target array
     */
    private handleItemRemoved(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Update sum and count if value was numeric
        const value = item[this.numericProperty];
        if (value !== null && value !== undefined) {
            const numValue = Number(value);
            if (!isNaN(numValue)) {
                const state = this.averageStates.get(parentKeyHash);
                if (state) {
                    state.sum -= numValue;
                    state.count -= 1;
                    
                    if (state.count === 0) {
                        this.averageStates.delete(parentKeyHash);
                    } else {
                        this.averageStates.set(parentKeyHash, state);
                    }
                }
            }
        }
        
        // Compute new average
        const state = this.averageStates.get(parentKeyHash);
        const newAverage = (state && state.count > 0) ? state.sum / state.count : undefined;
        
        // Emit modification event
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, this.propertyName, newAverage);
            });
        } else {
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', this.propertyName, newAverage);
            });
        }
    }
}
