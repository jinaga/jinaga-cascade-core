import type {
    AddedHandler,
    ImmutableProps,
    ModifiedHandler,
    RemovedHandler,
    Step,
    TypeDescriptor
} from '../pipeline.js';
import { pathsMatch } from '../util/path.js';

type NormalizedOrderValue = number | string | undefined;

interface ItemState {
    key: string;
    currentProps: ImmutableProps;
    orderValues: NormalizedOrderValue[];
    inputValues: Record<string, number>;
    cumulativeValues: Record<string, number>;
}

interface ParentState {
    readonly itemsByKey: Map<string, ItemState>;
    readonly orderedKeys: string[];
}

function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

function toFiniteNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeOrderValue(value: unknown): NormalizedOrderValue {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}

function compareNormalizedOrderValues(
    left: NormalizedOrderValue,
    right: NormalizedOrderValue
): number {
    if (left === right) {
        return 0;
    }
    if (left === undefined) {
        return -1;
    }
    if (right === undefined) {
        return 1;
    }
    if (typeof left === 'number' && typeof right === 'number') {
        return left - right;
    }
    const leftAsString = String(left);
    const rightAsString = String(right);
    if (leftAsString < rightAsString) {
        return -1;
    }
    if (leftAsString > rightAsString) {
        return 1;
    }
    return 0;
}

export class CumulativeSumStep<
    _TInput,
    TPath extends string[],
    TProperties extends readonly string[]
