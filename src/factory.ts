import { PipelineBuilder } from './builder';
import type { AddedHandler, ImmutableProps, Pipeline, RemovedHandler, Step } from './pipeline';
import { type TypeDescriptor, type ScalarDescriptor } from './pipeline';

// Private class (not exported)
class InputPipeline<T> implements Pipeline<T>, Step {
    private addedHandlers: AddedHandler[] = [];
    private removedHandlers: RemovedHandler[] = [];
    private rootCollectionName: string;
    private sourceScalars: ScalarDescriptor[];

    constructor(rootCollectionName: string, sourceScalars: ScalarDescriptor[] = []) {
        this.rootCollectionName = rootCollectionName;
        this.sourceScalars = sourceScalars;
    }

    getTypeDescriptor(): TypeDescriptor {
        return {
            rootCollectionName: this.rootCollectionName,
            arrays: [],
            collectionKey: [],
            scalars: this.sourceScalars
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

export function createPipeline<TStart extends object>(
    rootScopeName: string = 'items',
    sourceScalars: ScalarDescriptor[] = []
): PipelineBuilder<TStart, TStart> {
    const start = new InputPipeline<TStart>(rootScopeName, sourceScalars);
    return new PipelineBuilder<TStart, TStart>(start, start);
}

