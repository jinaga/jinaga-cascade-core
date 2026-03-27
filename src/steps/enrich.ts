import type {
    AddedHandler,
    DescriptorNode,
    ImmutableProps,
    ModifiedHandler,
    RemovedHandler,
    Step,
    TypeDescriptor
} from '../pipeline.js';
import { appendMutableIfMissing, appendObjectIfMissing } from '../util/descriptor-transform.js';
import { pathsMatch } from '../util/path.js';
import { getPathSegmentsFromDescriptor as getAllPathSegmentsFromDescriptor } from '../pipeline.js';

function keyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

function stableSerialize(value: unknown): string {
    return JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
    return stableSerialize(left) === stableSerialize(right);
}

type EmitDiagnostic = (diagnostic: {
    code:
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
}) => void;

interface PrimaryRecord {
    keyPath: string[];
    primaryKey: string;
    immutableProps: ImmutableProps;
    joinKeyHash: string;
}

interface SecondaryRecord {
    keyPath: string[];
    immutableProps: ImmutableProps;
}

type KeyedArray<T> = { key: string; value: T }[];

export class EnrichStep implements Step {
    private readonly primaryRowsById = new Map<string, PrimaryRecord>();
    private readonly primaryIdsByJoinKey = new Map<string, Set<string>>();
    private readonly secondaryRowByJoinKey = new Map<string, SecondaryRecord>();
    private readonly modifiedHandlers: ModifiedHandler[] = [];
    private secondaryState: KeyedArray<ImmutableProps> = [];

    constructor(
        private readonly input: Step,
        private readonly secondary: Step,
        private readonly scopeSegments: string[],
        private readonly primaryKey: string[],
        private readonly asProperty: string,
        private readonly whenMissing: ImmutableProps | undefined,
        private readonly emitDiagnostic?: EmitDiagnostic
    ) {
        this.input.onAdded(this.scopeSegments, (keyPath, key, immutableProps) => {
            this.handlePrimaryAdded(keyPath, key, immutableProps);
        });
        this.input.onRemoved(this.scopeSegments, (keyPath, key, immutableProps) => {
            this.handlePrimaryRemoved(keyPath, key, immutableProps);
        });

        const secondaryDescriptor = this.secondary.getTypeDescriptor();
        const secondaryPaths = getAllPathSegmentsFromDescriptor(secondaryDescriptor);
        const mutableProperties = collectAllMutableProperties(secondaryDescriptor);

        for (const segmentPath of secondaryPaths) {
            this.secondary.onAdded(segmentPath, (keyPath, key, immutableProps) => {
                this.handleSecondaryAddedAtPath(segmentPath, keyPath, key, immutableProps);
            });
            this.secondary.onRemoved(segmentPath, (keyPath, key, immutableProps) => {
                this.handleSecondaryRemovedAtPath(segmentPath, keyPath, key, immutableProps);
            });
            for (const propertyName of mutableProperties) {
                this.secondary.onModified(segmentPath, propertyName, (keyPath, key, _oldValue, newValue) => {
                    this.handleSecondaryModifiedAtPath(segmentPath, keyPath, key, propertyName, newValue);
                });
            }
        }
    }

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        const secondaryDescriptor = this.secondary.getTypeDescriptor();

        const secondaryRoot: DescriptorNode = {
            arrays: secondaryDescriptor.arrays,
            collectionKey: secondaryDescriptor.collectionKey,
            scalars: secondaryDescriptor.scalars,
            objects: secondaryDescriptor.objects,
            mutableProperties: secondaryDescriptor.mutableProperties
        };

        if (this.scopeSegments.length === 0) {
            const withObject = appendObjectIfMissing(inputDescriptor, {
                name: this.asProperty,
                type: secondaryRoot
            });
            return appendMutableIfMissing(withObject, this.asProperty) as TypeDescriptor;
        }

