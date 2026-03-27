import { PipelineBuilder } from './builder.js';
import type { AddedHandler, ImmutableProps, PipelineInput, PipelineSources, RemovedHandler, Step } from './pipeline.js';
import { type TypeDescriptor, type ScalarDescriptor } from './pipeline.js';

// Private class (not exported)
class InputPipeline<T> implements PipelineInput<T, Record<never, never>>, Step {
    private addedHandlers: AddedHandler[] = [];
    private removedHandlers: RemovedHandler[] = [];
    private rootCollectionName: string;
    private sourceScalars: ScalarDescriptor[];
    readonly sources: PipelineSources<Record<never, never>>;

    constructor(rootCollectionName: string, sourceScalars: ScalarDescriptor[] = []) {
        this.rootCollectionName = rootCollectionName;
        this.sourceScalars = sourceScalars;
        this.sources = {} as PipelineSources<Record<never, never>>;
    }

    getTypeDescriptor(): TypeDescriptor {
        return {
            rootCollectionName: this.rootCollectionName,
            arrays: [],
            collectionKey: [],
            scalars: this.sourceScalars,
            objects: [],
            mutableProperties: []
        }; // No arrays at input level
    }

    add(key: string, immutableProps: T): void {
        this.addedHandlers.forEach(handler => handler([], key, immutableProps as ImmutableProps));
    }

    remove(key: string, immutableProps: T): void {
        this.removedHandlers.forEach(handler => handler([], key, immutableProps as ImmutableProps));
    }

    onAdded(path: string[], handler: (path: string[], key: string, immutableProps: ImmutableProps) => void): void {
        if (path.length === 0) {
            this.addedHandlers.push(handler);
        }
    }

    onRemoved(path: string[], handler: (path: string[], key: string, immutableProps: ImmutableProps) => void): void {
        if (path.length === 0) {
            this.removedHandlers.push(handler);
        }
    }

    onModified(_path: string[], _propertyName: string, _handler: (path: string[], key: string, oldValue: unknown, newValue: unknown) => void): void {
        // No modifications at input level
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
    const start = new InputPipeline<TStart>(rootScopeName, sourceScalars);
    return new PipelineBuilder<TStart, TStart, [], string, Record<never, never>>(start, start);
}

