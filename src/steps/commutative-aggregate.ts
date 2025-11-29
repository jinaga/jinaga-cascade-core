import type { AddedHandler, ImmutableProps, ModifiedHandler, RemovedHandler, Step, TypeDescriptor } from '../pipeline';

/**
 * Operator called when an item is added to the aggregated array.
 * 
 * @param currentAggregate - The current aggregate value, or undefined if this is the first item
 * @param item - The immutable properties of the item being added
 * @returns The new aggregate value
 */
export type AddOperator<TItem, TAggregate> = (
    currentAggregate: TAggregate | undefined,
    item: TItem
) => TAggregate;

/**
 * Operator called when an item is removed from the aggregated array.
 * 
 * @param currentAggregate - The current aggregate value (never undefined since an item must exist to be removed)
 * @param item - The immutable properties of the item being removed
 * @returns The new aggregate value
 */
export type SubtractOperator<TItem, TAggregate> = (
    currentAggregate: TAggregate,
    item: TItem
) => TAggregate;

/**
 * Configuration for the commutative aggregate operation.
 */
interface CommutativeAggregateConfig<TItem, TAggregate> {
    /** Operator called when an item is added */
    add: AddOperator<TItem, TAggregate>;
    
    /** Operator called when an item is removed */
    subtract: SubtractOperator<TItem, TAggregate>;
}

/**
 * Computes a hash key for a key path (for map lookups).
 */
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

/**
 * A step that computes an aggregate value over items in a nested array.
 *
 * This step:
 * 1. Registers for add/remove events at the target array level
 * 2. Maintains aggregate state keyed by parent path
 * 3. Emits onModified events when the aggregate changes
 * 4. Transforms the type by replacing the array with the aggregate property
 *
 * **IMPORTANT: Event Channel Separation**
 * - `onAdded`/`onRemoved` pass through immutable properties ONLY (no aggregate)
 * - `onModified` is the ONLY channel for communicating aggregate values
 * - This follows the system pattern: mutable/computed properties use onModified
 *
 * @template TInput - The input type to the step
 * @template TPath - The tuple of array name segments forming the path to the target array
 * @template TPropertyName - The name of the new aggregate property
 * @template TAggregate - The type of the aggregate value
 */
export class CommutativeAggregateStep<
    TInput,
    TPath extends string[],
    TPropertyName extends string,
    TAggregate
> implements Step {
    
    /** Maps parent key path hash to current aggregate value */
    private aggregateValues: Map<string, TAggregate> = new Map();
    
    /** Maps parent key path hash to count of items (for cleanup tracking) */
    private itemCounts: Map<string, number> = new Map();
    
    /** Handlers for modified events at various levels */
    private modifiedHandlers: Array<{
        pathSegments: string[];
        handler: ModifiedHandler;
    }> = [];
    
    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private config: CommutativeAggregateConfig<ImmutableProps, TAggregate>
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
        // keyPath contains the runtime keys leading to this item
        // For segmentPath ['cities', 'venues'], keyPath might be ['hash_TX', 'hash_Dallas']
        
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Track item count for cleanup
        const currentCount = this.itemCounts.get(parentKeyHash) ?? 0;
        this.itemCounts.set(parentKeyHash, currentCount + 1);
        
        // Compute new aggregate
        const currentAggregate = this.aggregateValues.get(parentKeyHash);
        const newAggregate = this.config.add(currentAggregate, item);
        this.aggregateValues.set(parentKeyHash, newAggregate);
        
        // Emit modification event
        // The parent key is the last element of parentKeyPath
        // The key path to the parent is everything before that
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, this.propertyName, newAggregate);
            });
        } else {
            // Parent is at root level - edge case
            // In this case, modifiedHandlers at root level would receive updates
            // But this scenario should be handled differently based on the design
            // For now, we'll emit to handlers registered at root
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', this.propertyName, newAggregate);
            });
        }
    }
    
    /**
     * Handle when an item is removed from the target array
     */
    private handleItemRemoved(keyPath: string[], itemKey: string, item: ImmutableProps): void {
        const parentKeyPath = keyPath;
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        
        // Get current aggregate
        const currentAggregate = this.aggregateValues.get(parentKeyHash);
        if (currentAggregate === undefined) {
            throw new Error(`No aggregate value for parent ${parentKeyHash}`);
        }
        
        // Compute new aggregate
        const newAggregate = this.config.subtract(currentAggregate, item);
        
        // Update item count and clean up if no items remain
        const currentCount = this.itemCounts.get(parentKeyHash) ?? 0;
        const newCount = currentCount - 1;
        
        if (newCount > 0) {
            this.itemCounts.set(parentKeyHash, newCount);
            this.aggregateValues.set(parentKeyHash, newAggregate);
        } else {
            this.itemCounts.delete(parentKeyHash);
            this.aggregateValues.delete(parentKeyHash);
        }
        
        // Emit modification event
        if (parentKeyPath.length > 0) {
            const parentKey = parentKeyPath[parentKeyPath.length - 1];
            const keyPathToParent = parentKeyPath.slice(0, -1);
            
            this.modifiedHandlers.forEach(({ handler }) => {
                handler(keyPathToParent, parentKey, this.propertyName, newAggregate);
            });
        } else {
            this.modifiedHandlers.forEach(({ handler }) => {
                handler([], '', this.propertyName, newAggregate);
            });
        }
    }
}