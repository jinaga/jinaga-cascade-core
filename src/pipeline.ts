type EmptySources = Record<never, never>;

export type PipelineSources<TSources extends Record<string, unknown>> = {
    [K in keyof TSources]:
        TSources[K] extends { primary: infer TSourcePrimary; sources?: infer TSourceChildren }
            ? PipelineInput<
                TSourcePrimary,
                TSourceChildren extends Record<string, unknown> ? TSourceChildren : EmptySources
            >
            : never;
};

type UntypedSourceGraphShape = {
    [sourceName: string]: {
        primary: unknown;
        sources?: UntypedSourceGraphShape;
    };
};

export type UntypedPipelineSources = PipelineSources<UntypedSourceGraphShape>;

export interface PipelineInput<T, TSources extends Record<string, unknown> = EmptySources> {
    add(key: string, immutableProps: T): void;
    remove(key: string, immutableProps: T): void;
    sources: PipelineSources<TSources>;
}

export interface SourceBindableInput<T, TSources extends Record<string, unknown> = EmptySources>
    extends PipelineInput<T, TSources> {
    setSources(sources: UntypedPipelineSources): void;
}

export interface PipelineRuntimeDiagnostic {
    code:
        | 'operation_after_dispose'
        | 'stale_epoch_operation_dropped'
        | 'missing_parent_add_dropped'
        | 'missing_parent_remove_dropped'
        | 'missing_parent_modify_dropped'
        | 'missing_item_modify_dropped'
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
    operationType?: 'add' | 'remove' | 'modify';
    segmentPath?: string[];
    keyPath?: string[];
    key?: string;
    parentKey?: string;
    epoch?: number;
}

export interface PipelineRuntimeOptions {
    batchSize?: number;
    flushDelayMs?: number;
    onDiagnostic?: (diagnostic: PipelineRuntimeDiagnostic) => void;
}

export interface PipelineRuntimeDisposeOptions {
    flush?: boolean;
}

export interface Pipeline<TStart, TSources extends Record<string, unknown> = EmptySources>
    extends PipelineInput<TStart, TSources> {
    flush(): void;
    dispose(options?: PipelineRuntimeDisposeOptions): void;
    isDisposed(): boolean;
}

export type ScalarType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

export interface ScalarDescriptor {
    name: string;
    type: ScalarType;
}

export interface DescriptorNode {
    arrays: ArrayDescriptor[];
    collectionKey: string[];
    scalars: ScalarDescriptor[];
    /** Presentational object wiring; always an array (empty means none). */
    objects: ObjectDescriptor[];
    /** Property names that may change after add; always an array (empty means none). */
    mutableProperties: string[];
}

export interface TypeDescriptor extends DescriptorNode {
    rootCollectionName: string;
}

export interface ArrayDescriptor {
    name: string;
    type: DescriptorNode;
}

export interface ObjectDescriptor {
    name: string;
    type: DescriptorNode;
}

/**
 * Get the mutable properties of items within an array at the specified path.
 * Navigates through the TypeDescriptor following the segment path and returns
 * the mutableProperties of the final array's item type.
 *
 * @param descriptor - The root TypeDescriptor to start navigation from
 * @param segmentPath - Array of segment names to navigate (e.g., ['orders'] or ['categories', 'products'])
 * @returns Array of mutable property names, or empty array if path is invalid
 */
export function getMutablePropertiesOfArrayItems(
    descriptor: TypeDescriptor,
    segmentPath: string[]
): string[] {
    let current: DescriptorNode = descriptor;
    for (const segment of segmentPath) {
        const arrayDesc = current.arrays.find(a => a.name === segment);
        if (!arrayDesc) return [];
        current = arrayDesc.type;
    }
    return current.mutableProperties;
}

/**
 * Get the scalar descriptors at a specific path within the type descriptor.
 * Navigates through arrays following the segment path and returns scalars
 * at the final node.
 *
 * @param descriptor - The root TypeDescriptor to start navigation from
 * @param segmentPath - Array of segment names (e.g., [] for root, ['items'] for items array)
 * @returns Array of ScalarDescriptor at that path, or empty array if path is invalid
 */
export function getScalarsAtPath(
    descriptor: TypeDescriptor,
    segmentPath: string[]
): ScalarDescriptor[] {
    let current: DescriptorNode = descriptor;
    for (const segment of segmentPath) {
        const arrayDesc = current.arrays.find(a => a.name === segment);
        if (!arrayDesc) return [];
        current = arrayDesc.type;
    }
    return current.scalars;
}

export type ImmutableProps = {
    [key: string]: unknown;
};

export type AddedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

export type RemovedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

export type ModifiedHandler = (keyPath: string[], key: string, oldValue: unknown, newValue: unknown) => void;

export function getPathSegmentsFromDescriptor(descriptor: TypeDescriptor): string[][] {
    // Include the path to the root of the descriptor
    const paths: string[][] = [[]];
    // Recursively get paths from nested type descriptors
    for (const array of descriptor.arrays) {
        const allChildSegments = getPathSegmentsFromNode(array.type);
        for (const childSegments of allChildSegments) {
            paths.push([array.name, ...childSegments]);
        }
    }
    return paths;
}

function getPathSegmentsFromNode(descriptor: DescriptorNode): string[][] {
    const paths: string[][] = [[]];
    for (const array of descriptor.arrays) {
        const allChildSegments = getPathSegmentsFromNode(array.type);
        for (const childSegments of allChildSegments) {
            paths.push([array.name, ...childSegments]);
        }
    }
    return paths;
}

export interface Step {
    onAdded(pathSegments: string[], handler: AddedHandler): void;
    onRemoved(pathSegments: string[], handler: RemovedHandler): void;
    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void;
}

export interface BuiltStepGraph {
    rootInput: SourceBindableInput<unknown, Record<string, unknown>>;
    lastStep: Step;
    sources: UntypedPipelineSources;
}

export interface BuildContext {
    emitDiagnostic?: (diagnostic: {
        code:
            | 'enrich_key_arity_mismatch'
            | 'enrich_invalid_primary_key_property'
            | 'enrich_secondary_collection_key_missing';
        message: string;
    }) => void;
}

export interface StepBuilder {
    readonly upstream?: StepBuilder;
    getTypeDescriptor(): TypeDescriptor;
    buildGraph(ctx: BuildContext): BuiltStepGraph;
}