> implements Step {
    private readonly parentStates: Map<string, ParentState> = new Map();
    private readonly addedHandlers: AddedHandler[] = [];
    private readonly removedHandlers: RemovedHandler[] = [];
    private readonly modifiedHandlers: Map<string, ModifiedHandler[]> = new Map();
    private readonly cumulativePropertySet: Set<string>;
    private readonly orderByPropertySet: Set<string>;

    constructor(
        private input: Step,
        private segmentPath: TPath,
        private orderBy: readonly string[],
        private properties: TProperties
    ) {
        this.cumulativePropertySet = new Set(this.properties);
        this.orderByPropertySet = new Set(this.orderBy);

        this.input.onAdded(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemAdded(keyPath, itemKey, immutableProps);
        });

        this.input.onRemoved(this.segmentPath, (keyPath, itemKey, immutableProps) => {
            this.handleItemRemoved(keyPath, itemKey, immutableProps);
        });

        const inputDescriptor = this.input.getTypeDescriptor();
        const listenedProperties = new Set<string>([
            ...this.properties,
            ...this.orderBy,
            ...inputDescriptor.mutableProperties
        ]);

        listenedProperties.forEach(propertyName => {
            this.input.onModified(this.segmentPath, propertyName, (keyPath, itemKey, oldValue, newValue) => {
                this.handleItemModified(keyPath, itemKey, propertyName, oldValue, newValue);
            });
        });
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.input.getTypeDescriptor();
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathsMatch(pathSegments, this.segmentPath)) {
            this.addedHandlers.push(handler);
            return;
        }
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathsMatch(pathSegments, this.segmentPath)) {
            this.removedHandlers.push(handler);
            return;
        }
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (pathsMatch(pathSegments, this.segmentPath) && this.cumulativePropertySet.has(propertyName)) {
            const handlers = this.modifiedHandlers.get(propertyName) ?? [];
            handlers.push(handler);
            this.modifiedHandlers.set(propertyName, handlers);
            return;
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    private handleItemAdded(parentKeyPath: string[], itemKey: string, immutableProps: ImmutableProps): void {
        const parentState = this.getOrCreateParentState(parentKeyPath);
        if (parentState.itemsByKey.has(itemKey)) {
            this.handleItemRemoved(parentKeyPath, itemKey, immutableProps);
        }

        const itemState: ItemState = {
            key: itemKey,
            currentProps: { ...immutableProps },
            orderValues: this.computeOrderValues(immutableProps),
            inputValues: this.computeInputValues(immutableProps),
            cumulativeValues: this.createZeroedValueRecord()
        };

        const insertionIndex = this.findInsertionIndex(parentState, itemState);
        const predecessor = insertionIndex > 0
            ? parentState.itemsByKey.get(parentState.orderedKeys[insertionIndex - 1])
            : undefined;

        this.properties.forEach(propertyName => {
            const predecessorCumulative = predecessor ? predecessor.cumulativeValues[propertyName] : 0;
            itemState.cumulativeValues[propertyName] = predecessorCumulative + itemState.inputValues[propertyName];
        });

        parentState.itemsByKey.set(itemKey, itemState);
        parentState.orderedKeys.splice(insertionIndex, 0, itemKey);

        const emittedProps = this.composeOutputProps(itemState);
        this.addedHandlers.forEach(handler => {
            handler(parentKeyPath, itemKey, emittedProps);
        });

        this.properties.forEach(propertyName => {
            const delta = itemState.inputValues[propertyName];
            this.applyDeltaToSuffix(parentState, parentKeyPath, insertionIndex + 1, propertyName, delta);
        });
    }

    private handleItemRemoved(parentKeyPath: string[], itemKey: string, _immutableProps: ImmutableProps): void {
        const parentState = this.getParentState(parentKeyPath);
        if (!parentState) {
            return;
        }

        const itemState = parentState.itemsByKey.get(itemKey);
        if (!itemState) {
            return;
        }

        const index = parentState.orderedKeys.indexOf(itemKey);
        if (index === -1) {
            return;
        }

        this.properties.forEach(propertyName => {
            const delta = -itemState.inputValues[propertyName];
            this.applyDeltaToSuffix(parentState, parentKeyPath, index + 1, propertyName, delta);
        });

        const emittedProps = this.composeOutputProps(itemState);
        this.removedHandlers.forEach(handler => {
            handler(parentKeyPath, itemKey, emittedProps);
        });

        parentState.itemsByKey.delete(itemKey);
        parentState.orderedKeys.splice(index, 1);

        if (parentState.orderedKeys.length === 0) {
            this.parentStates.delete(computeKeyPathHash(parentKeyPath));
        }
    }

    private handleItemModified(
        parentKeyPath: string[],
        itemKey: string,
        propertyName: string,
        _oldValue: unknown,
        newValue: unknown
    ): void {
        const parentState = this.getParentState(parentKeyPath);
        if (!parentState) {
            return;
        }

        const itemState = parentState.itemsByKey.get(itemKey);
        if (!itemState) {
            return;
        }

        itemState.currentProps[propertyName] = newValue;

        if (this.orderByPropertySet.has(propertyName)) {
            const nextOrderValues = this.computeOrderValues(itemState.currentProps);
            const orderChanged = !this.areOrderTuplesEqual(itemState.orderValues, nextOrderValues);
            if (orderChanged) {
                this.handleOrderByPropertyChange(parentState, parentKeyPath, itemState, propertyName, newValue, nextOrderValues);
                return;
            }
            itemState.orderValues = nextOrderValues;
        }

        if (this.cumulativePropertySet.has(propertyName)) {
            this.handleCumulativePropertyChange(parentState, parentKeyPath, itemState, propertyName, newValue);
        }
    }

    private handleCumulativePropertyChange(
        parentState: ParentState,
        parentKeyPath: string[],
        itemState: ItemState,
        propertyName: string,
        newValue: unknown
    ): void {
        const oldInputValue = itemState.inputValues[propertyName];
        const newInputValue = toFiniteNumber(newValue);
        const delta = newInputValue - oldInputValue;
        itemState.inputValues[propertyName] = newInputValue;

        if (Object.is(delta, 0)) {
            return;
        }

        const index = parentState.orderedKeys.indexOf(itemState.key);
        if (index === -1) {
            return;
        }

        this.applyDeltaToSuffix(parentState, parentKeyPath, index, propertyName, delta);
    }

    private handleOrderByPropertyChange(
        parentState: ParentState,
        parentKeyPath: string[],
        itemState: ItemState,
        changedProperty: string,
        newValue: unknown,
        nextOrderValues: NormalizedOrderValue[]
    ): void {
        const oldIndex = parentState.orderedKeys.indexOf(itemState.key);
        if (oldIndex === -1) {
            return;
        }

        const oldInputValues = { ...itemState.inputValues };
        const oldCumulativeValues = { ...itemState.cumulativeValues };

        if (this.cumulativePropertySet.has(changedProperty)) {
            itemState.inputValues[changedProperty] = toFiniteNumber(newValue);
        }

        parentState.orderedKeys.splice(oldIndex, 1);

        this.properties.forEach(propertyName => {
            this.applyDeltaToSuffix(parentState, parentKeyPath, oldIndex, propertyName, -oldInputValues[propertyName]);
        });

        itemState.orderValues = nextOrderValues;

        const newIndex = this.findInsertionIndex(parentState, itemState);
        parentState.orderedKeys.splice(newIndex, 0, itemState.key);

        const predecessor = newIndex > 0
            ? parentState.itemsByKey.get(parentState.orderedKeys[newIndex - 1])
            : undefined;

        this.properties.forEach(propertyName => {
            const predecessorCumulative = predecessor ? predecessor.cumulativeValues[propertyName] : 0;
            const newCumulativeValue = predecessorCumulative + itemState.inputValues[propertyName];
            itemState.cumulativeValues[propertyName] = newCumulativeValue;
            this.emitModified(parentKeyPath, itemState.key, propertyName, oldCumulativeValues[propertyName], newCumulativeValue);
        });

        this.properties.forEach(propertyName => {
            this.applyDeltaToSuffix(parentState, parentKeyPath, newIndex + 1, propertyName, itemState.inputValues[propertyName]);
        });
    }

    private applyDeltaToSuffix(
        parentState: ParentState,
        parentKeyPath: string[],
        startIndexInclusive: number,
        propertyName: string,
        delta: number
    ): void {
        if (Object.is(delta, 0)) {
            return;
        }

        for (let index = startIndexInclusive; index < parentState.orderedKeys.length; index += 1) {
            const key = parentState.orderedKeys[index];
            const itemState = parentState.itemsByKey.get(key);
            if (!itemState) {
                continue;
            }
            const oldValue = itemState.cumulativeValues[propertyName];
            const newValue = oldValue + delta;
            itemState.cumulativeValues[propertyName] = newValue;
            this.emitModified(parentKeyPath, itemState.key, propertyName, oldValue, newValue);
        }
    }

    private emitModified(
        keyPath: string[],
        key: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        if (Object.is(oldValue, newValue)) {
            return;
        }
        const handlers = this.modifiedHandlers.get(propertyName) ?? [];
        handlers.forEach(handler => {
            handler(keyPath, key, oldValue, newValue);
        });
    }

    private getParentState(parentKeyPath: string[]): ParentState | undefined {
        return this.parentStates.get(computeKeyPathHash(parentKeyPath));
    }

    private getOrCreateParentState(parentKeyPath: string[]): ParentState {
        const parentKeyHash = computeKeyPathHash(parentKeyPath);
        const existing = this.parentStates.get(parentKeyHash);
        if (existing) {
            return existing;
        }
        const created: ParentState = {
            itemsByKey: new Map(),
            orderedKeys: []
        };
        this.parentStates.set(parentKeyHash, created);
        return created;
    }

    private createZeroedValueRecord(): Record<string, number> {
        const zeroed: Record<string, number> = {};
        this.properties.forEach(propertyName => {
            zeroed[propertyName] = 0;
        });
        return zeroed;
    }

    private computeInputValues(props: ImmutableProps): Record<string, number> {
        const values: Record<string, number> = {};
        this.properties.forEach(propertyName => {
            values[propertyName] = toFiniteNumber(props[propertyName]);
        });
        return values;
    }

    private computeOrderValues(props: ImmutableProps): NormalizedOrderValue[] {
        return this.orderBy.map(propertyName => normalizeOrderValue(props[propertyName]));
    }

    private composeOutputProps(itemState: ItemState): ImmutableProps {
        return {
            ...itemState.currentProps,
            ...itemState.cumulativeValues
        };
    }

    private findInsertionIndex(parentState: ParentState, candidate: ItemState): number {
        let low = 0;
        let high = parentState.orderedKeys.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const midItem = parentState.itemsByKey.get(parentState.orderedKeys[mid]);
            if (!midItem) {
                low = mid + 1;
                continue;
            }
            const comparison = this.compareItems(candidate, midItem);
            if (comparison < 0) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        return low;
    }

    private compareItems(left: ItemState, right: ItemState): number {
        for (let index = 0; index < this.orderBy.length; index += 1) {
            const orderComparison = compareNormalizedOrderValues(left.orderValues[index], right.orderValues[index]);
            if (orderComparison !== 0) {
                return orderComparison;
            }
        }
        if (left.key < right.key) {
            return -1;
        }
        if (left.key > right.key) {
            return 1;
        }
        return 0;
    }

    private areOrderTuplesEqual(left: NormalizedOrderValue[], right: NormalizedOrderValue[]): boolean {
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!Object.is(left[index], right[index])) {
                return false;
            }
        }
        return true;
    }
}
