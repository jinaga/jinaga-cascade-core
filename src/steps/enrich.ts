import type {
    AddedHandler,
    BuildContext,
    BuiltStepGraph,
    DescriptorNode,
    ImmutableProps,
    ModifiedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
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
    try {
        return stableSerialize(left) === stableSerialize(right);
    } catch {
        // If either value cannot be serialized (e.g., circular reference, BigInt),
        // treat them as unequal rather than crashing the pipeline.
        return false;
    }
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
    /** Serialized join tuple when indexed; null when the row has no valid join (same as add skipped). */
    joinKeyHash: string | null;
}

interface SecondaryRecord {
    keyPath: string[];
    immutableProps: ImmutableProps;
}

function addObjectAtPath(
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
                type: addObjectAtPath(arr.type, rest, objectDesc)
            };
        })
    };
}

function transformEnrichDescriptor(
    inputDescriptor: TypeDescriptor,
    secondaryDescriptor: TypeDescriptor,
    scopeSegments: string[],
    asProperty: string
): TypeDescriptor {
    const secondaryRoot: DescriptorNode = {
        arrays: secondaryDescriptor.arrays,
        collectionKey: secondaryDescriptor.collectionKey,
        scalars: secondaryDescriptor.scalars,
        objects: secondaryDescriptor.objects,
        mutableProperties: secondaryDescriptor.mutableProperties
    };

    if (scopeSegments.length === 0) {
        const withObject = appendObjectIfMissing(inputDescriptor, {
            name: asProperty,
            type: secondaryRoot
        });
        return appendMutableIfMissing(withObject, asProperty) as TypeDescriptor;
    }

    const atScope = addObjectAtPath(inputDescriptor, scopeSegments, {
        name: asProperty,
        type: secondaryRoot
    });
    return {
        ...appendMutableIfMissing(atScope, asProperty),
        rootCollectionName: inputDescriptor.rootCollectionName
    };
}

export class EnrichBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        readonly sourceName: string,
        readonly secondaryLastBuilder: StepBuilder,
        readonly scopeSegments: string[],
        readonly primaryKey: string[],
        readonly asProperty: string,
        readonly whenMissing: ImmutableProps | undefined
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformEnrichDescriptor(
            this.upstream.getTypeDescriptor(),
            this.secondaryLastBuilder.getTypeDescriptor(),
            this.scopeSegments,
            this.asProperty
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const primary = this.upstream.buildGraph(ctx);
        const secondary = this.secondaryLastBuilder.buildGraph(ctx);
        const secondaryDescriptor = this.secondaryLastBuilder.getTypeDescriptor();
        secondary.rootInput.setSources(secondary.sources);
        const mergedSources = {
            ...primary.sources,
            [this.sourceName]: secondary.rootInput
        };
        return {
            rootInput: primary.rootInput,
            sources: mergedSources,
            lastStep: new EnrichStep(
                primary.lastStep,
                secondary.lastStep,
                this.scopeSegments,
                this.primaryKey,
                this.asProperty,
                this.whenMissing,
                secondaryDescriptor,
                ctx.emitDiagnostic
            )
        };
    }
}

type KeyedArray<T> = { key: string; value: T }[];

export class EnrichStep implements Step {
    private readonly primaryRowsById = new Map<string, PrimaryRecord>();
    private readonly primaryIdsByJoinKey = new Map<string, Set<string>>();
    private readonly secondaryRowByJoinKey = new Map<string, SecondaryRecord>();
    private readonly modifiedHandlers: ModifiedHandler[] = [];
    private secondaryState: KeyedArray<ImmutableProps> = [];
    private readonly secondaryCollectionKey: string[];

    constructor(
        private readonly input: Step,
        private readonly secondary: Step,
        private readonly scopeSegments: string[],
        private readonly primaryKey: string[],
        private readonly asProperty: string,
        private readonly whenMissing: ImmutableProps | undefined,
        secondaryDescriptor: TypeDescriptor,
        private readonly emitDiagnostic?: EmitDiagnostic
    ) {
        this.input.onAdded(this.scopeSegments, (keyPath, key, immutableProps) => {
            this.handlePrimaryAdded(keyPath, key, immutableProps);
        });
        this.input.onRemoved(this.scopeSegments, (keyPath, key, immutableProps) => {
            this.handlePrimaryRemoved(keyPath, key, immutableProps);
        });

        const primaryKeyColumns = new Set(this.primaryKey);
        for (const propertyName of primaryKeyColumns) {
            this.input.onModified(this.scopeSegments, propertyName, (keyPath, key, _oldValue, newValue) => {
                this.handlePrimaryJoinKeyPropertyModified(keyPath, key, propertyName, newValue);
            });
        }

        this.secondaryCollectionKey = secondaryDescriptor.collectionKey;
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

    private primaryId(keyPath: string[], key: string): string {
        return `${keyPathHash(keyPath)}::${key}`;
    }

    private secondaryJoinFromSecondaryRow(row: ImmutableProps): string | null {
        const secondaryCollectionKey = this.secondaryCollectionKey;
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
        const secondaryCollectionKey = this.secondaryCollectionKey;
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
        if (existing.joinKeyHash === null) {
            return;
        }
        const ids = this.primaryIdsByJoinKey.get(existing.joinKeyHash);
        if (!ids) {
            return;
        }
        ids.delete(id);
        if (ids.size === 0) {
            this.primaryIdsByJoinKey.delete(existing.joinKeyHash);
        }
    }

    private handlePrimaryJoinKeyPropertyModified(
        keyPath: string[],
        key: string,
        propertyName: string,
        newValue: unknown
    ): void {
        const id = this.primaryId(keyPath, key);
        const record = this.primaryRowsById.get(id);
        if (!record) {
            return;
        }

        const mergedRow = { ...record.immutableProps, [propertyName]: newValue };
        const newJoinHash = this.primaryJoinFromPrimaryRow(mergedRow);
        const oldJoinHash = record.joinKeyHash;

        record.immutableProps = mergedRow;

        if (oldJoinHash === newJoinHash) {
            return;
        }

        const oldEnrichment = this.resolveEnrichmentFromJoinHash(oldJoinHash);
        const newEnrichment = this.resolveEnrichmentFromJoinHash(newJoinHash);

        if (oldJoinHash !== null) {
            const oldSet = this.primaryIdsByJoinKey.get(oldJoinHash);
            if (oldSet) {
                oldSet.delete(id);
                if (oldSet.size === 0) {
                    this.primaryIdsByJoinKey.delete(oldJoinHash);
                }
            }
        }

        if (newJoinHash !== null) {
            record.joinKeyHash = newJoinHash;
            let ids = this.primaryIdsByJoinKey.get(newJoinHash);
            if (!ids) {
                ids = new Set<string>();
                this.primaryIdsByJoinKey.set(newJoinHash, ids);
            }
            ids.add(id);
        } else {
            record.joinKeyHash = null;
        }

        const previous = oldEnrichment ?? this.whenMissing;
        const next = newEnrichment ?? this.whenMissing;
        if (valuesEqual(previous, next)) {
            return;
        }
        this.modifiedHandlers.forEach(handler => {
            handler(record.keyPath, record.primaryKey, previous, next);
        });
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
