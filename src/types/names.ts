/**
 * Names that become properties.
 *
 * A pipeline turns some of the names it is given into properties or arrays of its rows: a
 * group level, an aggregate, a defined or enriched property, a flattened array, a source. The
 * runtime creates exactly the name it is given. So the type can only describe the rows when the
 * name is known when the pipeline is declared: a union would promise one property per member,
 * where the runtime creates one, and `string` would promise every name. A caller that builds
 * names at run time holds the builder untyped, and the descriptor checks it at run time.
 */

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** `unknown` when `S` is exactly one string literal, otherwise `never`. */
export type SingleName<S extends string> =
    string extends S ? never : true extends IsUnion<S> ? never : unknown;

/** `unknown` when `S` is a tuple of single string literals, otherwise `never`. */
export type SingleNames<S extends readonly string[]> =
    number extends S['length']
        ? never
        : S extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
            ? SingleName<Head> & SingleNames<Rest>
            : unknown;
