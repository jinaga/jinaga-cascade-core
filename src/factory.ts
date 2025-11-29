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

    onModified(path: string[], handler: (path: string[], key: string, name: string, value: any) => void): void {
        // No modifications at input level
    }
}

export function createPipeline<TStart extends {}>(): PipelineBuilder<TStart, TStart> {
    const start = new InputPipeline<TStart>();
    return new PipelineBuilder<TStart, TStart>(start, start);
}