        const atScope = this.addObjectAtPath(inputDescriptor, this.scopeSegments, {
            name: this.asProperty,
            type: secondaryRoot
        });
        return {
            ...appendMutableIfMissing(atScope, this.asProperty),
            rootCollectionName: inputDescriptor.rootCollectionName
        };
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathsMatch(pathSegments, this.scopeSegments)) {
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                const enrichedValue = this.resolveEnrichmentForPrimary(immutableProps);
                handler(keyPath, key, {
                    ...immutableProps,
                    [this.asProperty]: enrichedValue
                });
            });
            return;
        }
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathsMatch(pathSegments, this.scopeSegments)) {
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                const enrichedValue = this.resolveEnrichmentForPrimary(immutableProps);
                handler(keyPath, key, {
                    ...immutableProps,
                    [this.asProperty]: enrichedValue
                });
            });
            return;
        }
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (pathsMatch(pathSegments, this.scopeSegments) && propertyName === this.asProperty) {
            this.modifiedHandlers.push(handler);
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    private addObjectAtPath(
        descriptor: DescriptorNode,
        path: string[],
        objectDesc: { name: string; type: DescriptorNode }
    ): DescriptorNode {
        if (path.length === 0) {
            return appendObjectIfMissing(descriptor, objectDesc);
        }

        const [first, ...rest] = path;
        return {
            ...descriptor,
            arrays: descriptor.arrays.map(arr => {
                if (arr.name !== first) {
                    return arr;
                }
                return {
                    ...arr,
                    type: this.addObjectAtPath(arr.type, rest, objectDesc)
                };
            })
        };
    }

    private primaryId(keyPath: string[], key: string): string {
        return `${keyPathHash(keyPath)}::${key}`;
    }

    private secondaryJoinFromSecondaryRow(row: ImmutableProps): string | null {
        const secondaryCollectionKey = this.secondary.getTypeDescriptor().collectionKey;
        if (secondaryCollectionKey.length === 0) {
            this.emitDiagnostic?.({
                code: 'enrich_secondary_collection_key_missing',
                message: 'Secondary descriptor has no collectionKey; enrichment cannot match rows.'
            });
            return null;
        }
        if (secondaryCollectionKey.length !== this.primaryKey.length) {
            this.emitDiagnostic?.({
                code: 'enrich_key_arity_mismatch',
                message: 'Primary key count does not match secondary collection key count.'
            });
            return null;
        }
        const tuple = secondaryCollectionKey.map(name => row[name]);
        return stableSerialize(tuple);
    }

    private primaryJoinFromPrimaryRow(row: ImmutableProps): string | null {
        const secondaryCollectionKey = this.secondary.getTypeDescriptor().collectionKey;
        if (secondaryCollectionKey.length !== this.primaryKey.length) {
            this.emitDiagnostic?.({
                code: 'enrich_key_arity_mismatch',
                message: 'Primary key count does not match secondary collection key count.'
            });
            return null;
        }
        for (const property of this.primaryKey) {
            if (!(property in row)) {
                this.emitDiagnostic?.({
                    code: 'enrich_invalid_primary_key_property',
                    message: `Primary row does not contain key property "${property}".`
                });
                return null;
            }
        }
        const tuple = this.primaryKey.map(name => row[name]);
        return stableSerialize(tuple);
    }

    private resolveEnrichmentFromJoinHash(joinHash: string | null): ImmutableProps | undefined {
        if (joinHash === null) {
            return this.whenMissing;
        }
        const matched = this.secondaryRowByJoinKey.get(joinHash);
        return matched?.immutableProps ?? this.whenMissing;
    }

    private resolveEnrichmentForPrimary(primaryRow: ImmutableProps): ImmutableProps | undefined {
        const joinHash = this.primaryJoinFromPrimaryRow(primaryRow);
        return this.resolveEnrichmentFromJoinHash(joinHash);
    }

    private handlePrimaryAdded(keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        const joinHash = this.primaryJoinFromPrimaryRow(immutableProps);
        if (joinHash === null) {
            return;
        }
        const id = this.primaryId(keyPath, key);
        this.primaryRowsById.set(id, {
            keyPath,
            primaryKey: key,
            immutableProps,
            joinKeyHash: joinHash
        });
        let ids = this.primaryIdsByJoinKey.get(joinHash);
        if (!ids) {
            ids = new Set<string>();
            this.primaryIdsByJoinKey.set(joinHash, ids);
        }
        ids.add(id);
    }

    private handlePrimaryRemoved(keyPath: string[], key: string, _immutableProps: ImmutableProps): void {
        const id = this.primaryId(keyPath, key);
        const existing = this.primaryRowsById.get(id);
        if (!existing) {
            return;
        }
        this.primaryRowsById.delete(id);
        const ids = this.primaryIdsByJoinKey.get(existing.joinKeyHash);
        if (!ids) {
            return;
        }
        ids.delete(id);
        if (ids.size === 0) {
            this.primaryIdsByJoinKey.delete(existing.joinKeyHash);
        }
    }

    private handleSecondaryAddedAtPath(
        segmentPath: string[],
        keyPath: string[],
        key: string,
        immutableProps: ImmutableProps
    ): void {
        const rootKey = this.getRootKey(segmentPath, keyPath, key);
        if (!rootKey) {
            return;
        }
        const oldRootRow = getRowByKey(this.secondaryState, rootKey);
        this.secondaryState = addToKeyedArray(this.secondaryState, segmentPath, keyPath, key, immutableProps);
        const newRootRow = getRowByKey(this.secondaryState, rootKey);
        this.applySecondaryRootChange(oldRootRow, newRootRow);
    }

    private handleSecondaryRemovedAtPath(
        segmentPath: string[],
        keyPath: string[],
        key: string,
        _immutableProps: ImmutableProps
    ): void {
        const rootKey = this.getRootKey(segmentPath, keyPath, key);
        if (!rootKey) {
            return;
        }
        const oldRootRow = getRowByKey(this.secondaryState, rootKey);
        this.secondaryState = removeFromKeyedArray(this.secondaryState, segmentPath, keyPath, key);
        const newRootRow = getRowByKey(this.secondaryState, rootKey);
        this.applySecondaryRootChange(oldRootRow, newRootRow);
    }

    private handleSecondaryModifiedAtPath(
        segmentPath: string[],
        keyPath: string[],
        key: string,
        propertyName: string,
        newValue: unknown
    ): void {
        const rootKey = this.getRootKey(segmentPath, keyPath, key);
        if (!rootKey) {
            return;
        }
        const oldRootRow = getRowByKey(this.secondaryState, rootKey);
        this.secondaryState = modifyInKeyedArray(this.secondaryState, segmentPath, keyPath, key, propertyName, newValue);
        const newRootRow = getRowByKey(this.secondaryState, rootKey);
        this.applySecondaryRootChange(oldRootRow, newRootRow);
    }

    private getRootKey(segmentPath: string[], keyPath: string[], key: string): string | null {
        if (segmentPath.length === 0) {
            return key;
        }
        if (keyPath.length === 0) {
            return null;
        }
        return keyPath[0];
    }

    private applySecondaryRootChange(
        oldRootRow: ImmutableProps | undefined,
        newRootRow: ImmutableProps | undefined
    ): void {
        const oldJoinHash = oldRootRow ? this.secondaryJoinFromSecondaryRow(oldRootRow) : null;
        const newJoinHash = newRootRow ? this.secondaryJoinFromSecondaryRow(newRootRow) : null;

        if (oldJoinHash !== null && oldJoinHash !== newJoinHash) {
            this.secondaryRowByJoinKey.delete(oldJoinHash);
            this.emitModifiedForJoinKey(oldJoinHash, oldRootRow, this.whenMissing);
        }

        if (newJoinHash !== null && newRootRow) {
            this.secondaryRowByJoinKey.set(newJoinHash, { keyPath: [], immutableProps: newRootRow });
            if (oldJoinHash === newJoinHash) {
                this.emitModifiedForJoinKey(newJoinHash, oldRootRow, newRootRow);
            }
            else {
                this.emitModifiedForJoinKey(newJoinHash, this.whenMissing, newRootRow);
            }
            return;
        }

        if (oldJoinHash !== null && oldJoinHash === newJoinHash) {
            this.secondaryRowByJoinKey.delete(oldJoinHash);
            this.emitModifiedForJoinKey(oldJoinHash, oldRootRow, this.whenMissing);
        }
    }

    private emitModifiedForJoinKey(
        joinHash: string,
        oldValue: ImmutableProps | undefined,
        newValue: ImmutableProps | undefined
    ): void {
        const previous = oldValue ?? this.whenMissing;
        const next = newValue ?? this.whenMissing;

        if (valuesEqual(previous, next)) {
            return;
        }
        const impactedPrimaryIds = this.primaryIdsByJoinKey.get(joinHash);
        if (!impactedPrimaryIds || impactedPrimaryIds.size === 0) {
            return;
        }
        for (const id of impactedPrimaryIds) {
            const record = this.primaryRowsById.get(id);
            if (!record) {
                continue;
            }
            this.modifiedHandlers.forEach(handler => {
                handler(record.keyPath, record.primaryKey, previous, next);
            });
        }
    }
}

