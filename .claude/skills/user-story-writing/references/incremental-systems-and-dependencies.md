# Building Complex Systems from Incremental User Stories

This reference describes how to decompose large features into incremental user stories, how to manage dependencies between stories, and how to detect and resolve conflicts.

---

## 1. Building Complex Systems Incrementally

### Principles

- **One testable capability per story**: Each story should answer "When this is done, the user can do X and we can verify Y." Avoid stories that require multiple unrelated changes to be testable.
- **Vertical slices over horizontal layers**: Prefer "user can add a data source and see it in the list" over "implement data source repository layer." Each story should deliver something a user (or tester) can see or do.
- **Build on stable foundations**: Early stories should establish data shapes, navigation, and core UI (e.g. "Add Data Source", "Display first three objects"). Later stories add steps, commands, and refinements (e.g. "Group By", "Rename Property").
- **Shared vocabulary**: Use the same terms across stories (preview pane, pipeline steps list, command bar, configuration mode). This makes dependencies and conflicts easier to spot and keeps implementation consistent.

### Sequencing Strategies

1. **By user journey**: Order stories to match the order a user would experience (e.g. add source → see data → add step → configure step → see result).
2. **By dependency**: Implement stories that define contracts first (e.g. "preview shows top-level array"), then stories that use those contracts (e.g. "Rename Property renames the top-level array").
3. **By risk**: Implement high-risk or ambiguous stories earlier so design decisions are validated before many dependent stories are written.
4. **By value**: Deliver the highest user value first within dependency constraints.

### Splitting Large Features

When a feature feels too big for one story:

- **Split by user action**: e.g. "Add Group By step" vs "Configure Group By step" vs "Preview updates after Group By."
- **Split by scope**: e.g. "Top-level array in preview" vs "Rename Property step" (both can live in one doc if tightly coupled, or separate docs).
- **Split by persona or path**: e.g. "Add source via button" vs "Add source via menu" (often combined into one story with multiple ACs).
- **Avoid**: Splitting by technical layer only (e.g. "API for X" then "UI for X") unless the API story is independently testable and valuable.

### References in the Literature

- **Agile / Scrum**: User stories as "vertical slices" of value; INVEST criteria (Independent, Negotiable, Valuable, Estimable, Small, Testable).
- **Behavior-Driven Development (BDD)**: Given/When/Then as the standard for scenarios; acceptance criteria as executable specifications.
- **User Story Mapping** (Jeff Patton): Arrange stories along a user journey; identify "walking skeleton" and then fill in increments.
- **Impact Mapping**: Connect user goals to deliverables and stories; helps prioritize and keep stories aligned to outcomes.

---

## 2. Managing Dependencies

### Types of Dependencies

| Type | Description | How to Document |
|------|-------------|------------------|
| **Prerequisite** | Story B requires Story A to be implemented (or at least its contract). | In B: "Related User Stories: **Story A** – prerequisite." In B's ACs: **Given** clauses that assume A's outcomes. |
| **Extends** | Story B adds to or refines behavior from Story A. | In B: "**Story A** – extends." In A: "**Story B** – extends this story." |
| **Uses** | Story B uses a capability or UI element introduced in A. | In B: "**Story A** – uses (preview pane, command bar)." |
| **Blocks** | Story A must be done before B can be started or tested. | Same as Prerequisite; sometimes called "blocked by A." |
| **Clarifies** | Story B clarifies or replaces part of A (e.g. semantic change). | In B: "**Story A** – clarifies / replaces section X." In A: add note that B updates semantics. |

### Documenting Dependencies in the Story

1. **Related User Stories section**: List each related story with a short relationship label.
   - Example: "**Add Data Source** – prerequisite; pipeline preview assumes a loaded data source."
   - Example: "**Group By Names Parent Level** – clarifies; changes meaning of 'into' parameter from child to parent name."

