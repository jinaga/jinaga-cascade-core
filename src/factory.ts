import { PipelineBuilder } from './builder.js';
import type {
    AddedHandler,
    ImmutableProps,
    PipelineInput,
    PipelineSources,
    RemovedHandler,
    ScalarDescriptor,
    Step,
    StepBuilder,
    TypeDescriptor
} from './pipeline.js';

type EmptySources = Record<never, never>;

// Kept in factory for createPipeline initialization.
export class InputStep<T, TSources extends Record<string, unknown> = EmptySources>
    implements PipelineInput<T, TSources>, Step {
    private addedHandlers: AddedHandler[] = [];
    private removedHandlers: RemovedHandler[] = [];

    readonly sources: PipelineSources<TSources>;

    constructor(
        private rootCollectionName: string,
        private sourceScalars: ScalarDescriptor[] = []
    ) {
        this.sources = {} as PipelineSources<TSources>;
    }

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

    setSources<TNewSources extends Record<string, unknown>>(sources: PipelineSources<TNewSources>): void {
        (this as unknown as { sources: PipelineSources<TNewSources> }).sources = sources;
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

    buildStep(_input: Step): Step {
        return new InputStep<TStart>(this.rootCollectionName, this.sourceScalars);
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

