import type {
    AddedHandler,
    BuildContext,
    BuiltStepGraph,
    ImmutableProps,
    ModifiedHandler,
    PlacedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
    TypeDescriptor
} from '../pipeline.js';
import { collectAllMutableProperties, getPathSegmentsFromDescriptor } from '../pipeline.js';
import { pathStartsWith } from '../util/path.js';

interface NodeRecord {
    parentKey: string | undefined;
    /** Complete current values of the node. */
    props: ImmutableProps;
}

interface LevelHandlers {
    added: AddedHandler[];
    removed: RemovedHandler[];
    placed: PlacedHandler[];
    modified: Map<string, ModifiedHandler[]>;
}

function levelId(segmentPath: string[]): string {
    return JSON.stringify(segmentPath);
}

/**
 * Keeps the items at a scope for which the predicate holds, together with their descendants.
 *
 * Visibility is membership: a hidden item and its subtree are not in the output at all. The
 * step therefore keeps the complete current state of every node at or below its scope. When
 * an item becomes visible it is added with its current values, followed by its subtree; when
 * it becomes hidden its subtree is removed, children first. The change that triggered either
 * transition is not forwarded, because the add already carries it.
 */
export class FilterStep<T> implements Step {
    /** The scope and every level below it. */
    private readonly levels: string[][];
    private readonly nodes = new Map<string, Map<string, NodeRecord>>();
    /** Children of each node, by child level and parent key. */
    private readonly children = new Map<string, Map<string, Set<string>>>();
    /** Keys of the scope items for which the predicate holds. */
    private readonly visible = new Set<string>();
    private readonly handlers = new Map<string, LevelHandlers>();
    /** Properties this step listens to upstream, per level. */
    private readonly listened = new Map<string, Set<string>>();

