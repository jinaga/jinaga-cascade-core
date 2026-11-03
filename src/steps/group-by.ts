import type { AddedHandler, BuildContext, BuiltStepGraph, DescriptorNode, ImmutableProps, ModifiedHandler, PlacedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';
import { canonicalizeGroupingProperties, computeChildKey, computeGroupKey } from "../util/hash.js";
import { pathsMatch, pathStartsWith } from "../util/path.js";
import { emptyDescriptorNode, updateNodeAt } from '../util/descriptor-transform.js';
import { getMutablePropertiesOfArrayItems } from '../pipeline.js';

/**
 * Splits a level's items into groups of them. A group holds only its grouping values, which
 * never change. The items keep their other properties, arrays and objects.
 *
 * Groups never move: a group's key includes its parent's key. An item moves to another group
 * when one of its grouping values changes, or when the item it is grouped within moves.
 */
function groupItems(
    items: DescriptorNode,
    groupingProperties: string[],
    childArrayName: string,
    itemsMove: boolean
): DescriptorNode {
    const grouping = new Set(groupingProperties);
    const groupingValueMutable = groupingProperties.some(p => items.mutableProperties.includes(p));
    return {
        ...emptyDescriptorNode(),
        collectionKey: groupingProperties,
        scalars: items.scalars.filter(s => grouping.has(s.name)),
        arrays: [
            {
                name: childArrayName,
                type: {
                    arrays: items.arrays,
                    collectionKey: items.collectionKey.filter(k => !grouping.has(k)),
                    scalars: items.scalars.filter(s => !grouping.has(s.name)),
                    objects: items.objects,
                    mutableProperties: items.mutableProperties.filter(p => !grouping.has(p))
                },
                mutablePlacement: groupingValueMutable || itemsMove
            }
        ]
    };
}

function transformGroupByDescriptor(
    inputDescriptor: TypeDescriptor,
    groupingProperties: string[],
    parentArrayName: string,
    childArrayName: string,
    scopeSegments: string[]
): TypeDescriptor {
    if (scopeSegments.length === 0) {
        return {
            ...groupItems(inputDescriptor, groupingProperties, childArrayName, false),
            rootCollectionName: parentArrayName
        };
    }

    const groupedArrayName = scopeSegments[scopeSegments.length - 1];
    return updateNodeAt(inputDescriptor, scopeSegments.slice(0, -1), node => ({
        ...node,
        arrays: node.arrays.map(array => array.name !== groupedArrayName ? array : {
            name: parentArrayName,
            type: groupItems(array.type, groupingProperties, childArrayName, array.mutablePlacement),
            mutablePlacement: false
        })
    }));
}

interface TrackedItem {
    /** Placement of the input item: its parent at the scope level, undefined at the root. */
    parentKey: string | undefined;
    groupingValues: ImmutableProps;
}

/**
 * Groups items at a scope by the values of the grouping properties.
 *
 * A group's key is derived from its parent and its grouping values, so it is unique within
 * its level. An item's group is its placement. When a grouping value or the item's own
 * placement changes, the item moves to another group with a single `onPlaced` event. Its
 * values and descendants are unaffected, so nothing is re-emitted below the item level.
 */
export class GroupByStep<
    T extends object,
    K extends keyof T,
    ParentArrayName extends string,
    ChildArrayName extends string = ParentArrayName
> implements Step {
    private readonly groupAddedHandlers: AddedHandler[] = [];
    private readonly groupRemovedHandlers: RemovedHandler[] = [];
    private readonly itemAddedHandlers: AddedHandler[] = [];
    private readonly itemRemovedHandlers: RemovedHandler[] = [];
    private readonly itemPlacedHandlers: PlacedHandler[] = [];

    private readonly trackedItems = new Map<string, TrackedItem>();
    /** Number of members of each group, by group key. */
    private readonly groupSizes = new Map<string, number>();

    private readonly groupingPropertyNames: string[];
    private readonly childArrayName: ChildArrayName;

    constructor(
        private input: Step,
        groupingProperties: K[],
        private parentArrayName: ParentArrayName,
        childArrayName: ChildArrayName,
        private scopeSegments: string[],
        inputTypeDescriptor: TypeDescriptor
    ) {
        this.groupingPropertyNames = groupingProperties.map(prop => prop.toString());
        this.childArrayName = childArrayName;

        this.input.onAdded(this.scopeSegments, (parentKey, itemKey, immutableProps) => {
            this.handleAdded(parentKey, itemKey, immutableProps);
        });
        this.input.onRemoved(this.scopeSegments, (itemKey, immutableProps) => {
            this.handleRemoved(itemKey, immutableProps);
        });
        if (this.scopeSegments.length > 0) {
            this.input.onPlaced(this.scopeSegments, (itemKey, _oldParentKey, newParentKey) => {
                this.handleItemPlaced(itemKey, newParentKey);
            });
        }

        for (const propName of this.groupingPropertyNames) {
            if (getMutablePropertiesOfArrayItems(inputTypeDescriptor, this.scopeSegments).includes(propName)) {
                this.input.onModified(this.scopeSegments, propName, (itemKey, _oldValue, newValue) => {
                    this.handleGroupingPropertyChange(itemKey, propName, newValue);
                });
            }
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (this.isAtGroupLevel(pathSegments)) {
            this.groupAddedHandlers.push(handler);
        } else if (this.isAtItemLevel(pathSegments)) {
            this.itemAddedHandlers.push(handler);
        } else {
            this.input.onAdded(this.toInputPath(pathSegments), handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isAtGroupLevel(pathSegments)) {
            this.groupRemovedHandlers.push(handler);
        } else if (this.isAtItemLevel(pathSegments)) {
            this.itemRemovedHandlers.push(handler);
        } else {
            this.input.onRemoved(this.toInputPath(pathSegments), handler);
        }
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (this.isAtGroupLevel(pathSegments)) {
            // A group's values are its grouping values, which never change for a given group.
            return;
        }
        if (this.isAtItemLevel(pathSegments) && this.groupingPropertyNames.includes(propertyName)) {
            // Grouping values belong to the group; a change moves the item instead.
            return;
        }
        this.input.onModified(this.toInputPath(pathSegments), propertyName, handler);
    }

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        if (this.isAtGroupLevel(pathSegments)) {
            // A group's key includes its parent, so a group never moves.
            return;
        }
        if (this.isAtItemLevel(pathSegments)) {
            this.itemPlacedHandlers.push(handler);
            return;
        }
        this.input.onPlaced(this.toInputPath(pathSegments), handler);
    }

    /** Maps an output path at or below the item level to the input path. */
    private toInputPath(pathSegments: string[]): string[] {
        const itemLevel = this.getItemLevelSegments();
        if (pathSegments.length >= itemLevel.length && pathStartsWith(pathSegments, itemLevel)) {
            return [...this.scopeSegments, ...pathSegments.slice(itemLevel.length)];
        }
        return pathSegments;
    }

    private isAtGroupLevel(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.getGroupLevelSegments());
    }

    private isAtItemLevel(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.getItemLevelSegments());
    }

    private getGroupLevelSegments(): string[] {
        // At the root scope the groups are the new root level.
        if (this.scopeSegments.length === 0) {
            return [];
        }
        return [...this.scopeSegments.slice(0, -1), this.parentArrayName];
    }

    private getItemLevelSegments(): string[] {
        return [...this.getGroupLevelSegments(), this.childArrayName];
    }

    private groupKeyOf(item: TrackedItem): string {
        if (item.parentKey === undefined) {
            return computeGroupKey(item.groupingValues, this.groupingPropertyNames);
        }
        return computeChildKey(item.parentKey, canonicalizeGroupingProperties(item.groupingValues, this.groupingPropertyNames));
    }

    private pickGroupingValues(props: ImmutableProps): ImmutableProps {
        const values: ImmutableProps = {};
        for (const prop of this.groupingPropertyNames) {
            if (prop in props) {
                values[prop] = props[prop];
            }
        }
        return values;
    }

    private omitGroupingValues(props: ImmutableProps): ImmutableProps {
        const rest: ImmutableProps = {};
        for (const prop of Object.keys(props)) {
            if (!this.groupingPropertyNames.includes(prop)) {
                rest[prop] = props[prop];
            }
        }
        return rest;
    }

    /** Adds an item to its group, creating the group when it is the first member. */
    private join(item: TrackedItem): string {
        const groupKey = this.groupKeyOf(item);
        const size = this.groupSizes.get(groupKey) ?? 0;
        // Record the member before notifying: a handler can add another row to this group.
        this.groupSizes.set(groupKey, size + 1);
        if (size === 0) {
            this.groupAddedHandlers.forEach(handler => handler(item.parentKey, groupKey, item.groupingValues));
        }
        return groupKey;
    }

    /** Removes an item from its group, removing the group when it was the last member. */
    private leave(item: TrackedItem): void {
        const groupKey = this.groupKeyOf(item);
        const size = this.groupSizes.get(groupKey) ?? 0;
        if (size > 1) {
            this.groupSizes.set(groupKey, size - 1);
            return;
        }
        this.groupSizes.delete(groupKey);
        this.groupRemovedHandlers.forEach(handler => handler(groupKey, item.groupingValues));
    }

    private handleAdded(parentKey: string | undefined, itemKey: string, immutableProps: ImmutableProps): void {
        const item: TrackedItem = { parentKey, groupingValues: this.pickGroupingValues(immutableProps) };
        this.trackedItems.set(itemKey, item);
        const groupKey = this.join(item);
        const itemProps = this.omitGroupingValues(immutableProps);
        this.itemAddedHandlers.forEach(handler => handler(groupKey, itemKey, itemProps));
    }

    private handleRemoved(itemKey: string, immutableProps: ImmutableProps): void {
        const item = this.trackedItems.get(itemKey);
        if (!item) {
            throw new Error(`GroupByStep: item with key "${itemKey}" not found`);
        }
        const itemProps = this.omitGroupingValues(immutableProps);
        this.itemRemovedHandlers.forEach(handler => handler(itemKey, itemProps));
        this.trackedItems.delete(itemKey);
        this.leave(item);
    }

    private handleGroupingPropertyChange(itemKey: string, propertyName: string, newValue: unknown): void {
        const item = this.trackedItems.get(itemKey);
        if (!item) {
            return;
        }
        this.move(itemKey, item, { parentKey: item.parentKey, groupingValues: { ...item.groupingValues, [propertyName]: newValue } });
    }

    private handleItemPlaced(itemKey: string, newParentKey: string): void {
        const item = this.trackedItems.get(itemKey);
        if (!item) {
            return;
        }
        this.move(itemKey, item, { parentKey: newParentKey, groupingValues: item.groupingValues });
    }

    /** Moves an item to the group for its new placement or grouping values. */
    private move(itemKey: string, from: TrackedItem, to: TrackedItem): void {
        this.trackedItems.set(itemKey, to);
        const fromGroupKey = this.groupKeyOf(from);
        const toGroupKey = this.groupKeyOf(to);
        if (fromGroupKey === toGroupKey) {
            return;
        }
        // The new group exists before the item enters it, and the old group is removed only
        // after the item has left it.
        this.join(to);
        this.itemPlacedHandlers.forEach(handler => handler(itemKey, fromGroupKey, toGroupKey));
        this.leave(from);
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

