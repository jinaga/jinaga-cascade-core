import type { AddedHandler, BuildContext, BuiltStepGraph, ImmutableProps, ModifiedHandler, PlacedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';

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

function transformCommutativeAggregateDescriptor(
    inputDescriptor: TypeDescriptor,
    propertyName: string
): TypeDescriptor {
    const outputScalar = {
        name: propertyName,
        type: 'number' as const
    };
    const scalars = inputDescriptor.scalars.some(s => s.name === propertyName)
        ? inputDescriptor.scalars
        : [...inputDescriptor.scalars, outputScalar];
    const mutableProperties = inputDescriptor.mutableProperties;
    if (!mutableProperties.includes(propertyName)) {
        return {
            ...inputDescriptor,
            scalars,
            mutableProperties: [...mutableProperties, propertyName]
        };
    }
    return {
        ...inputDescriptor,
        scalars
    };
}

/**
 * A step that computes an aggregate value over the items of an array, per parent.
 *
 * - `onAdded`/`onRemoved` pass through unchanged; the aggregate is delivered only via
 *   `onModified` at the parent level.
 * - Each item contributes to the aggregate of its current parent. A move (`onPlaced`)
 *   subtracts the item from the old parent and adds it to the new one.
 * - When the aggregated property is mutable, an item contributes only once its value is
 *   defined; a change subtracts the previous snapshot and adds the new one.
 * - A parent with no contributing items has no aggregate, whatever it had before, and a
 *   change that leaves the aggregate as it was emits nothing.
 */
export class CommutativeAggregateStep<
    TItem extends ImmutableProps,
    TPath extends string[],
    TPropertyName extends string,
    TAggregate
> implements Step {

    /** Current aggregate per parent key; absent while no item contributes. */
    private aggregateValues: Map<string, TAggregate> = new Map();

    /** Number of contributing items per parent key. */
    private contributorCounts: Map<string, number> = new Map();

    /** Placement and latest snapshot of each item. */
    private items: Map<string, { parentKey: string; item: TItem }> = new Map();

    private modifiedHandlers: ModifiedHandler[] = [];

    /** Whether the property being aggregated is mutable (auto-detected) */
    private isPropertyMutable: boolean = false;

    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private config: CommutativeAggregateConfig<TItem, TAggregate>,
        private propertyToAggregate: string | undefined,
        inputDescriptor?: TypeDescriptor
    ) {
        this.input.onAdded(this.segmentPath, (parentKey, itemKey, immutableProps) => {
            if (parentKey !== undefined) {
                this.handleItemAdded(parentKey, itemKey, immutableProps);
            }
        });
        this.input.onRemoved(this.segmentPath, itemKey => {
            this.handleItemRemoved(itemKey);
        });
        this.input.onPlaced(this.segmentPath, (itemKey, _oldParentKey, newParentKey) => {
            this.handleItemPlaced(itemKey, newParentKey);
        });

        // Mutable properties are recorded at the root of the descriptor.
        if (propertyToAggregate && (inputDescriptor?.mutableProperties ?? []).includes(propertyToAggregate)) {
            this.isPropertyMutable = true;
            this.input.onModified(this.segmentPath, propertyToAggregate, (itemKey, _oldValue, newValue) => {
                this.handleItemPropertyChanged(itemKey, propertyToAggregate, newValue);
            });
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (this.isParentPath(pathSegments) && propertyName === this.propertyName) {
            this.modifiedHandlers.push(handler);
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        this.input.onPlaced(pathSegments, handler);
    }

    private isParentPath(pathSegments: string[]): boolean {
        const parentSegments = this.segmentPath.slice(0, -1);
        return pathSegments.length === parentSegments.length &&
            pathSegments.every((segment, i) => segment === parentSegments[i]);
    }

    private contributes(item: TItem): boolean {
        return !(this.isPropertyMutable && this.propertyToAggregate && item[this.propertyToAggregate] === undefined);
    }

    private emit(parentKey: string, oldValue: TAggregate | undefined, newValue: TAggregate | undefined): void {
        this.modifiedHandlers.forEach(handler => handler(parentKey, oldValue, newValue));
    }

    /**
     * Removes `withdrawn` from and adds `deposited` to one parent's aggregate, and emits the
     * change once, if there is one. A parent with no contributing items has no aggregate,
     * however many it had before.
     */
    private update(parentKey: string, withdrawn: TItem | undefined, deposited: TItem | undefined): void {
        const current = this.aggregateValues.get(parentKey);
        let count = this.contributorCounts.get(parentKey) ?? 0;
        let value = current;
        if (withdrawn !== undefined && this.contributes(withdrawn) && value !== undefined) {
            count -= 1;
            value = count > 0 ? this.config.subtract(value, withdrawn) : undefined;
        }
        if (deposited !== undefined && this.contributes(deposited)) {
            count += 1;
            value = this.config.add(value, deposited);
        }
        if (count > 0 && value !== undefined) {
            this.contributorCounts.set(parentKey, count);
            this.aggregateValues.set(parentKey, value);
        } else {
            this.contributorCounts.delete(parentKey);
            this.aggregateValues.delete(parentKey);
            value = undefined;
        }
        if (!Object.is(current, value)) {
            this.emit(parentKey, current, value);
        }
    }

    private handleItemAdded(parentKey: string, itemKey: string, immutableProps: ImmutableProps): void {
        const item = immutableProps as TItem;
        this.items.set(itemKey, { parentKey, item });
        this.update(parentKey, undefined, item);
    }

    private handleItemRemoved(itemKey: string): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        this.items.delete(itemKey);
        this.update(record.parentKey, record.item, undefined);
    }

    private handleItemPlaced(itemKey: string, newParentKey: string): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        const oldParentKey = record.parentKey;
        record.parentKey = newParentKey;
        this.update(oldParentKey, record.item, undefined);
        this.update(newParentKey, undefined, record.item);
    }

    private handleItemPropertyChanged(itemKey: string, propertyName: string, newValue: unknown): void {
        const record = this.items.get(itemKey);
        if (!record) {
            return;
        }
        const previous = record.item;
        record.item = { ...previous, [propertyName]: newValue } as TItem;
        this.update(record.parentKey, previous, record.item);
    }
}

export class CommutativeAggregateBuilder<TItem extends ImmutableProps, TAggregate> implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private config: {
            add: AddOperator<TItem, TAggregate>;
            subtract: SubtractOperator<TItem, TAggregate>;
        },
        private propertyToAggregate?: string
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformCommutativeAggregateDescriptor(this.upstream.getTypeDescriptor(), this.propertyName);
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new CommutativeAggregateStep(
                up.lastStep,
                this.segmentPath,
                this.propertyName,
                this.config,
                this.propertyToAggregate,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}