import { PipelineBuilder } from './builder.js';
import type {
    AddedHandler,
    BuildContext,
    BuiltStepGraph,
    ImmutableProps,
    PipelineSources,
    RemovedHandler,
    ScalarDescriptor,
    SourceBindableInput,
    Step,
    StepBuilder,
    TypeDescriptor,
    UntypedPipelineSources
} from './pipeline.js';

type EmptySources = Record<never, never>;

function createEmptySources<TSources extends Record<string, unknown>>(): PipelineSources<TSources> {
    return {} as PipelineSources<TSources>;
}

function bindSources<TSources extends Record<string, unknown>>(
    sources: UntypedPipelineSources
): PipelineSources<TSources> {
    return sources as PipelineSources<TSources>;
}

// Kept in factory for createPipeline initialization.
export class InputStep<T, TSources extends Record<string, unknown> = EmptySources>
    implements SourceBindableInput<T, TSources>, Step {
    private addedHandlers: AddedHandler[] = [];
    private removedHandlers: RemovedHandler[] = [];

    sources: PipelineSources<TSources> = createEmptySources<TSources>();

    add(key: string, immutableProps: T): void {
        this.addedHandlers.forEach(handler => handler([], key, immutableProps as ImmutableProps));
    }

    remove(key: string, immutableProps: T): void {
        this.removedHandlers.forEach(handler => handler([], key, immutableProps as ImmutableProps));
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathSegments.length === 0) {
            this.addedHandlers.push(handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathSegments.length === 0) {
            this.removedHandlers.push(handler);
        }
    }

    onModified(
        _pathSegments: string[],
        _propertyName: string,
        _handler: (keyPath: string[], key: string, oldValue: unknown, newValue: unknown) => void
    ): void {
        // No modifications at the input step.
    }

    setSources(sources: UntypedPipelineSources): void {
        this.sources = bindSources<TSources>(sources);
    }
}

export class InputBuilder<TStart> implements StepBuilder {
    readonly upstream = undefined;

    constructor(
        private rootCollectionName: string,
        private sourceScalars: ScalarDescriptor[] = []
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        return {
            rootCollectionName: this.rootCollectionName,
            arrays: [],
            collectionKey: [],
            scalars: this.sourceScalars,
            objects: [],
            mutableProperties: []
        };
    }

    buildGraph(_ctx: BuildContext): BuiltStepGraph {
        const root = new InputStep<TStart>();
        return { rootInput: root, lastStep: root, sources: {} };
    }
}

export function createPipeline<TStart extends object>(): PipelineBuilder<TStart, TStart, [], 'items'>;
export function createPipeline<TStart extends object, TRootScopeName extends string>(
    rootScopeName: TRootScopeName,
    sourceScalars?: ScalarDescriptor[]
): PipelineBuilder<TStart, TStart, [], TRootScopeName>;
/**
 * Create a pipeline builder.
 * Call `.build(setState, runtimeOptions?)` on the returned builder to create
 * an isolated runtime session with explicit lifecycle controls.
 */
export function createPipeline<TStart extends object>(
    rootScopeName: string = 'items',
    sourceScalars: ScalarDescriptor[] = []
): PipelineBuilder<TStart, TStart, [], string, Record<never, never>> {
    const rootBuilder = new InputBuilder<TStart>(rootScopeName, sourceScalars);
    return new PipelineBuilder<TStart, TStart, [], string, Record<never, never>>(rootBuilder, rootBuilder);
}