    constructor(
        private input: Step,
        private predicate: (item: T) => boolean,
        private scopeSegments: string[],
        private predicateProperties: string[],
        inputDescriptor: TypeDescriptor
    ) {
        this.levels = getPathSegmentsFromDescriptor(inputDescriptor)
            .filter(path => pathStartsWith(path, this.scopeSegments));
        const mutableProperties = collectAllMutableProperties(inputDescriptor);

        for (const level of this.levels) {
            this.nodes.set(levelId(level), new Map());
            this.children.set(levelId(level), new Map());
            this.handlers.set(levelId(level), { added: [], removed: [], placed: [], modified: new Map() });
            this.input.onAdded(level, (parentKey, key, props) => this.handleAdded(level, parentKey, key, props));
            this.input.onRemoved(level, key => this.handleRemoved(level, key));
            this.input.onPlaced(level, (key, _oldParentKey, newParentKey) => this.handlePlaced(level, key, newParentKey));
            for (const propertyName of new Set([...mutableProperties, ...this.predicateProperties])) {
                this.listen(level, propertyName);
            }
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        const levelHandlers = this.handlers.get(levelId(pathSegments));
        if (levelHandlers) {
            levelHandlers.added.push(handler);
            return;
        }
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        const levelHandlers = this.handlers.get(levelId(pathSegments));
        if (levelHandlers) {
            levelHandlers.removed.push(handler);
            return;
        }
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        const levelHandlers = this.handlers.get(levelId(pathSegments));
        if (levelHandlers) {
            this.listen(pathSegments, propertyName);
            const handlers = levelHandlers.modified.get(propertyName) ?? [];
            handlers.push(handler);
            levelHandlers.modified.set(propertyName, handlers);
            return;
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        const levelHandlers = this.handlers.get(levelId(pathSegments));
        if (levelHandlers) {
            levelHandlers.placed.push(handler);
            return;
        }
        this.input.onPlaced(pathSegments, handler);
    }

    private listen(level: string[], propertyName: string): void {
        const id = levelId(level);
        let names = this.listened.get(id);
        if (!names) {
            names = new Set();
            this.listened.set(id, names);
        }
        if (names.has(propertyName)) {
            return;
        }
        names.add(propertyName);
        this.input.onModified(level, propertyName, (key, _oldValue, newValue) => {
            this.handleModified(level, propertyName, key, newValue);
        });
    }

    private isScope(level: string[]): boolean {
        return level.length === this.scopeSegments.length;
    }

    private childLevels(level: string[]): string[][] {
        return this.levels.filter(other => other.length === level.length + 1 && pathStartsWith(other, level));
    }

    private record(level: string[], key: string): NodeRecord | undefined {
        return this.nodes.get(levelId(level))?.get(key);
    }

    /** A node is visible when its ancestor at the scope passes the predicate. */
    private isVisible(level: string[], key: string | undefined): boolean {
        let currentLevel = level;
        let currentKey = key;
        while (currentLevel.length > this.scopeSegments.length) {
            if (currentKey === undefined) {
                return false;
            }
            currentKey = this.record(currentLevel, currentKey)?.parentKey;
            currentLevel = currentLevel.slice(0, -1);
        }
        return currentKey !== undefined && this.visible.has(currentKey);
    }

    private linkChild(level: string[], parentKey: string | undefined, key: string): void {
        if (this.isScope(level) || parentKey === undefined) {
            return;
        }
        const byParent = this.children.get(levelId(level))!;
        let keys = byParent.get(parentKey);
        if (!keys) {
            keys = new Set();
            byParent.set(parentKey, keys);
        }
        keys.add(key);
    }

    private unlinkChild(level: string[], parentKey: string | undefined, key: string): void {
        if (this.isScope(level) || parentKey === undefined) {
            return;
        }
        const byParent = this.children.get(levelId(level))!;
        const keys = byParent.get(parentKey);
        keys?.delete(key);
        if (keys && keys.size === 0) {
            byParent.delete(parentKey);
        }
    }

    private levelHandlers(level: string[]): LevelHandlers {
        return this.handlers.get(levelId(level))!;
    }

    /** Emits the node and then its subtree, each with current values. */
    private admit(level: string[], key: string): void {
        const record = this.record(level, key);
        if (!record) {
            return;
        }
        this.levelHandlers(level).added.forEach(handler => handler(record.parentKey, key, record.props));
        for (const childLevel of this.childLevels(level)) {
            for (const childKey of this.children.get(levelId(childLevel))!.get(key) ?? []) {
                this.admit(childLevel, childKey);
            }
        }
    }

    /** Removes the node's subtree, children first, and then the node. */
    private evict(level: string[], key: string): void {
        const record = this.record(level, key);
        if (!record) {
            return;
        }
        for (const childLevel of this.childLevels(level)) {
            for (const childKey of this.children.get(levelId(childLevel))!.get(key) ?? []) {
                this.evict(childLevel, childKey);
            }
        }
        this.levelHandlers(level).removed.forEach(handler => handler(key, record.props));
    }

    private handleAdded(level: string[], parentKey: string | undefined, key: string, props: ImmutableProps): void {
        this.nodes.get(levelId(level))!.set(key, { parentKey, props });
        this.linkChild(level, parentKey, key);
        if (this.isScope(level)) {
            if (this.predicate(props as T)) {
                this.visible.add(key);
                this.admit(level, key);
            }
        } else if (this.isVisible(level.slice(0, -1), parentKey)) {
            this.admit(level, key);
        }
    }

    private handleRemoved(level: string[], key: string): void {
        const record = this.record(level, key);
        if (!record) {
            return;
        }
        // Downstream received the node's subtree, so it gets the matching removes, children first.
        if (this.isVisible(level, key)) {
            this.evict(level, key);
        }
        this.unlinkChild(level, record.parentKey, key);
        this.forget(level, key);
    }

    /** Drops a removed node and its subtree, which left the input along with it. */
    private forget(level: string[], key: string): void {
        for (const childLevel of this.childLevels(level)) {
            const byParent = this.children.get(levelId(childLevel))!;
            for (const childKey of byParent.get(key) ?? []) {
                this.forget(childLevel, childKey);
            }
            byParent.delete(key);
        }
        this.nodes.get(levelId(level))!.delete(key);
        if (this.isScope(level)) {
            this.visible.delete(key);
        }
    }

    private handleModified(level: string[], propertyName: string, key: string, newValue: unknown): void {
        const record = this.record(level, key);
        if (!record) {
            return;
        }
        const oldValue = record.props[propertyName];
        record.props = { ...record.props, [propertyName]: newValue };

        if (this.isScope(level) && this.predicateProperties.includes(propertyName)) {
            const wasVisible = this.visible.has(key);
            const isVisible = this.predicate(record.props as T);
            if (!wasVisible && isVisible) {
                this.visible.add(key);
                this.admit(level, key);
                return;
            }
            if (wasVisible && !isVisible) {
                this.evict(level, key);
                this.visible.delete(key);
                return;
            }
        }

        if (this.isVisible(level, key)) {
            this.levelHandlers(level).modified.get(propertyName)?.forEach(handler => handler(key, oldValue, newValue));
        }
    }

    private handlePlaced(level: string[], key: string, newParentKey: string): void {
        const record = this.record(level, key);
        if (!record) {
            return;
        }
        const oldParentKey = record.parentKey;
        if (this.isScope(level)) {
            // Moving a scope item does not change whether it passes.
            record.parentKey = newParentKey;
            if (this.visible.has(key) && oldParentKey !== undefined) {
                this.levelHandlers(level).placed.forEach(handler => handler(key, oldParentKey, newParentKey));
            }
            return;
        }

        const parentLevel = level.slice(0, -1);
        const wasVisible = this.isVisible(parentLevel, oldParentKey);
        const isVisible = this.isVisible(parentLevel, newParentKey);
        if (wasVisible && !isVisible) {
            this.evict(level, key);
        }
        this.unlinkChild(level, oldParentKey, key);
        record.parentKey = newParentKey;
        this.linkChild(level, newParentKey, key);
        if (wasVisible && isVisible && oldParentKey !== undefined) {
            this.levelHandlers(level).placed.forEach(handler => handler(key, oldParentKey, newParentKey));
        } else if (!wasVisible && isVisible) {
            this.admit(level, key);
        }
    }
}

export class FilterBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private predicate: (item: unknown) => boolean,
        private scopeSegments: string[],
        private mutableProperties: string[]
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.upstream.getTypeDescriptor();
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new FilterStep(
                up.lastStep,
                this.predicate,
                this.scopeSegments,
                this.mutableProperties,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}