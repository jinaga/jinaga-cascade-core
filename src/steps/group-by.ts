import type { AddedHandler, BuildContext, BuiltStepGraph, DescriptorNode, ImmutableProps, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';
import { computeGroupKey } from "../util/hash.js";
import { pathsMatch, pathStartsWith } from "../util/path.js";
import { emptyDescriptorNode } from '../util/descriptor-transform.js';

function transformDescriptorAtPathWithParentName(
    descriptor: DescriptorNode,
    remainingSegments: string[],
    groupingProperties: string[],
    parentArrayName: string,
    childArrayName: string
): DescriptorNode {
    if (remainingSegments.length === 0) {
        return descriptor;
    }

    const [currentSegment, ...remainingSegmentsAfter] = remainingSegments;

    return {
        ...descriptor,
        arrays: descriptor.arrays.map(arrayDesc => {
            if (arrayDesc.name !== currentSegment) {
                return arrayDesc;
            }

            if (remainingSegmentsAfter.length === 0) {
                const groupingKey = groupingProperties;
                const parentScalars = arrayDesc.type.scalars.filter(s => groupingKey.includes(s.name));
                const childScalars = arrayDesc.type.scalars.filter(s => !groupingKey.includes(s.name));

                return {
                    name: parentArrayName,
                    type: {
                        ...emptyDescriptorNode(),
                        collectionKey: groupingProperties,
                        scalars: parentScalars,
                        arrays: [
                            {
                                name: childArrayName,
                                type: {
                                    ...arrayDesc.type,
                                    scalars: childScalars,
                                    collectionKey: arrayDesc.type.collectionKey.filter(k => !groupingKey.includes(k))
                                }
                            }
                        ]
                    }
                };
            }

            return {
                name: arrayDesc.name,
                type: transformDescriptorAtPathWithParentName(
                    arrayDesc.type,
                    remainingSegmentsAfter,
                    groupingProperties,
                    parentArrayName,
                    childArrayName
                )
            };
        })
    };
}

function transformGroupByDescriptor(
    inputDescriptor: TypeDescriptor,
    groupingProperties: string[],
    parentArrayName: string,
    childArrayName: string,
    scopeSegments: string[]
): TypeDescriptor {
    const groupingKey = groupingProperties;
    const parentScalars = inputDescriptor.scalars.filter(s => groupingKey.includes(s.name));
    const childScalars = inputDescriptor.scalars.filter(s => !groupingKey.includes(s.name));

    if (scopeSegments.length === 0) {
        const childDescriptor: DescriptorNode = {
            ...inputDescriptor,
            scalars: childScalars,
            collectionKey: inputDescriptor.collectionKey.filter(k => !groupingKey.includes(k))
        };

        return {
            rootCollectionName: parentArrayName,
            collectionKey: groupingKey,
            scalars: parentScalars,
            arrays: [
                {
                    name: childArrayName,
                    type: childDescriptor
                }
            ],
            mutableProperties: [...inputDescriptor.mutableProperties],
            objects: [...inputDescriptor.objects]
        };
    }

    return {
        ...transformDescriptorAtPathWithParentName(
            inputDescriptor,
            [...scopeSegments],
            groupingProperties,
            parentArrayName,
            childArrayName
        ),
        rootCollectionName: inputDescriptor.rootCollectionName,
        mutableProperties: [...inputDescriptor.mutableProperties],
        objects: [...inputDescriptor.objects]
    };
}

export class GroupByStep<
    T extends object,
    K extends keyof T,
    ParentArrayName extends string,
    ChildArrayName extends string = ParentArrayName
> implements Step {
    /**
     * Item-level state keyed by input item key.
     * This is the single source of truth for per-item grouping placement.
     */
    private itemStates: Map<string, {
        parentKeyPath: string[];
        groupKey: string;
        compositeKey: string;
        immutableProps: ImmutableProps;
        groupingValues: ImmutableProps;
    }> = new Map();

    groupAddedHandlers: AddedHandler[] = [];
    itemAddedHandlers: AddedHandler[] = [];
    groupRemovedHandlers: RemovedHandler[] = [];
    itemRemovedHandlers: RemovedHandler[] = [];
    // Maps composite key (parent path + group key) to item keys - tracks groups per parent context
    groupKeyToItemKeys: Map<string, Set<string>> = new Map<string, Set<string>>();

    private readonly childArrayName: ChildArrayName;
    constructor(
        private input: Step,
        private groupingProperties: K[],
        private parentArrayName: ParentArrayName,
        childArrayName: ChildArrayName,
        private scopeSegments: string[],  // Path segments where this groupBy operates
        inputTypeDescriptor: TypeDescriptor
    ) {
        this.childArrayName = childArrayName;

        // Register with the input step to receive items at the scope path level
        this.input.onAdded(this.scopeSegments, (keyPath, itemKey, immutableProps) => {
            this.handleAdded(keyPath, itemKey, immutableProps);
        });
        this.input.onRemoved(this.scopeSegments, (keyPath, itemKey, immutableProps) => {
            this.handleRemoved(keyPath, itemKey, immutableProps);
        });
        
        // Check if any grouping properties are mutable and register for changes
        const mutableProperties = inputTypeDescriptor.mutableProperties;
        
        for (const groupProp of this.groupingProperties) {
            const propName = groupProp.toString();
            if (mutableProperties.includes(propName)) {
                // This grouping property is mutable - register for changes
                this.input.onModified(this.scopeSegments, propName, (keyPath, key, oldValue, newValue) => {
                    this.handleGroupingPropertyChange(keyPath, key, propName, oldValue, newValue);
                });
            }
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        // Check if pathSegments matches our scope + group level
        if (this.isAtGroupLevel(pathSegments)) {
            // Handler is at the group level (scope segments)
            this.groupAddedHandlers.push(handler);
        } else if (this.isAtItemLevel(pathSegments)) {
            // Handler is at the item level (scope segments + arrayName)
            this.itemAddedHandlers.push(handler);
        } else if (this.isBelowItemLevel(pathSegments)) {
            // Handler is below this array in the tree
            const itemSegmentPath = this.getItemLevelSegments();
            const shiftedSegments = pathSegments.slice(itemSegmentPath.length);
            
            // Register interceptor with input at scope segments + shifted segments
            this.input.onAdded([...this.scopeSegments, ...shiftedSegments], (notifiedKeyPath, itemKey, immutableProps) => {
                // notifiedKeyPath is relative to scopeSegments, element at scopeSegments.length is the item key
                const itemKeyAtScope = notifiedKeyPath[this.scopeSegments.length];
                const itemState = this.itemStates.get(itemKeyAtScope);
                if (!itemState) {
                    throw new Error(`GroupByStep: item with key "${itemKeyAtScope}" not found when handling nested path addition notification`);
                }
                // Insert groupKey at the correct position
                const modifiedKeyPath = [
                    ...notifiedKeyPath.slice(0, this.scopeSegments.length),
                    itemState.groupKey,
                    ...notifiedKeyPath.slice(this.scopeSegments.length)
                ];
                handler(modifiedKeyPath, itemKey, immutableProps);
            });
        } else {
            this.input.onAdded(pathSegments, handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isAtGroupLevel(pathSegments)) {
            // Handler is at the group level
            this.groupRemovedHandlers.push(handler);
        } else if (this.isAtItemLevel(pathSegments)) {
            // Handler is at the item level
            this.itemRemovedHandlers.push(handler);
        } else if (this.isBelowItemLevel(pathSegments)) {
            // Handler is below this array in the tree
            const itemSegmentPath = this.getItemLevelSegments();
            const shiftedSegments = pathSegments.slice(itemSegmentPath.length);
            
            // Register interceptor with input at scope segments + shifted segments
            this.input.onRemoved([...this.scopeSegments, ...shiftedSegments], (notifiedKeyPath, itemKey, immutableProps) => {
                const itemKeyAtScope = notifiedKeyPath[this.scopeSegments.length];
                const itemState = this.itemStates.get(itemKeyAtScope);
                if (!itemState) {
                    throw new Error(`GroupByStep: item with key "${itemKeyAtScope}" not found when handling nested path removal notification`);
                }
                const modifiedKeyPath = [
                    ...notifiedKeyPath.slice(0, this.scopeSegments.length),
                    itemState.groupKey,
                    ...notifiedKeyPath.slice(this.scopeSegments.length)
                ];
                handler(modifiedKeyPath, itemKey, immutableProps);
            });
        } else {
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], propertyName: string, handler: (keyPath: string[], key: string, oldValue: unknown, newValue: unknown) => void): void {
        if (this.isAtGroupLevel(pathSegments)) {
            // The group level is immutable - however, if the grouping property is mutable,
            // we handle it via handleGroupingPropertyChange registered in constructor
        } else if (this.isAtItemLevel(pathSegments) || this.isBelowItemLevel(pathSegments)) {
            // Shift the path appropriately
            const itemSegmentPath = this.getItemLevelSegments();
            const shiftedSegments = pathSegments.slice(itemSegmentPath.length);
            this.input.onModified([...this.scopeSegments, ...shiftedSegments], propertyName, (notifiedKeyPath, itemKey, oldValue, newValue) => {
                // For root level (scopeSegments=[]), the itemKey is the key parameter
                // For nested levels, extract from the key path
                const itemKeyAtScope = this.scopeSegments.length === 0
                    ? (notifiedKeyPath.length > 0 ? notifiedKeyPath[0] : itemKey)
                    : notifiedKeyPath[this.scopeSegments.length];
                    
                const itemState = this.itemStates.get(itemKeyAtScope);
                if (!itemState) {
                    // Item not yet tracked - this can happen during initial add when onModified
                    // fires before onAdded chain completes. Skip forwarding in this case.
                    // The event will be properly delivered once the item is added and tracked.
                    return;
                }
                const modifiedKeyPath = [
                    ...notifiedKeyPath.slice(0, this.scopeSegments.length),
                    itemState.groupKey,
                    ...notifiedKeyPath.slice(this.scopeSegments.length)
                ];
                handler(modifiedKeyPath, itemKey, oldValue, newValue);
            });
        } else {
            this.input.onModified(pathSegments, propertyName, handler);
        }
    }

    /**
     * Checks if pathSegments is at the group level (same as scopeSegments)
     */
    private isAtGroupLevel(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.getGroupLevelSegments());
    }
    
    /**
     * Checks if pathSegments is at the item level (scopeSegments + arrayName)
     */
    private isAtItemLevel(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.getItemLevelSegments());
    }
    
    /**
     * Checks if pathSegments is below the item level
     */
    private isBelowItemLevel(pathSegments: string[]): boolean {
        const itemSegmentPath = this.getItemLevelSegments();
        return pathSegments.length > itemSegmentPath.length && pathStartsWith(pathSegments, itemSegmentPath);
    }

    private getGroupLevelSegments(): string[] {
        if (this.scopeSegments.length > 0) {
            return [...this.scopeSegments.slice(0, -1), this.parentArrayName];
        }
        return [...this.scopeSegments];
    }

    private getItemLevelSegments(): string[] {
        return [...this.getGroupLevelSegments(), this.childArrayName];
    }

    /**
     * Creates a composite key that uniquely identifies a group within its parent context.
     * This ensures that the same grouping value (e.g., c: 'C1') creates separate groups
     * when they appear under different parent paths (e.g., B1 vs B2).
     */
    private getCompositeGroupKey(parentKeyPath: string[], groupKey: string): string {
        return JSON.stringify([...parentKeyPath, groupKey]);
    }

    /**
     * Handle when a mutable grouping property changes - re-group the item if necessary
     */
    private handleGroupingPropertyChange(keyPath: string[], key: string, propertyName: string, _oldValue: unknown, newValue: unknown): void {
        // Find the item - key is the item key at the scope level
        const itemKey = keyPath.length > 0 ? keyPath[keyPath.length - 1] : key;
        
        const itemState = this.itemStates.get(itemKey);
        if (!itemState) {
            return; // Item not tracked
        }
        
        // Get the current grouping values and update with new value
        const currentGroupingValues = itemState.groupingValues;
        const oldGroupingValues = { ...currentGroupingValues };
        const newGroupingValues = { ...currentGroupingValues, [propertyName]: newValue };
        
        // Compute old and new group keys
        const oldGroupKey = computeGroupKey(oldGroupingValues, this.groupingProperties.map(prop => prop.toString()));
        const newGroupKey = computeGroupKey(newGroupingValues, this.groupingProperties.map(prop => prop.toString()));
        
        // If the group key hasn't changed, no re-grouping needed
        if (oldGroupKey === newGroupKey) {
            // Just update the stored grouping values
            itemState.groupingValues = newGroupingValues;
            return;
        }
        
        // Re-group the item: remove from old group, add to new group
        const parentKeyPath = itemState.parentKeyPath;
        const oldCompositeKey = itemState.compositeKey;
        const newCompositeKey = this.getCompositeGroupKey(parentKeyPath, newGroupKey);
        
        // Get the non-grouping properties for item handlers
        const fullImmutableProps = itemState.immutableProps;
        const nonGroupingProps: ImmutableProps = {};
        Object.keys(fullImmutableProps).forEach(prop => {
            if (!this.groupingProperties.includes(prop as K)) {
                nonGroupingProps[prop] = fullImmutableProps[prop];
            }
        });
        
        // 1. Remove item from old group
        this.itemRemovedHandlers.forEach(handler => handler([...parentKeyPath, oldGroupKey], itemKey, nonGroupingProps));
        
        const oldGroupItems = this.groupKeyToItemKeys.get(oldCompositeKey);
        if (oldGroupItems) {
            oldGroupItems.delete(itemKey);
            
            // If old group is now empty, remove it
            if (oldGroupItems.size === 0) {
                this.groupRemovedHandlers.forEach(handler => handler(parentKeyPath, oldGroupKey, oldGroupingValues));
                this.groupKeyToItemKeys.delete(oldCompositeKey);
            }
        }
        
        // 2. Add item to new group
        const isNewGroup = !this.groupKeyToItemKeys.has(newCompositeKey);
        if (isNewGroup) {
            this.groupKeyToItemKeys.set(newCompositeKey, new Set<string>());
            // Notify group handlers of the new group
            this.groupAddedHandlers.forEach(handler => handler(parentKeyPath, newGroupKey, newGroupingValues));
        }
        this.groupKeyToItemKeys.get(newCompositeKey)!.add(itemKey);
        
        // Update item's group mapping
        itemState.groupKey = newGroupKey;
        itemState.compositeKey = newCompositeKey;
        itemState.groupingValues = newGroupingValues;
        
        // Notify item handlers of the addition to new group
        this.itemAddedHandlers.forEach(handler => handler([...parentKeyPath, newGroupKey], itemKey, nonGroupingProps));
    }

    private handleAdded(keyPath: string[], itemKey: string, immutableProps: ImmutableProps) {
        // keyPath is the runtime key path at the scope level - store it for emissions
        const parentKeyPath = keyPath;
        
        // Extract the grouping property values from the object
        const groupingValues: ImmutableProps = {};
        Object.keys(immutableProps).forEach(prop => {
            if (this.groupingProperties.includes(prop as K)) {
                groupingValues[prop] = immutableProps[prop];
            }
        });
        
        // Compute the group key from the extracted values
        const groupKey = computeGroupKey(groupingValues, this.groupingProperties.map(prop => prop.toString()));
        
        // Create composite key that includes parent context for proper group tracking
        const compositeKey = this.getCompositeGroupKey(parentKeyPath, groupKey);
        
        this.itemStates.set(itemKey, {
            parentKeyPath,
            groupKey,
            compositeKey,
            immutableProps,
            groupingValues
        });
        
        // Add item key to group's set - use composite key to track per-parent groups
        const isNewGroup = !this.groupKeyToItemKeys.has(compositeKey);
        if (isNewGroup) {
            this.groupKeyToItemKeys.set(compositeKey, new Set<string>());
            // Notify the group handlers of the new group object at the parent key path
            this.groupAddedHandlers.forEach(handler => handler(parentKeyPath, groupKey, groupingValues));
        }
        this.groupKeyToItemKeys.get(compositeKey)!.add(itemKey);
        
        // Extract the non-grouping properties from the object
        const nonGroupingProps: ImmutableProps = {};
        Object.keys(immutableProps).forEach(prop => {
            if (!this.groupingProperties.includes(prop as K)) {
                nonGroupingProps[prop] = immutableProps[prop];
            }
        });
        // Notify the item handlers of the new item object at parent key path + groupKey
        this.itemAddedHandlers.forEach(handler => handler([...parentKeyPath, groupKey], itemKey, nonGroupingProps));
    }

    private handleRemoved(keyPath: string[], itemKey: string, _immutableProps: ImmutableProps) {
        const itemState = this.itemStates.get(itemKey);
        if (!itemState) {
            throw new Error(`GroupByStep: item with key "${itemKey}" not found`);
        }
        const parentKeyPath = itemState.parentKeyPath.length > 0 ? itemState.parentKeyPath : keyPath;
        const groupKey = itemState.groupKey;
        const compositeKey = itemState.compositeKey;
        
        // Extract the non-grouping properties from the tracked immutable props.
        const nonGroupingProps: ImmutableProps = {};
        Object.keys(itemState.immutableProps).forEach(prop => {
            if (!this.groupingProperties.includes(prop as K)) {
                nonGroupingProps[prop] = itemState.immutableProps[prop];
            }
        });
        
        // Notify item removed handlers at parent key path + groupKey
        this.itemRemovedHandlers.forEach(handler => handler([...parentKeyPath, groupKey], itemKey, nonGroupingProps));
        
        // Remove item key from tracking
        this.itemStates.delete(itemKey);
        
        // Remove item key from group's set - use composite key for per-parent tracking
        const itemKeys = this.groupKeyToItemKeys.get(compositeKey);
        if (itemKeys) {
            itemKeys.delete(itemKey);
            
            // Check if group is empty
            if (itemKeys.size === 0) {
                // Notify group removed handlers at parent key path
                this.groupRemovedHandlers.forEach(handler => handler(parentKeyPath, groupKey, itemState.groupingValues));
                
                // Clean up tracking
                this.groupKeyToItemKeys.delete(compositeKey);
            }
        }
    }
}

export class GroupByBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private groupingProperties: string[],
        private parentArrayName: string,
        private childArrayName: string,
        private scopeSegments: string[]
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        return transformGroupByDescriptor(
            this.upstream.getTypeDescriptor(),
            this.groupingProperties,
            this.parentArrayName,
            this.childArrayName,
            this.scopeSegments
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new GroupByStep<Record<string, unknown>, string, string, string>(
                up.lastStep,
                this.groupingProperties,
                this.parentArrayName,
                this.childArrayName,
                this.scopeSegments,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}