2. **Given clauses**: Use **Given** to state preconditions that imply prior stories.
   - Example: "**Given** a data source has been loaded" → implies Add Data Source (or equivalent) is done.
   - Example: "**Given** the pipeline has a named top-level array" → implies the story that introduces the top-level array name is done.

3. **Technical Notes**: Call out when implementation depends on another story's output (e.g. "Assumes Rename Property step exists and top-level array is named per rename-property-step.md").

### Resolving Dependency Cycles

- **Merge stories**: If A depends on B and B depends on A, consider merging into one story or a small set that is implemented together.
- **Introduce a third story**: Split so a smaller "contract" story (e.g. "Preview shows a top-level array with a name") is implemented first; both A and B then depend on that.
- **Relax order**: If the dependency is only for full E2E testing, one story can be implemented with mocks or stubs; document the assumption and add a follow-up story for integration.

### Dependency Graph (Conceptual)

When planning, sketch a directed graph: nodes = stories, edges = "depends on." Implement in topological order. If the graph has a cycle, use the resolution strategies above.

---

## 3. Looking for Conflicts

### What Counts as a Conflict

- **Same element, different behavior**: Two stories specify different behavior for the same UI element, flow, or API (e.g. "When user clicks Done, step is removed" vs "When user clicks Done, step is finalized and pipeline runs"). Only one behavior can hold.
- **Same term, different meaning**: Two stories use the same term for different concepts (e.g. "array name" = child array in one story, parent array in another). Leads to ambiguous implementation and broken references.
- **Contradictory acceptance criteria**: Story A's **Then** says "X is shown"; Story B's **Given** or **Then** implies "X is not shown" or "Y is shown instead." Implementation cannot satisfy both.
- **Overlapping scope**: Two stories both specify the same flow or component in detail. Risk of duplicate or conflicting ACs and implementation.

### Conflict Detection Checklist

Before adding or significantly editing a story:

1. **List Related User Stories**: Read each related story's Description and ACs.
2. **Same UI/flow**: Do any of them describe the same screen, button, or sequence? If yes, compare **When**/ **Then** for the same trigger; note any difference.
3. **Terminology**: Do any use the same key term (e.g. "array name", "into", "top-level")? If yes, confirm the meaning is the same.
4. **Given/Then consistency**: For each shared precondition (e.g. "data source loaded"), check that the outcomes in **Then** clauses do not contradict.
5. **Scope**: Is this story the single owner of the behavior for this flow or component? If not, assign ownership or merge.

### Resolution Strategies

| Situation | Strategy |
|-----------|----------|
| Two stories, same flow, different behavior | Choose one as authoritative; update the other to reference it or to narrow its scope. Or merge into one story with alternative paths (AC1 path A, AC2 path B). |
| Same term, different meaning | Align on one meaning; update the later or less central story. Add a short "Terminology" note in the authoritative story or in a shared glossary. |
| Contradictory ACs | Revise one story so its ACs are consistent with the other. If both are needed, split by scenario (e.g. "when no data source" vs "when data source loaded"). |
| Overlapping scope | Designate one story as owner; the other references it ("As per [Story X], …") and only adds ACs for the delta. Or merge overlapping ACs into one story. |

### After Resolving

- Update **Related User Stories** in both stories to note the relationship (e.g. "**Story B** – supersedes AC3 of this story" or "**Story B** – clarifies; 'into' names parent").
- In **Technical Notes**, mention that implementation should follow the authoritative story.
- If a story is deprecated or partially replaced, add a short note at the top: "Partially superseded by [Story X] for [scope]."

---

## 4. Quick Reference

- **Incremental building**: One testable capability per story; vertical slices; order by journey and dependency; split by user action or scope.
- **Dependencies**: Document in Related User Stories and Given clauses; resolve cycles by merging or introducing a contract story.
- **Conflicts**: Check same element/behavior, same term/meaning, contradictory ACs, overlapping scope; resolve by assigning ownership, aligning terminology, or merging/splitting stories.
