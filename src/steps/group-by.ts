import type { AddedHandler, ImmutableProps, RemovedHandler, Step } from '../pipeline';
import { type TypeDescriptor } from '../pipeline';
import { computeGroupKey } from "../util/hash";
import { pathsMatch, pathStartsWith } from "../util/path";

export class GroupByStep<T extends {}, K extends keyof T, ArrayName extends string> implements Step {
    groupAddedHandlers: AddedHandler[] = [];
    itemAddedHandlers: AddedHandler[] = [];
    groupRemovedHandlers: RemovedHandler[] = [];
    itemRemovedHandlers: RemovedHandler[] = [];

    itemKeyToGroupKey: Map<string, string> = new Map<string, string>();
    groupKeyToItemKeys: Map<string, Set<string>> = new Map<string, Set<string>>();
    
    // Maps item key to its parent key path for correct emission
    itemKeyToParentKeyPath: Map<string, string[]> = new Map<string, string[]>();

    constructor(
        private input: Step,
        private groupingProperties: K[],
        private arrayName: ArrayName,
        private scopeSegments: string[]  // Path segments where this groupBy operates
    ) {
        // Register with the input step to receive items at the scope path level
        this.input.onAdded(this.scopeSegments, (keyPath, itemKey, immutableProps) => {
            this.handleAdded(keyPath, itemKey, immutableProps);
        });
        this.input.onRemoved(this.scopeSegments, (keyPath, itemKey, immutableProps) => {
            this.handleRemoved(keyPath, itemKey, immutableProps);
        });
    }

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        
        if (this.scopeSegments.length === 0) {
            // Root level: wrap with the new array
            return {
                arrays: [
                    {
                        name: this.arrayName,
                        type: inputDescriptor  // Items have the input type
                    }
                ]
            };
        } else {
            // Scoped level: navigate to scope and transform there
            return this.transformDescriptorAtPath(inputDescriptor, [...this.scopeSegments]);
        }
    }
    
    /**
     * Transforms the type descriptor at the specified path to add the groupBy result.
     */
    private transformDescriptorAtPath(descriptor: TypeDescriptor, remainingSegments: string[]): TypeDescriptor {
        if (remainingSegments.length === 0) {
            // We're at the target level - wrap with new array
            return {
                arrays: [
                    {
                        name: this.arrayName,
                        type: descriptor
                    }
                ]
            };
        }
        
        const [currentSegment, ...remainingSegmentsAfter] = remainingSegments;
        
        return {
            arrays: descriptor.arrays.map(arrayDesc => {
                if (arrayDesc.name === currentSegment) {
                    return {
                        name: arrayDesc.name,
                        type: this.transformDescriptorAtPath(arrayDesc.type, remainingSegmentsAfter)
                    };
                }
                return arrayDesc;
            })
        };
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
            const scopeAndArraySegments = [...this.scopeSegments, this.arrayName];
            const shiftedSegments = pathSegments.slice(scopeAndArraySegments.length);
            
            // Register interceptor with input at scope segments + shifted segments
            this.input.onAdded([...this.scopeSegments, ...shiftedSegments], (notifiedKeyPath, itemKey, immutableProps) => {
                // notifiedKeyPath is relative to scopeSegments, element at scopeSegments.length is the item key
                const itemKeyAtScope = notifiedKeyPath[this.scopeSegments.length];
                const groupKey = this.itemKeyToGroupKey.get(itemKeyAtScope);
                if (groupKey === undefined) {
                    throw new Error(`GroupByStep: item with key "${itemKeyAtScope}" not found when handling nested path addition notification`);
                }
                // Insert groupKey at the correct position
                const modifiedKeyPath = [
                    ...notifiedKeyPath.slice(0, this.scopeSegments.length),
                    groupKey,
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
            const scopeAndArraySegments = [...this.scopeSegments, this.arrayName];
            const shiftedSegments = pathSegments.slice(scopeAndArraySegments.length);
            
            // Register interceptor with input at scope segments + shifted segments
            this.input.onRemoved([...this.scopeSegments, ...shiftedSegments], (notifiedKeyPath, itemKey, immutableProps) => {
                const itemKeyAtScope = notifiedKeyPath[this.scopeSegments.length];
                const groupKey = this.itemKeyToGroupKey.get(itemKeyAtScope);
                if (groupKey === undefined) {
                    throw new Error(`GroupByStep: item with key "${itemKeyAtScope}" not found when handling nested path removal notification`);
                }
                const modifiedKeyPath = [
                    ...notifiedKeyPath.slice(0, this.scopeSegments.length),
                    groupKey,
                    ...notifiedKeyPath.slice(this.scopeSegments.length)
                ];
                handler(modifiedKeyPath, itemKey, immutableProps);
            });
        } else {
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], handler: (keyPath: string[], key: string, name: string, value: any) => void): void {
        if (this.isAtGroupLevel(pathSegments)) {
            // The group level is immutable
        } else if (this.isAtItemLevel(pathSegments) || this.isBelowItemLevel(pathSegments)) {
            // Shift the path appropriately
            const scopeAndArraySegments = [...this.scopeSegments, this.arrayName];
            const shiftedSegments = pathSegments.slice(scopeAndArraySegments.length);
            this.input.onModified([...this.scopeSegments, ...shiftedSegments], (notifiedKeyPath, itemKey, name, value) => {
                const itemKeyAtScope = notifiedKeyPath[this.scopeSegments.length];
                const groupKey = this.itemKeyToGroupKey.get(itemKeyAtScope);
                if (groupKey === undefined) {
                    throw new Error(`GroupByStep: item with key "${itemKeyAtScope}" not found when handling nested path modification notification`);
                }
                const modifiedKeyPath = [
                    ...notifiedKeyPath.slice(0, this.scopeSegments.length),
                    groupKey,
                    ...notifiedKeyPath.slice(this.scopeSegments.length)
                ];
                handler(modifiedKeyPath, itemKey, name, value);
            });
        } else {
            this.input.onModified(pathSegments, handler);
        }
    }

    /**
     * Checks if pathSegments is at the group level (same as scopeSegments)
     */
    private isAtGroupLevel(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
    
    /**
     * Checks if pathSegments is at the item level (scopeSegments + arrayName)
     */
    private isAtItemLevel(pathSegments: string[]): boolean {
        const itemSegmentPath = [...this.scopeSegments, this.arrayName];
        return pathsMatch(pathSegments, itemSegmentPath);
    }
    
    /**
     * Checks if pathSegments is below the item level
     */
    private isBelowItemLevel(pathSegments: string[]): boolean {
        const itemSegmentPath = [...this.scopeSegments, this.arrayName];
        return pathSegments.length > itemSegmentPath.length && pathStartsWith(pathSegments, itemSegmentPath);
    }

    private handleAdded(keyPath: string[], itemKey: string, immutableProps: ImmutableProps) {
        // keyPath is the runtime key path at the scope level - store it for emissions
        const parentKeyPath = keyPath;
        this.itemKeyToParentKeyPath.set(itemKey, parentKeyPath);
        
        // Extract the grouping property values from the object
        let groupingValues: ImmutableProps = {};
        Object.keys(immutableProps).forEach(prop => {
            if (this.groupingProperties.includes(prop as K)) {
                groupingValues[prop] = immutableProps[prop];
            }
        });
        // Compute the group key from the extracted values
        const groupKey = computeGroupKey(groupingValues, this.groupingProperties.map(prop => prop.toString()));
        
        // Store item-to-group mapping
        this.itemKeyToGroupKey.set(itemKey, groupKey);
        
        // Add item key to group's set
        const isNewGroup = !this.groupKeyToItemKeys.has(groupKey);
        if (isNewGroup) {
            this.groupKeyToItemKeys.set(groupKey, new Set<string>());
            // Notify the group handlers of the new group object at the parent key path
                this.groupAddedHandlers.forEach(handler => handler(parentKeyPath, groupKey, groupingValues));
        }
        this.groupKeyToItemKeys.get(groupKey)!.add(itemKey);
        
        // Extract the non-grouping properties from the object
        let nonGroupingProps: ImmutableProps = {};
        Object.keys(immutableProps).forEach(prop => {
            if (!this.groupingProperties.includes(prop as K)) {
                nonGroupingProps[prop] = immutableProps[prop];
            }
        });
        // Notify the item handlers of the new item object at parent key path + groupKey
        this.itemAddedHandlers.forEach(handler => handler([...parentKeyPath, groupKey], itemKey, nonGroupingProps));
    }

    private handleRemoved(keyPath: string[], itemKey: string, immutableProps: ImmutableProps) {
        // Get the parent key path for this item key
        const parentKeyPath = this.itemKeyToParentKeyPath.get(itemKey) || keyPath;
        
        // Look up group key
        const groupKey = this.itemKeyToGroupKey.get(itemKey);
        if (groupKey === undefined) {
            throw new Error(`GroupByStep: item with key "${itemKey}" not found`);
        }
        
        // Extract the non-grouping properties from the object for item handlers
        let nonGroupingProps: ImmutableProps = {};
        Object.keys(immutableProps).forEach(prop => {
            if (!this.groupingProperties.includes(prop as K)) {
                nonGroupingProps[prop] = immutableProps[prop];
            }
        });
        
        // Notify item removed handlers at parent key path + groupKey
        this.itemRemovedHandlers.forEach(handler => handler([...parentKeyPath, groupKey], itemKey, nonGroupingProps));
        
        // Remove item key from tracking
        this.itemKeyToGroupKey.delete(itemKey);
        this.itemKeyToParentKeyPath.delete(itemKey);
        
        // Remove item key from group's set
        const itemKeys = this.groupKeyToItemKeys.get(groupKey);
        if (itemKeys) {
            itemKeys.delete(itemKey);
            
            // Check if group is empty
            if (itemKeys.size === 0) {
                // Extract the grouping property values from the object for group handlers
                let groupingValues: ImmutableProps = {};
                Object.keys(immutableProps).forEach(prop => {
                    if (this.groupingProperties.includes(prop as K)) {
                        groupingValues[prop] = immutableProps[prop];
                    }
                });
                
                // Notify group removed handlers at parent key path
                this.groupRemovedHandlers.forEach(handler => handler(parentKeyPath, groupKey, groupingValues));
                
                // Clean up tracking
                this.groupKeyToItemKeys.delete(groupKey);
            }
        }
    }
}