function collectAllMutableProperties(descriptor: DescriptorNode): string[] {
    const mutableProps = new Set<string>();
    for (const prop of descriptor.mutableProperties) {
        mutableProps.add(prop);
    }
    for (const arrayDesc of descriptor.arrays) {
        const nestedProps = collectAllMutableProperties(arrayDesc.type);
        nestedProps.forEach(prop => mutableProps.add(prop));
    }
    return Array.from(mutableProps);
}

function createKeyToIndexMap<T>(state: KeyedArray<T>): Map<string, number> {
    const keyToIndex = new Map<string, number>();
    state.forEach((item, index) => keyToIndex.set(item.key, index));
    return keyToIndex;
}

function addToKeyedArray<T>(
    state: KeyedArray<T>,
    segmentPath: string[],
    keyPath: string[],
    key: string,
    immutableProps: ImmutableProps
): KeyedArray<T> {
    if (segmentPath.length === 0) {
        return [...state, { key, value: immutableProps as T }];
    }
    const parentKey = keyPath[0];
    const segment = segmentPath[0];
    const keyToIndex = createKeyToIndexMap(state);
    const existingItemIndex = keyToIndex.get(parentKey);
    if (existingItemIndex === undefined) {
        return state;
    }
    const existingItem = state[existingItemIndex];
    const value = existingItem.value as Record<string, unknown>;
    const existingArray = (value[segment] as KeyedArray<unknown>) || [];
    const modifiedArray = addToKeyedArray(
        existingArray,
        segmentPath.slice(1),
        keyPath.slice(1),
        key,
        immutableProps
    );
    const modifiedItem = {
        key: parentKey,
        value: {
            ...value,
            [segment]: modifiedArray
        } as T
    };
    return [
        ...state.slice(0, existingItemIndex),
        modifiedItem,
        ...state.slice(existingItemIndex + 1)
    ];
}

