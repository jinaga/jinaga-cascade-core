import type { AddedHandler, BuildContext, BuiltStepGraph, ModifiedHandler, PlacedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';
import { getMutablePropertiesOfArrayItems } from '../pipeline.js';
import { appendAggregateAt } from '../util/descriptor-transform.js';

function parseFiniteNumber(value: unknown): number | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
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
    _TInput,
    TPath extends string[],
    TPropertyName extends string
> implements Step {
    
    /** Sum and count of the defined values per parent key. */
    private averageStates: Map<string, AverageState> = new Map();

    /** Placement and current numeric value of each item. */
    private items: Map<string, { parentKey: string; value: number | undefined }> = new Map();

    private modifiedHandlers: ModifiedHandler[] = [];

    constructor(
        private input: Step,
        private segmentPath: TPath,
        private propertyName: TPropertyName,
        private numericProperty: string,
        inputDescriptor: TypeDescriptor
    ) {
        this.input.onAdded(this.segmentPath, (parentKey, itemKey, immutableProps) => {
            if (parentKey !== undefined) {
                const record = { parentKey, value: parseFiniteNumber(immutableProps[this.numericProperty]) };
                this.items.set(itemKey, record);
                this.apply(record.parentKey, () => this.include(record));
            }
        });
        this.input.onRemoved(this.segmentPath, itemKey => {
            const record = this.items.get(itemKey);
            if (record) {
                this.items.delete(itemKey);
                this.apply(record.parentKey, () => this.exclude(record));
            }
        });
        this.input.onPlaced(this.segmentPath, (itemKey, _oldParentKey, newParentKey) => {
            const record = this.items.get(itemKey);
            if (record) {
                this.apply(record.parentKey, () => this.exclude(record));
                record.parentKey = newParentKey;
                this.apply(record.parentKey, () => this.include(record));
            }
        });
        if (getMutablePropertiesOfArrayItems(inputDescriptor, segmentPath).includes(numericProperty)) {
            this.input.onModified(this.segmentPath, numericProperty, (itemKey, _oldValue, newValue) => {
                const record = this.items.get(itemKey);
                if (record) {
                    this.apply(record.parentKey, () => {
                        this.exclude(record);
                        record.value = parseFiniteNumber(newValue);
                        this.include(record);
                    });
                }
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

    private getAverageForParent(parentKey: string): number | undefined {
        const state = this.averageStates.get(parentKey);
        return state && state.count > 0 ? state.sum / state.count : undefined;
    }

    /** Runs a change to one parent's state and emits that parent's old and new average. */
    private apply(parentKey: string, change: () => void): void {
        const oldAverage = this.getAverageForParent(parentKey);
        change();
        const newAverage = this.getAverageForParent(parentKey);
        if (!Object.is(oldAverage, newAverage)) {
            this.modifiedHandlers.forEach(handler => handler(parentKey, oldAverage, newAverage));
        }
    }

    private include(record: { parentKey: string; value: number | undefined }): void {
        if (record.value === undefined) {
            return;
        }
        const state = this.averageStates.get(record.parentKey) ?? { sum: 0, count: 0 };
        state.sum += record.value;
        state.count += 1;
        this.averageStates.set(record.parentKey, state);
    }

    private exclude(record: { parentKey: string; value: number | undefined }): void {
        if (record.value === undefined) {
            return;
        }
        const state = this.averageStates.get(record.parentKey);
        if (!state) {
            return;
        }
        state.sum -= record.value;
        state.count -= 1;
        if (state.count <= 0) {
            this.averageStates.delete(record.parentKey);
        }
    }
}

export class AverageAggregateBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private segmentPath: string[],
        private propertyName: string,
        private numericProperty: string
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return appendAggregateAt(this.upstream.getTypeDescriptor(), this.segmentPath, this.propertyName);
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new AverageAggregateStep(
                up.lastStep,
                this.segmentPath,
                this.propertyName,
                this.numericProperty,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}
