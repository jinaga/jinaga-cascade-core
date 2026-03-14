import { PipelineBuilder } from './builder';
import type { AddedHandler, ImmutableProps, Pipeline, RemovedHandler, Step } from './pipeline';
import { type TypeDescriptor } from './pipeline';

// Private class (not exported)
class InputPipeline<T> implements Pipeline<T>, Step {
    private addedHandlers: AddedHandler[] = [];
    private removedHandlers: RemovedHandler[] = [];

    getTypeDescriptor(): TypeDescriptor {
        return { arrays: [] }; // No arrays at input level
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

    /**
     * Optional root collection name used by groupBy when parent-level naming
     * semantics are enabled by desktop pipeline runner.
     */
    __rootScopeName?: string;
}

export function createPipeline<TStart extends object>(rootScopeName?: string): PipelineBuilder<TStart, TStart> {
    const start = new InputPipeline<TStart>();
    start.__rootScopeName = rootScopeName;
    return new PipelineBuilder<TStart, TStart>(start, start);
}