function removeFromKeyedArray<T>(
    state: KeyedArray<T>,
    segmentPath: string[],
    keyPath: string[],
    key: string
): KeyedArray<T> {
    if (segmentPath.length === 0) {
        return state.filter(item => item.key !== key);
    }
    const parentKey = keyPath[0];
    const segment = segmentPath[0];
    const keyToIndex = createKeyToIndexMap(state);
    const existingItemIndex = keyToIndex.get(parentKey);
    if (existingItemIndex === undefined) {
        return state;
    }
    const existingItem = state[existingItemIndex];
    const value = existingItem.value as Record<string, unknown>;
    const existingArray = (value[segment] as KeyedArray<unknown>) || [];
    const modifiedArray = removeFromKeyedArray(
        existingArray,
        segmentPath.slice(1),
        keyPath.slice(1),
        key
    );
    const modifiedItem = {
        key: parentKey,
        value: {
            ...value,
            [segment]: modifiedArray
        } as T
    };
    return [
        ...state.slice(0, existingItemIndex),
        modifiedItem,
        ...state.slice(existingItemIndex + 1)
    ];
}

function modifyInKeyedArray<T>(
    state: KeyedArray<T>,
    segmentPath: string[],
    keyPath: string[],
    key: string,
    name: string,
    value: unknown
): KeyedArray<T> {
    if (segmentPath.length === 0) {
        const keyToIndex = createKeyToIndexMap(state);
        const existingItemIndex = keyToIndex.get(key);
        if (existingItemIndex === undefined) {
            return state;
        }
        const existingItem = state[existingItemIndex];
        const existingValue = existingItem.value as Record<string, unknown>;
        const modifiedItem = {
            key,
            value: {
                ...existingValue,
                [name]: value
            } as T
        };
        return [
            ...state.slice(0, existingItemIndex),
            modifiedItem,
            ...state.slice(existingItemIndex + 1)
        ];
    }

    const parentKey = keyPath[0];
    const segment = segmentPath[0];
    const keyToIndex = createKeyToIndexMap(state);
    const existingItemIndex = keyToIndex.get(parentKey);
    if (existingItemIndex === undefined) {
        return state;
    }
    const existingItem = state[existingItemIndex];
    const existingValue = existingItem.value as Record<string, unknown>;
    const existingArray = (existingValue[segment] as KeyedArray<unknown>) || [];
    const modifiedArray = modifyInKeyedArray(
        existingArray,
        segmentPath.slice(1),
        keyPath.slice(1),
        key,
        name,
        value
    );
    const modifiedItem = {
        key: parentKey,
        value: {
            ...existingValue,
            [segment]: modifiedArray
        } as T
    };
    return [
        ...state.slice(0, existingItemIndex),
        modifiedItem,
        ...state.slice(existingItemIndex + 1)
    ];
}

function getRowByKey(
    state: KeyedArray<ImmutableProps>,
    key: string
): ImmutableProps | undefined {
    return state.find(item => item.key === key)?.value;
}
