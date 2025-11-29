import type { AddedHandler, ImmutableProps, RemovedHandler, ModifiedHandler, Step, TypeDescriptor } from '../pipeline';
import { pathsMatch } from '../util/path';

/**
 * A step that filters items based on a predicate function.
 * 
 * This is a STATELESS implementation - no item storage required because:
 * 1. Items are immutable
 * 2. RemovedHandler receives immutableProps
 * 3. Predicate re-evaluation is deterministic
 */
export class FilterStep<T> implements Step {
    constructor(
        private input: Step,
        private predicate: (item: T) => boolean,
        private scopeSegments: string[]
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        return this.input.getTypeDescriptor();
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                if (this.predicate(immutableProps as T)) {
                    handler(keyPath, key, immutableProps);
                }
            });
        } else {
            this.input.onAdded(pathSegments, handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                if (this.predicate(immutableProps as T)) {
                    handler(keyPath, key, immutableProps);
                }
            });
        } else {
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], handler: ModifiedHandler): void {
        this.input.onModified(pathSegments, handler);
    }

    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}