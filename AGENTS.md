# AGENTS.md

## Reducing Degrees of Freedom

There should be exactly as many places to store data (variables or fields) as there are things that could independently vary in the domain. Any more is redundant complexity; any less fails to satisfy requirements.

When introducing a new field, ask: "What domain variable does this represent that no existing field already captures?" If the answer is "it's derived from other fields" or "it's the same variable in a different shape," it should not exist. Derive it on read instead.

When reviewing existing code, count the data-carrying fields and compare against the number of independently varying domain variables. If fields outnumber variables, look for:

- **Redundant representations:** the same set stored both as an array (for iteration) and as a map (for lookup). Choose one structure that serves both needs, or accept a complementary pair only when they store genuinely different aspects (e.g., order vs. payload).
- **Derived caches:** a field that holds a value computable from other fields. Eliminate it unless recomputation would increase time complexity. Additional constant-time work per cycle is an acceptable tradeoff for removing a redundant field.
- **Temporal duplicates:** two fields holding "current value" and "previous value" of the same variable. Use one field: read it before overwriting to get the old value.
- **Branching duplicates:** parallel data structures that exist only because of a conditional code path (e.g., one store for the mutable case, another for the immutable case). Unify into a single structure that serves both paths.
- **Dead stored data:** fields in a record or object that are written but never read. Remove them.

Balance this with performance. The goal is to minimize fields without increasing the time complexity of the solution. An O(1) lookup in a map you already maintain is free; an O(n) scan to avoid storing one extra field is not.
